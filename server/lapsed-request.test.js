// A traveller-requested date that reaches its day with nobody approving or
// declining it. Before this it sat in `pending_review` forever — two such rows
// were in production, dated in the past — and the traveller never heard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lapsedRequest } from "./domain.js";

const DAY = "2026-10-01";
const BEFORE = Date.parse("2026-09-30T12:00:00Z");
const AFTER = Date.parse("2026-10-01T12:00:00Z");

function request({ status = "pending_review", pledgeStatus = "pending" } = {}) {
  return { status, date: DAY, time: "08:00", pledges: [{ id: "p1", seats: 2, status: pledgeStatus }] };
}

test("an unanswered request lapses once its date has started", () => {
  assert.equal(lapsedRequest(request(), AFTER), true);
});

test("not before the date — someone may still decide", () => {
  assert.equal(lapsedRequest(request(), BEFORE), false);
});

test("requests made before bookings carried `pending` are left alone", () => {
  // The client's instruction: those travellers were already told, and nothing
  // unattended rewrites what they were told.
  assert.equal(lapsedRequest(request({ pledgeStatus: "confirmed" }), AFTER), false);
  assert.equal(lapsedRequest(request({ pledgeStatus: "cancelled" }), AFTER), false);
});

test("only dates still in review", () => {
  for (const status of ["open", "minimum_reached", "supplier_confirmed", "cancelled"]) {
    assert.equal(lapsedRequest(request({ status }), AFTER), false, status);
  }
});
