// Unit tests for money-critical + booking-rule domain logic. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPackage, goAheadSeatsFor, defaultDepositFor, seatsTotal, livePriceFor,
  statusFor, packagePriceFor, balanceDueDate, computePledgePricing, enrichDeparture,
  bookingClosed, departureStarted,
} from "./domain.js";

const dayTour = {
  type: "day_tour", minSeats: 4, maxSeats: 10,
  publishedRate: 75, breakPrice: 58, depositPercent: 10, date: "2026-07-10", time: "08:30",
  pledges: [],
};
const pkg = {
  type: "package", minSeats: 4, maxSeats: 12,
  publishedRate: 540, breakPrice: 460, depositPercent: 20,
  startDate: "2026-08-01", date: "2026-08-01",
  accommodationTiers: [
    { id: "standard", name: "Standard", perPersonSupplement: 0, singleSupplement: 90 },
    { id: "superior", name: "Superior", perPersonSupplement: 120, singleSupplement: 160 },
  ],
  pledges: [],
};

test("isPackage discriminates by type", () => {
  assert.equal(isPackage(pkg), true);
  assert.equal(isPackage(dayTour), false);
});
test("goAheadSeatsFor uses minSeats", () => {
  assert.equal(goAheadSeatsFor(dayTour), 4);
  assert.equal(goAheadSeatsFor({ minSeats: 8 }), 8);
  assert.equal(goAheadSeatsFor({}), 4);
});
test("defaultDepositFor: 10% day tour, 20% package", () => {
  assert.equal(defaultDepositFor(dayTour), 10);
  assert.equal(defaultDepositFor(pkg), 20);
});
test("seatsTotal sums pledge seats", () => {
  assert.equal(seatsTotal([{ seats: 2 }, { seats: 3 }]), 5);
  assert.equal(seatsTotal([]), 0);
});
test("seatsTotal excludes cancelled pledges", () => {
  // A cancelled booking has released its seats. Counting it would overstate
  // capacity AND quote a cheaper live price than the server then charges, so
  // every seat count — server or client — has to honour this.
  assert.equal(seatsTotal([{ seats: 2 }, { seats: 3, status: "cancelled" }]), 2);
  assert.equal(seatsTotal([{ seats: 4, status: "cancelled" }]), 0);
  assert.equal(seatsTotal([{ seats: 2, status: "confirmed" }, { seats: 1, status: "paid" }]), 3);
});
test("cancelled pledges don't move the live price or the go-ahead status", () => {
  const withCancelled = [{ seats: 3 }, { seats: 6, status: "cancelled" }];
  assert.equal(livePriceFor(dayTour, seatsTotal(withCancelled)), livePriceFor(dayTour, 3));
  assert.equal(statusFor({ ...dayTour, status: "open" }, withCancelled), "open");
});
test("livePriceFor: published at min, break at max, monotonic, bounded", () => {
  assert.equal(livePriceFor(dayTour, 4), 75);
  assert.equal(livePriceFor(dayTour, 10), 58);
  const mid = livePriceFor(dayTour, 7);
  assert.ok(mid < 75 && mid > 58);
  for (let s = 0; s <= 14; s++) {
    const p = livePriceFor(dayTour, s);
    assert.ok(p >= 58 && p <= 75);
  }
});
test("statusFor: open below min, minimum_reached at/above, terminal preserved", () => {
  assert.equal(statusFor({ ...dayTour, status: "open" }, [{ seats: 3 }]), "open");
  assert.equal(statusFor({ ...dayTour, status: "open" }, [{ seats: 4 }]), "minimum_reached");
  assert.equal(statusFor({ ...dayTour, status: "supplier_confirmed" }, [{ seats: 1 }]), "supplier_confirmed");
  assert.equal(statusFor({ ...dayTour, status: "cancelled" }, [{ seats: 9 }]), "cancelled");
});
test("statusFor: pending_review never auto-advances from pledge counts", () => {
  // Traveler-requested departures (addendum Phase A) stay pending until an
  // admin approves them — even when the seed pledge already meets go-ahead.
  assert.equal(statusFor({ ...dayTour, status: "pending_review" }, [{ seats: 1 }]), "pending_review");
  assert.equal(statusFor({ ...dayTour, status: "pending_review" }, [{ seats: 6 }]), "pending_review");
});
test("packagePriceFor: base + tier + single supplement", () => {
  assert.equal(packagePriceFor(pkg, pkg, 4, { roomingType: "double", tierId: "superior" }), 660);
  assert.equal(packagePriceFor(pkg, pkg, 4, { roomingType: "single", tierId: "superior" }), 820);
  assert.equal(packagePriceFor(pkg, pkg, 4, { roomingType: "double", tierId: "standard" }), 540);
});
test("balanceDueDate is the day before", () => {
  assert.equal(balanceDueDate("2026-07-10"), "2026-07-09");
  assert.equal(balanceDueDate("2026-01-01"), "2025-12-31");
  assert.equal(balanceDueDate("2026-03-01"), "2026-02-28"); // non-leap year
  assert.equal(balanceDueDate("2028-03-01"), "2028-02-29"); // leap year
});
test("balanceDueDate does not shift with the host timezone", () => {
  // Regression: local-noon arithmetic read back through toISOString() (UTC) put
  // the balance a day early at offsets beyond +12 — and the frontend runs this
  // in the VIEWER's timezone, so travellers in NZ/Fiji/Samoa saw the wrong date.
  const previous = process.env.TZ;
  try {
    for (const tz of ["Africa/Cairo", "UTC", "America/Los_Angeles", "Pacific/Auckland", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      assert.equal(balanceDueDate("2026-01-01"), "2025-12-31", `shifted under TZ=${tz}`);
      assert.equal(balanceDueDate("2026-07-10"), "2026-07-09", `shifted under TZ=${tz}`);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
test("computePledgePricing day tour: total + 10% deposit", () => {
  const p = computePledgePricing({ ...dayTour }, null, { seats: 4 });
  assert.equal(p.pricePerPerson, 75);
  assert.equal(p.bookingTotal, 300);
  assert.equal(p.depositDue, 30);
  assert.equal(p.balanceDue, 270);
});
test("computePledgePricing package: tier+single + 20% deposit", () => {
  const p = computePledgePricing({ ...pkg }, pkg, { seats: 2, roomingType: "single", accommodationTier: "superior" });
  assert.equal(p.pricePerPerson, 820);
  assert.equal(p.bookingTotal, 1640);
  assert.equal(p.depositDue, 328);
  assert.equal(p.balanceDue, 1312);
});
test("enrichDeparture adds livePrice + computed status", () => {
  const e = enrichDeparture({ ...dayTour, status: "open", pledges: [{ seats: 4 }] });
  assert.equal(e.livePrice, 75);
  assert.equal(e.status, "minimum_reached");
});
test("capacity boundary: max seats -> break price", () => {
  assert.equal(livePriceFor(dayTour, dayTour.maxSeats), dayTour.breakPrice);
});

// ---- Phase B: booking cutoff ----
// These use explicit ...Z instants. The previous versions built `nowMs` with
// `new Date("2026-07-10T06:00:00")` — the SAME machine-local parse the function
// itself used, so they stayed self-consistent in any timezone and proved
// nothing about when the cutoff actually fires.
test("bookingClosed: open well before cutoff, closed inside it", () => {
  const dep = { date: "2026-07-10", time: "08:00", startDate: null };
  const product = { bookingCutoffHours: 24 };
  // 08:00 Cairo on 2026-07-10 is 05:00Z (EEST, UTC+3); deadline is 2026-07-09T05:00Z.
  assert.equal(bookingClosed(dep, product, Date.parse("2026-07-05T08:00:00Z")), false);
  assert.equal(bookingClosed(dep, product, Date.parse("2026-07-09T04:59:00Z")), false);
  assert.equal(bookingClosed(dep, product, Date.parse("2026-07-09T05:01:00Z")), true);
  assert.equal(bookingClosed(dep, product, Date.parse("2026-07-10T03:00:00Z")), true);
});
test("bookingClosed: the cutoff is Egyptian local time, not the server's", () => {
  // Regression: resolving the departure in the host's timezone made a UTC server
  // (Railway's default) close bookings 3 hours late — 21h before an 08:00 Cairo
  // departure under a 24h rule, inside the window reserved for the guide/vehicle.
  const dep = { date: "2026-07-10", time: "08:00" };
  const product = { bookingCutoffHours: 24 };
  const justClosed = Date.parse("2026-07-09T05:01:00Z");
  const stillOpen = Date.parse("2026-07-09T04:59:00Z");
  const previous = process.env.TZ;
  try {
    for (const tz of ["Africa/Cairo", "UTC", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      assert.equal(bookingClosed(dep, product, justClosed), true, `should be closed under TZ=${tz}`);
      assert.equal(bookingClosed(dep, product, stillOpen), false, `should be open under TZ=${tz}`);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});
test("bookingClosed: winter departures use EET (+2), not a hardcoded offset", () => {
  // Egypt reinstated DST in 2023, so the offset is +2 in January and +3 in July.
  const dep = { date: "2026-01-15", time: "08:00" };
  const product = { bookingCutoffHours: 24 };
  // 08:00 Cairo in winter is 06:00Z; deadline 2026-01-14T06:00Z.
  assert.equal(bookingClosed(dep, product, Date.parse("2026-01-14T05:59:00Z")), false);
  assert.equal(bookingClosed(dep, product, Date.parse("2026-01-14T06:01:00Z")), true);
});
test("bookingClosed: zero cutoff allows up to start", () => {
  const dep = { date: "2026-07-10", time: "08:00" };
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 0 }, Date.parse("2026-07-10T04:00:00Z")), false);
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 0 }, Date.parse("2026-07-10T06:00:00Z")), true);
});
test("bookingClosed: package uses startDate", () => {
  const dep = { startDate: "2026-08-01", endDate: "2026-08-04", time: "09:00" };
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 48 }, Date.parse("2026-07-20T00:00:00Z")), false);
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 48 }, Date.parse("2026-07-31T00:00:00Z")), true);
});
test("bookingClosed: a malformed stored time falls back instead of failing open", () => {
  // departures.time is free text and nothing validates it on write. An
  // unparseable value used to build an invalid Date, and the NaN comparison
  // returned false — bookings for that departure never closed at all.
  const product = { bookingCutoffHours: 24 };
  const wellPastAnyCutoff = Date.parse("2026-07-10T12:00:00Z");
  for (const time of ["08:00:00", "8:00", "", null, undefined, "junk", "25:61"]) {
    assert.equal(bookingClosed({ date: "2026-07-10", time }, product, wellPastAnyCutoff), true, `time=${time}`);
  }
});

