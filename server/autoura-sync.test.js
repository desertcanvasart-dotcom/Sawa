// Unit tests for the departure-mirror payload builder. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeparturePayload } from "./autoura-sync.js";

const dep = {
  id: 1037, route: "Giza Pyramids day tour", type: "day_tour",
  date: "2026-10-07", startDate: null, endDate: null, time: "09:00", city: "Cairo",
  minSeats: 4, maxSeats: 12, status: "open", livePrice: 52, publishedRate: 80,
  pledges: [{ seats: 2 }, { seats: 1, status: "cancelled" }],
};

test("buildDeparturePayload: snapshot shape and live seat count", () => {
  const p = buildDeparturePayload(dep);
  assert.equal(p.event, "departure.sync");
  assert.equal(p.brand, "sawa-tours");
  assert.equal(p.departure.externalId, "1037");
  assert.equal(p.departure.date, "2026-10-07");
  assert.equal(p.departure.seatsTaken, 2); // cancelled pledge excluded
  assert.equal(p.departure.status, "open");
  assert.equal(p.departure.priceFrom, 52);
});

test("buildDeparturePayload: packages use startDate and carry endDate", () => {
  const p = buildDeparturePayload({ ...dep, type: "package", startDate: "2026-11-01", endDate: "2026-11-05" });
  assert.equal(p.departure.date, "2026-11-01");
  assert.equal(p.departure.endDate, "2026-11-05");
});

test("buildDeparturePayload: pending_review is never mirrored", () => {
  assert.equal(buildDeparturePayload({ ...dep, status: "pending_review" }), null);
  assert.equal(buildDeparturePayload(null), null);
});
