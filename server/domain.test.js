// Unit tests for money-critical + booking-rule domain logic. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPackage, goAheadSeatsFor, defaultDepositFor, seatsTotal, livePriceFor,
  statusFor, packagePriceFor, balanceDueDate, computePledgePricing, enrichDeparture,
  bookingClosed,
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
test("bookingClosed: open well before cutoff, closed inside it", () => {
  const dep = { date: "2026-07-10", time: "08:00", startDate: null };
  const product = { bookingCutoffHours: 24 };
  // 5 days before -> open
  assert.equal(bookingClosed(dep, product, new Date("2026-07-05T08:00:00").getTime()), false);
  // 2 hours before start, cutoff 24h -> closed
  assert.equal(bookingClosed(dep, product, new Date("2026-07-10T06:00:00").getTime()), true);
  // exactly at the 24h deadline boundary - 1 min -> open
  assert.equal(bookingClosed(dep, product, new Date("2026-07-09T07:59:00").getTime()), false);
});
test("bookingClosed: zero cutoff allows up to start", () => {
  const dep = { date: "2026-07-10", time: "08:00" };
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 0 }, new Date("2026-07-10T07:00:00").getTime()), false);
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 0 }, new Date("2026-07-10T09:00:00").getTime()), true);
});
test("bookingClosed: package uses startDate", () => {
  const dep = { startDate: "2026-08-01", endDate: "2026-08-04", time: "09:00" };
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 48 }, new Date("2026-07-20T00:00:00").getTime()), false);
  assert.equal(bookingClosed(dep, { bookingCutoffHours: 48 }, new Date("2026-07-31T00:00:00").getTime()), true);
});