// --- departureStarted: expiring past dates off the public catalogue ---------
test("departureStarted: false before the start instant, true after", () => {
  const dep = { date: "2026-07-10", time: "08:00" };
  // 08:00 Cairo in July (EEST, UTC+3) is 05:00Z.
  assert.equal(departureStarted(dep, Date.parse("2026-07-10T04:59:00Z")), false);
  assert.equal(departureStarted(dep, Date.parse("2026-07-10T05:01:00Z")), true);
});
test("departureStarted: a package expires on its start date, not its end date", () => {
  const dep = { startDate: "2026-08-01", endDate: "2026-08-04", date: "2026-08-01", time: "09:00" };
  assert.equal(departureStarted(dep, Date.parse("2026-07-31T23:00:00Z")), false);
  // Once it has left, nobody can join it — even though it runs for three more days.
  assert.equal(departureStarted(dep, Date.parse("2026-08-02T00:00:00Z")), true);
});
test("departureStarted: a malformed row stays visible rather than vanishing", () => {
  // A bad date is an ops problem. Hiding the departure would silently remove
  // sellable inventory with nothing to show anyone why.
  assert.equal(departureStarted({ date: "not-a-date", time: "08:00" }, Date.now()), false);
  assert.equal(departureStarted({ time: "08:00" }, Date.now()), false);
});
test("departureStarted: an unparseable time falls back to 08:00 rather than never expiring", () => {
  // Same trap bookingClosed had: NaN comparisons are false, so a junk time
  // would have kept an expired departure on the board forever.
  for (const time of ["junk", "", null, undefined, "25:61"]) {
    assert.equal(departureStarted({ date: "2026-07-10", time }, Date.parse("2026-07-11T00:00:00Z")), true, `time=${time}`);
  }
});
