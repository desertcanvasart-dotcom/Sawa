// Unit tests for the departure-mirror payload builder. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeparturePayload } from "./autoura-sync.js";

// Y2.1 — the builder takes INVENTORY now, with seatsTaken already counted. It
// used to take the enriched departure and call seatsTotal() on its pledges; the
// counting moved to loadInventory(), which selects only `status, seats` so the
// personal columns never leave the database. The cancelled-pledge rule is
// unchanged and is covered by seatsTotal's own tests in domain.test.js.
const dep = {
  id: 1037, route: "Giza Pyramids day tour", type: "day_tour",
  date: "2026-10-07", startDate: null, endDate: null, time: "09:00", city: "Cairo",
  minSeats: 4, maxSeats: 12, status: "open", livePrice: 52, publishedRate: 80,
  seatsTaken: 2,
};

test("buildDeparturePayload: snapshot shape and live seat count", () => {
  const p = buildDeparturePayload(dep);
  assert.equal(p.event, "departure.sync");
  assert.equal(p.brand, "sawa-tours");
  assert.equal(p.departure.externalId, "1037");
  assert.equal(p.departure.date, "2026-10-07");
  assert.equal(p.departure.seatsTaken, 2);
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

// X3.3 / Y2 — data egress. If AUTOURA_SYNC_URL and AUTOURA_SYNC_SECRET are set,
// every departure write is mirrored to an external system. Common ownership does
// not make two systems one system, so what crosses that boundary matters.
//
// The builder used to receive the enriched departure — pledges and all, carrying
// names, emails, phones and booking codes — and read one integer off it. Y2.1
// narrowed the interface: it now receives inventory with seatsTaken already
// counted, and loadInventory() selects only `status, seats` from pledges, so the
// personal columns never leave Postgres.
//
// That makes the leak structurally impossible rather than merely detected. This
// test is the second line, not the only one.
test("the Autoura payload carries no traveller personal data", () => {
  const inventory = {
    id: 42, status: "open", route: "Aswan Highlights", type: "day_tour",
    date: "2026-09-01", time: "08:00", city: "Aswan",
    minSeats: 4, maxSeats: 12, publishedRate: 49, seatsTaken: 2,
  };
  const sent = buildDeparturePayload(inventory);
  assert.equal(sent.departure.seatsTaken, 2);
  assert.deepEqual(Object.keys(sent.departure).sort(), [
    "city", "currency", "date", "endDate", "externalId", "maxSeats", "minSeats",
    "priceFrom", "route", "seatsTaken", "status", "time", "type",
  ], "the field list is pinned — adding one is a deliberate act, not an accident");
});

test("even if pledge rows are handed back in, nothing personal reaches the wire", () => {
  // The adversarial case: someone widens the call site again, or passes the
  // enriched departure by mistake. The builder must ignore anything it was not
  // asked for.
  const widened = {
    id: 42, status: "open", route: "Aswan Highlights", type: "day_tour",
    date: "2026-09-01", city: "Aswan", minSeats: 4, maxSeats: 12,
    publishedRate: 49, seatsTaken: 2,
    pledges: [
      { seats: 2, status: "confirmed", customers: "Mariam Hassan",
        customerEmail: "mariam@example.com", customerPhone: "+20 100 000 0000",
        bookingCode: "SAWA-ABCDE", agency: "An Operator" },
    ],
  };
  const wire = JSON.stringify(buildDeparturePayload(widened));
  for (const secret of ["Mariam", "mariam@example.com", "+20 100 000 0000",
                        "SAWA-ABCDE", "An Operator", "pledges"]) {
    assert.ok(!wire.includes(secret), `personal data crossed the boundary: ${secret}`);
  }
  assert.equal(JSON.parse(wire).departure.seatsTaken, 2, "and the count still comes from the caller");
});

test("a pending_review departure is never mirrored", () => {
  assert.equal(buildDeparturePayload({ id: 1, status: "pending_review", seatsTaken: 0 }), null);
});
