// PP3 — "Departures needing action" must not send ops after a departure that
// does not exist.
//
// The loop had no status guard. A cancelled or closed date was counted as
// `open`, or as `readyToConfirm` if it still held seats, and `atRisk` flagged
// any cancelled date starting within a fortnight — putting it at the top of the
// panel titled "needing action", which is the one place a wrong row costs
// somebody's afternoon rather than a pixel.
//
// Independent of KK1: fixing pledge status does not fix this, because the bug is
// in how the DEPARTURE's own status is read, or rather was not read at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { departureActionBuckets, AT_RISK_DAYS } from "./domain.js";

const NOW = Date.parse("2026-08-09T00:00:00Z");
const soon = "2026-08-15";   // 6 days out — inside the at-risk window
const later = "2026-09-30";  // well outside it

const buckets = (rows, seats = {}) =>
  departureActionBuckets(rows, (id) => seats[id] ?? 0, NOW);

test("a cancelled date is not counted anywhere, least of all as at risk", () => {
  // The exact row that used to appear at the top of "needing action": cancelled,
  // starting within the fortnight, still holding its seats because nothing
  // transitions them (KK1).
  const b = buckets(
    [{ id: 1, status: "cancelled", min_seats: 4, start_date: soon }],
    { 1: 4 }
  );
  assert.equal(b.atRisk, 0, "ops would be sent to chase a cancelled departure");
  assert.equal(b.open, 0);
  assert.equal(b.readyToConfirm, 0, "its seats still meet the minimum — that must not make it 'ready'");
  assert.equal(b.confirmed, 0);
  assert.equal(b.excluded, 1);
});

test("the old logic really would have flagged it — this is not a strawman", () => {
  // W3. The previous expression is reproduced and asserted to disagree, so a
  // revert fails with an explanation rather than a bare diff.
  const row = { id: 1, status: "cancelled", min_seats: 4, start_date: soon };
  const seats = 4, min = 4;
  let oldReady = 0, oldOpen = 0, oldAtRisk = 0;
  if (row.status === "supplier_confirmed") { /* confirmed */ }
  else if (seats >= min) oldReady++;
  else {
    oldOpen++;
    const daysOut = (new Date(row.start_date) - NOW) / 864e5;
    if (daysOut >= 0 && daysOut <= 14 && seats < min) oldAtRisk++;
  }
  assert.equal(oldReady, 1, "the old expression must reproduce the defect");
  assert.equal(buckets([row], { 1: seats }).readyToConfirm, 0);
});

test("closed and pending_review are excluded too, for different reasons", () => {
  // closed is terminal. pending_review is waiting on a human's decision, not on
  // travellers, so it cannot be prompted by a panel about travellers.
  const b = buckets([
    { id: 1, status: "closed", min_seats: 4, start_date: soon },
    { id: 2, status: "pending_review", min_seats: 4, start_date: soon },
  ], { 1: 4, 2: 4 });
  assert.equal(b.excluded, 2);
  assert.deepEqual(
    [b.open, b.readyToConfirm, b.confirmed, b.atRisk],
    [0, 0, 0, 0]
  );
});

test("live departures still land in the right buckets", () => {
  const b = buckets([
    { id: 1, status: "open", min_seats: 4, start_date: soon },   // 1 seat, soon
    { id: 2, status: "open", min_seats: 4, start_date: later },  // 1 seat, far off
    { id: 3, status: "open", min_seats: 4, start_date: soon },   // 4 seats -> ready
    { id: 4, status: "supplier_confirmed", min_seats: 4, start_date: soon },
  ], { 1: 1, 2: 1, 3: 4, 4: 0 });

  assert.equal(b.open, 2);
  assert.equal(b.readyToConfirm, 1);
  assert.equal(b.confirmed, 1);
  assert.equal(b.atRisk, 1, "only the near date under its minimum");
  assert.equal(b.excluded, 0);
});

test("at risk means under the minimum and inside the window", () => {
  // A date at its minimum is `readyToConfirm`, so it can never also be at risk —
  // the old code carried a redundant `seats < min` in the atRisk condition that
  // hid this. Asserted so the redundancy cannot be reintroduced as a fix.
  const b = buckets([{ id: 1, status: "open", min_seats: 4, start_date: soon }], { 1: 4 });
  assert.equal(b.readyToConfirm, 1);
  assert.equal(b.atRisk, 0);
});

test("a departure that has already left is not at risk", () => {
  const past = "2026-08-01";
  const b = buckets([{ id: 1, status: "open", min_seats: 4, start_date: past }], { 1: 1 });
  assert.equal(b.open, 1);
  assert.equal(b.atRisk, 0, "nothing can be done about a date that has gone");
});

test("the window is the constant, not a number typed twice", () => {
  assert.equal(AT_RISK_DAYS, 14);
  const edge = new Date(NOW + AT_RISK_DAYS * 864e5).toISOString().slice(0, 10);
  const justOutside = new Date(NOW + (AT_RISK_DAYS + 1) * 864e5).toISOString().slice(0, 10);
  assert.equal(buckets([{ id: 1, status: "open", min_seats: 4, start_date: edge }], { 1: 1 }).atRisk, 1);
  assert.equal(buckets([{ id: 1, status: "open", min_seats: 4, start_date: justOutside }], { 1: 1 }).atRisk, 0);
});
