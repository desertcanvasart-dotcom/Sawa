// Unit tests for money-critical + booking-rule domain logic. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPackage, goAheadSeatsFor, defaultDepositFor, seatsTotal, livePriceFor,
  statusFor, packagePriceFor, balanceDueDate, computePledgePricing, enrichDeparture,
  bookingClosed, departureStarted,
  confirmDeadlineDaysFor, confirmDeadlineAt, missedConfirmDeadline,
  priceFromTiers, validatePriceTiers, withPriceTiers,
  capacityError, MAX_GROUP_SIZE,
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

// --- the GoAhead deadline -----------------------------------------------
// The booking conditions promise a date is cancelled if it misses its minimum
// by a deadline. These pin down which dates that rule may touch, because the
// cost of a false positive is destroying real inventory.

test("confirmDeadlineDaysFor: 30 for packages, 7 for day tours", () => {
  assert.equal(confirmDeadlineDaysFor(null, pkg), 30);
  assert.equal(confirmDeadlineDaysFor(null, dayTour), 7);
  assert.equal(confirmDeadlineDaysFor({}, pkg), 30);
});
test("confirmDeadlineDaysFor: a per-listing value overrides the type default", () => {
  assert.equal(confirmDeadlineDaysFor({ confirmDeadlineDays: 14 }, pkg), 14);
  // 0 is a legitimate override — "accept bookings right up to departure".
  assert.equal(confirmDeadlineDaysFor({ confirmDeadlineDays: 0 }, dayTour), 0);
  // Junk falls back rather than producing a nonsense deadline.
  for (const bad of [null, undefined, -3, "soon", NaN]) {
    assert.equal(confirmDeadlineDaysFor({ confirmDeadlineDays: bad }, dayTour), 7, `bad=${bad}`);
  }
});
test("confirmDeadlineAt is measured from the departure's own start time", () => {
  // 08:00 Cairo on 2026-07-10 is 05:00Z; 7 days earlier is 2026-07-03T05:00Z.
  const at = confirmDeadlineAt({ date: "2026-07-10", time: "08:00" }, null);
  assert.equal(new Date(at).toISOString(), "2026-07-03T05:00:00.000Z");
});
test("missedConfirmDeadline: fires only after the deadline, and only under the minimum", () => {
  const dep = { status: "open", date: "2026-07-10", time: "08:00", minSeats: 4, pledges: [{ seats: 2 }] };
  assert.equal(missedConfirmDeadline(dep, null, Date.parse("2026-07-03T04:59:00Z")), false);
  assert.equal(missedConfirmDeadline(dep, null, Date.parse("2026-07-03T05:01:00Z")), true);
});
test("missedConfirmDeadline: never touches a date that reached its minimum", () => {
  // Belt and braces — such a date is already 'minimum_reached', but a stale
  // status must not be enough to cancel a trip people are travelling on.
  const full = { status: "open", date: "2026-07-10", time: "08:00", minSeats: 4, pledges: [{ seats: 4 }] };
  assert.equal(missedConfirmDeadline(full, null, Date.parse("2026-07-09T00:00:00Z")), false);
});
test("missedConfirmDeadline: leaves every non-open status alone", () => {
  const base = { date: "2026-07-10", time: "08:00", minSeats: 4, pledges: [{ seats: 1 }] };
  const wellPast = Date.parse("2026-07-09T00:00:00Z");
  for (const status of ["pending_review", "minimum_reached", "supplier_confirmed", "closed", "cancelled"]) {
    assert.equal(missedConfirmDeadline({ ...base, status }, null, wellPast), false, status);
  }
});
test("missedConfirmDeadline: a malformed date cancels nothing", () => {
  // Cancelling on a parse failure would destroy sellable inventory over bad data.
  const bad = { status: "open", date: "not-a-date", time: "08:00", minSeats: 4, pledges: [] };
  assert.equal(missedConfirmDeadline(bad, null, Date.now()), false);
  assert.equal(missedConfirmDeadline({ status: "open", minSeats: 4, pledges: [] }, null, Date.now()), false);
});
test("missedConfirmDeadline: a package uses its start date and the 30-day window", () => {
  const dep = { status: "open", type: "package", startDate: "2026-08-01", date: "2026-08-01",
                time: "09:00", minSeats: 4, pledges: [{ seats: 3 }] };
  // 09:00 Cairo on 2026-08-01 is 06:00Z; 30 days earlier is 2026-07-02T06:00Z.
  assert.equal(missedConfirmDeadline(dep, null, Date.parse("2026-07-02T05:59:00Z")), false);
  assert.equal(missedConfirmDeadline(dep, null, Date.parse("2026-07-02T06:01:00Z")), true);
});

// --- per-headcount price table -------------------------------------------
// An optional override for the published/break interpolation. The server
// charges what livePriceFor returns, so a wrong table is a wrong invoice.

const tiered = { ...dayTour, minSeats: 4, maxSeats: 12,
  priceTiers: [{ seats: 4, price: 110 }, { seats: 7, price: 85 }, { seats: 10, price: 60 }] };

