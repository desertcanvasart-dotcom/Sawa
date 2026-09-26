// LL3 — what /booking tells one named person who then acts on it.
//
// The defect: the lookup asked whether the PLEDGE was cancelled, then whether
// enough seats were counted. On a departure the auto-cancel job had cancelled,
// the pledge was still `confirmed` and its seats were still counted, so it
// answered:
//
//   CONFIRMED — GOAHEAD
//   "Your date is confirmed — the guide and transport are booked. See your
//    confirmation email for the meeting point and time."
//
// to a traveller who had just been emailed that their trip was cancelled. Two
// live surfaces, addressed to the same person, saying opposite things — and the
// one that was wrong told them to travel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookingLookupState, bookingLookupView } from "./domain.js";

// The exact state the auto-cancel job leaves behind: it cancels the departure
// and does not touch its pledges (KK1).
const AFTER_AUTO_CANCEL = {
  departureStatus: "cancelled",
  pledgeStatus: "confirmed",
  seatsBooked: 4,
  goAhead: 4,
};

test("a cancelled date is never reported as confirmed", () => {
  // The whole reason this file exists. Note the inputs: the pledge says
  // confirmed and the seats meet the threshold, so every signal the old code
  // looked at pointed at "confirmed".
  assert.equal(bookingLookupState(AFTER_AUTO_CANCEL), "date_cancelled");

  const view = bookingLookupView(AFTER_AUTO_CANCEL);
  assert.equal(view.confirmed, false);
  assert.equal(view.statusLabel, "Date canceled");
  assert.ok(
    !/guide and transport are booked/.test(view.note),
    "the note told a traveller on a cancelled date that their trip was running"
  );
  assert.match(view.note, /isn't running/);
});

test("the old logic really would have said confirmed — this is not a strawman", () => {
  // W3 asks for proof a check fires on a case it should catch. The case here is
  // a past state of this codebase, so it is reproduced exactly and asserted to
  // disagree with the current answer. If someone reverts the guard, the
  // assertion above fails and this one explains why it mattered.
  const b = AFTER_AUTO_CANCEL;
  const oldCancelled = b.pledgeStatus === "cancelled";
  const oldConfirmed = !oldCancelled
    && (b.departureStatus === "supplier_confirmed" || b.seatsBooked >= b.goAhead);
  assert.equal(oldConfirmed, true, "the old expression must reproduce the defect");
  assert.notEqual(oldConfirmed, bookingLookupView(b).confirmed);
});

test("the date's status outranks the pledge's", () => {
  // Both cancelled. Which one a traveller is told about decides whether they
  // think the trip might still have run without them.
  assert.equal(
    bookingLookupState({ departureStatus: "cancelled", pledgeStatus: "cancelled", seatsBooked: 0, goAhead: 4 }),
    "date_cancelled"
  );
});

test("a traveller who cancelled is told that, and not that the date failed", () => {
  const view = bookingLookupView({ departureStatus: "open", pledgeStatus: "cancelled", seatsBooked: 2, goAhead: 4 });
  assert.equal(view.state, "booking_cancelled");
  assert.match(view.note, /This booking was canceled/);
  assert.ok(!/didn't reach/.test(view.note), "blaming the date for a traveller's own cancellation");
});

test("the two states that still run are unchanged", () => {
  const forming = bookingLookupView({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 2, goAhead: 4 });
  assert.equal(forming.state, "forming");
  assert.equal(forming.statusTone, "pending");

  const byThreshold = bookingLookupView({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 4, goAhead: 4 });
  assert.equal(byThreshold.state, "confirmed");

  const bySupplier = bookingLookupView({ departureStatus: "supplier_confirmed", pledgeStatus: "confirmed", seatsBooked: 1, goAhead: 4 });
  assert.equal(bySupplier.state, "confirmed", "an operator-confirmed date runs regardless of the count");
  assert.equal(bySupplier.statusTone, "go");
});

test("a live seat count is not shown on a date that is not running", () => {
  // "4/4 seats to confirm" beside "Date cancelled" reads as a date still
  // filling. It is not information at that point, it is an invitation to wait.
  assert.equal(bookingLookupView(AFTER_AUTO_CANCEL).showProgress, false);
  assert.equal(bookingLookupView({ departureStatus: "open", pledgeStatus: "cancelled", seatsBooked: 3, goAhead: 4 }).showProgress, false);
  assert.equal(bookingLookupView({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 3, goAhead: 4 }).showProgress, true);
});

test("the cancellation note states the threshold, and takes it from the constant", () => {
  // Not a hard-coded "four": if the go-ahead number ever moves, the sentence a
  // cancelled traveller reads must move with it.
  assert.match(bookingLookupView(AFTER_AUTO_CANCEL).note, /\bfour travelers\b/);
  assert.match(
    bookingLookupView({ ...AFTER_AUTO_CANCEL, goAhead: 6 }).note,
    /\bsix travelers\b/
  );
});

test("no state promises a refund", () => {
  // No payment is ever taken. "Refunded in full" is the claim the whole project
  // has been removing; it must not reappear on the one page a cancelled
  // traveller is most likely to open.
  for (const state of [
    AFTER_AUTO_CANCEL,
    { departureStatus: "open", pledgeStatus: "cancelled", seatsBooked: 1, goAhead: 4 },
    { departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 1, goAhead: 4 },
    { departureStatus: "supplier_confirmed", pledgeStatus: "confirmed", seatsBooked: 4, goAhead: 4 },
  ]) {
    const note = bookingLookupView(state).note;
    assert.ok(!/refunded/i.test(note), `a refund was promised: "${note}"`);
  }
});

// A traveller-requested date nobody has approved. Requests used to take the
// column default and read "confirmed"; from now on the booking is `pending`
// until someone decides.
const UNDER_REVIEW = { departureStatus: "pending_review", pledgeStatus: "pending", seatsBooked: 2, goAhead: 4 };

test("an unapproved request reads Under review, shows no seat count, and can be withdrawn", () => {
  const view = bookingLookupView(UNDER_REVIEW);
  assert.equal(view.state, "under_review");
  assert.equal(view.statusLabel, "Under review");
  assert.equal(view.confirmed, false);
  assert.equal(view.showProgress, false);
  assert.equal(view.canCancel, true);
  assert.match(view.note, /reviewing/);
  assert.ok(!/refunded/i.test(view.note));
});

test("a date still in review is never Confirmed, however many seats it holds", () => {
  // Four seats on one request met the threshold and read "Confirmed — GoAhead"
  // to someone whose date nobody had approved.
  assert.equal(bookingLookupState({ ...UNDER_REVIEW, seatsBooked: 4 }), "under_review");
  // A request made before `pending` existed carries `confirmed`. It keeps the
  // answer it was given — forming — and still never reads confirmed.
  assert.equal(bookingLookupState({ ...UNDER_REVIEW, pledgeStatus: "confirmed", seatsBooked: 4 }), "forming");
  assert.equal(bookingLookupState({ ...UNDER_REVIEW, pledgeStatus: "confirmed", seatsBooked: 2 }), "forming");
});

test("approval moves an under-review booking to the ordinary states", () => {
  assert.equal(bookingLookupState({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 2, goAhead: 4 }), "forming");
  assert.equal(bookingLookupState({ departureStatus: "cancelled", pledgeStatus: "cancelled", seatsBooked: 0, goAhead: 4 }), "date_cancelled");
});
