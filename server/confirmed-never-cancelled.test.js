// BBBB4 — the unattended job must never cancel a confirmed departure.
//
// The client has settled it: once a date reaches GoAhead it runs, even if
// travellers drop out afterwards. The strongest claim on the site now rests on
// this job, and the cancellation email is already built and live.
//
// The defect this closes, which was real in the code:
//
//   1. four seats           refreshStatus writes `minimum_reached`.
//                           Travellers are told the trip is confirmed.
//   2. one traveller leaves refreshStatus recomputed and wrote `open` AGAIN.
//   3. past the deadline    loadCandidates selects `WHERE status = 'open'`,
//                           missedConfirmDeadline agrees, and the job cancels a
//                           CONFIRMED departure and emails everyone.
//
// Masked only by `departures` being empty and the job being dry-run by default.
// Both masks disappear at the seed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { missedConfirmDeadline, confirmDeadlineAt } from "./domain.js";
import { statusFor, isGoAheadDeparture, isFormingDeparture } from "../shared/departure-state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LONG_PAST = Date.parse("2030-01-01T00:00:00Z");

// Confirmed at four, since dropped to three: the exact shape of the promise.
const confirmedThenDropped = {
  id: 1, status: "minimum_reached", minSeats: 4, date: "2026-09-01", time: "09:00",
  pledges: [{ seats: 4, status: "cancelled" }, { seats: 3, status: "confirmed" }],
};
const neverReached = {
  id: 2, status: "open", minSeats: 4, date: "2026-09-01", time: "09:00",
  pledges: [{ seats: 3, status: "confirmed" }],
};

test("a confirmed departure that fell below its minimum is never a candidate", () => {
  assert.equal(missedConfirmDeadline(confirmedThenDropped, null, LONG_PAST), false,
    "the job would cancel a departure that was confirmed to run");
});

test("it fires — the same departure IS a candidate if it never confirmed", () => {
  // NNN1. Without this, the assertion above could pass because
  // missedConfirmDeadline returns false for everything.
  assert.equal(missedConfirmDeadline(neverReached, null, LONG_PAST), true,
    "nothing is ever a candidate — the rule cannot cancel anything");
  assert.ok(!Number.isNaN(confirmDeadlineAt(neverReached, null)));
});

test("and it stays confirmed everywhere a traveller can see it", () => {
  // The job is safe, but the promise is only kept if the site agrees. A page
  // showing "1 seat needed" for a date we have promised will run is the same
  // failure with a different surface.
  assert.equal(statusFor(confirmedThenDropped), "minimum_reached");
  assert.equal(isGoAheadDeparture(confirmedThenDropped), true, "it must stay on /goahead");
  assert.equal(isFormingDeparture(confirmedThenDropped), false, "it must not reappear as forming");
});

test("the ratchet is in the writer too, not only the reader", () => {
  // refreshStatus is what wrote `open` back. A reader-only fix would leave the
  // database saying `open`, and the job queries the database.
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  // Bounded by the NEXT declaration rather than a character count. The first
  // version sliced 900 characters and failed on the length of the comment
  // explaining the fix — a test that fails while the code is correct is the
  // NNN1 failure, and it gets "fixed" by deletion.
  const from = app.indexOf("async function refreshStatus");
  const to = app.indexOf("\nasync function ", from + 10);
  const fn = app.slice(from, to === -1 ? from + 4000 : to);
  assert.match(fn, /\["pending_review", "minimum_reached", "supplier_confirmed", "closed", "cancelled"\]/,
    "refreshStatus can still downgrade a confirmed departure to open");
});

test("the job's own query cannot reach a confirmed departure", () => {
  // Belt and braces: even if the rule above changed, the selection is narrowed
  // to `open`. Both must hold — the rule is the reason, the query is the floor.
  const job = readFileSync(join(ROOT, "server", "jobs", "cancel-unconfirmed.js"), "utf8");
  assert.match(job, /WHERE status = 'open'/);
});

test("BBBB1 is scoped to headcount, not to running at all", () => {
  // P1.5 removed "100% guaranteed to run" because it promised something outside
  // Sawa's control. The new rule must not restore it in new clothes: Sawa does
  // not cancel for LOW NUMBERS. A site closure or an operator failure still
  // cancels, with a full refund, and that lives in the Terms.
  const rules = readFileSync(join(ROOT, "shared", "departure-state.js"), "utf8");
  assert.match(rules, /scoped to, precisely: HEADCOUNT/i);
  assert.match(rules, /safety situation still cancels/i);
});