test("priceFromTiers: the last breakpoint at or below the headcount applies", () => {
  const t = tiered.priceTiers;
  assert.equal(priceFromTiers(t, 4), 110);
  assert.equal(priceFromTiers(t, 6), 110); // still in the 4-6 band
  assert.equal(priceFromTiers(t, 7), 85);  // band changes exactly on the breakpoint
  assert.equal(priceFromTiers(t, 9), 85);
  assert.equal(priceFromTiers(t, 10), 60);
  assert.equal(priceFromTiers(t, 99), 60);
});
test("priceFromTiers: unsorted input is sorted, not trusted", () => {
  const jumbled = [{ seats: 10, price: 60 }, { seats: 4, price: 110 }, { seats: 7, price: 85 }];
  assert.equal(priceFromTiers(jumbled, 8), 85);
});
test("priceFromTiers: returns null when there is nothing usable, so pricing falls back", () => {
  for (const t of [null, undefined, [], "nope", [{}], [{ seats: 0, price: 5 }], [{ seats: 4, price: 0 }]]) {
    assert.equal(priceFromTiers(t, 6), null, JSON.stringify(t));
  }
});
test("livePriceFor: a table overrides the interpolation", () => {
  assert.equal(livePriceFor(tiered, 5), 110);
  assert.equal(livePriceFor(tiered, 8), 85);
  // Without the table the same item would interpolate 75 -> 58.
  const { priceTiers, ...noTable } = tiered;
  assert.notEqual(livePriceFor(noTable, 8), 85);
});
test("livePriceFor: a table is clamped to capacity like the curve is", () => {
  // A party larger than the tour pays the largest band, not something invented.
  assert.equal(livePriceFor(tiered, 40), 60);
  // Below the minimum, the minimum's price — nobody pays less than the GoAhead rate.
  assert.equal(livePriceFor(tiered, 1), 110);
});
test("livePriceFor: an unusable table falls back rather than throwing", () => {
  assert.equal(livePriceFor({ ...dayTour, priceTiers: [{ seats: "x", price: "y" }] }, 4), 75);
});

const bounds = { minSeats: 4, maxSeats: 12 };
test("validatePriceTiers: accepts a good table and normalises it", () => {
  const r = validatePriceTiers([{ seats: 7, price: 85.4 }, { seats: 4, price: 110 }], bounds);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tiers, [{ seats: 4, price: 110 }, { seats: 7, price: 85 }]);
});
test("validatePriceTiers: empty means 'no table', not an error", () => {
  assert.deepEqual(validatePriceTiers(null, bounds), { tiers: null });
  assert.deepEqual(validatePriceTiers([], bounds), { tiers: null });
});
test("validatePriceTiers: rejects a price that rises as the group grows", () => {
  // This would contradict the promise made on every page of the site.
  const r = validatePriceTiers([{ seats: 4, price: 80 }, { seats: 6, price: 90 }], bounds);
  assert.match(r.error, /must never go up/);
});
test("validatePriceTiers: requires a row at the minimum group size", () => {
  // Otherwise the very first booking silently pays a larger group's rate.
  const r = validatePriceTiers([{ seats: 6, price: 90 }], bounds);
  assert.match(r.error, /must start at 4/);
});
test("validatePriceTiers: rejects out-of-range, duplicate, and non-numeric rows", () => {
  assert.match(validatePriceTiers([{ seats: 4, price: 90 }, { seats: 99, price: 50 }], bounds).error, /outside/);
  assert.match(validatePriceTiers([{ seats: 4, price: 90 }, { seats: 4, price: 80 }], bounds).error, /twice/);
  assert.match(validatePriceTiers([{ seats: 4.5, price: 90 }], bounds).error, /whole number/);
  assert.match(validatePriceTiers([{ seats: 4, price: -5 }], bounds).error, /greater than zero/);
  assert.match(validatePriceTiers({ seats: 4 }, bounds).error, /list of/);
});
test("withPriceTiers: carries a listing's table onto its departure, and is a no-op without one", () => {
  const dep = { id: 1, publishedRate: 75 };
  assert.deepEqual(withPriceTiers(dep, { priceTiers: [{ seats: 4, price: 9 }] }).priceTiers, [{ seats: 4, price: 9 }]);
  assert.equal(withPriceTiers(dep, null), dep);
  assert.equal(withPriceTiers(dep, { priceTiers: null }), dep);
});
test("computePledgePricing honours the table end to end", () => {
  // The seam that matters: what the traveller is actually invoiced.
  const dep = { ...dayTour, minSeats: 4, maxSeats: 12, depositPercent: 10, pledges: [{ seats: 6 }] };
  const product = { priceTiers: tiered.priceTiers };
  const p = computePledgePricing(dep, product, { seats: 2 });
  // 6 already booked + 2 = 8 projected -> the 7+ band, $85.
  assert.equal(p.pricePerPerson, 85);
  assert.equal(p.bookingTotal, 170);
});

// --- the 12-traveller cap -------------------------------------------------
// "Every Sawa departure runs with a minimum of 4 and a maximum of 12
// travelers" is a term of the booking conditions, so nothing may publish past
// it. The DB carries the same rule as a constraint; this is the layer that
// explains why in words an operator can act on.

test("capacityError: accepts everything within the stated range", () => {
  assert.equal(capacityError(4, 12), null);
  assert.equal(capacityError(4, 4), null);
  assert.equal(capacityError(2, 8), null);
  assert.equal(MAX_GROUP_SIZE, 12);
});
test("capacityError: refuses a group larger than the contract allows", () => {
  const e = capacityError(4, 13);
  assert.match(e, /Maximum group size is 12/);
  assert.match(e, /booking conditions/);
  assert.match(capacityError(4, 200), /Maximum group size is 12/);
});
test("capacityError: refuses a maximum below the minimum", () => {
  assert.match(capacityError(8, 4), /cannot be below the minimum/);
});
test("capacityError: refuses non-integers and nonsense", () => {
  for (const [min, max] of [[4, 4.5], ["x", 8], [4, 0], [0, 8], [4, null], [4, undefined]]) {
    assert.ok(capacityError(min, max), `expected an error for ${min}/${max}`);
  }
});
