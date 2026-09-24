// JJ2.4 — the dry run refrains WITH SOMETHING TO REFRAIN FROM.
//
// The claim "a dry run cancels nothing and emails nobody" had never been
// observed against a candidate. Every tick in production has had zero
// candidates, because `departures` is empty, so the branch that matters had
// never been entered. It was verified by reading the function — and reading a
// representation is not observing the system.
//
// The rehearsal in docs/audit/cancel-job-rehearsal.md observed it once against
// a real database. This holds it observed.
//
// Deliberately NOT a vacuous test: every case asserts `candidates >= 1` first.
// An empty candidate list would otherwise satisfy "cancelOne was never called"
// for the wrong reason, which is exactly the failure this is guarding against.
import { test } from "node:test";
import assert from "node:assert/strict";

// The job module pulls in the database pool, which throws on import without a
// DATABASE_URL — see the note in scheduler.js about why the scheduler imports
// it lazily. Nothing here ever connects: a pg Pool opens no socket until a
// query runs, and the fakes below mean none does.
process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/never-connected";
const { runCancelUnconfirmed } = await import("./cancel-unconfirmed.js");

// One departure past its deadline, one seat of the four it needed, one
// traveller holding an email address. The shape loadCandidates() returns.
function oneCandidate() {
  return [{
    dep: {
      id: 999001,
      route: "Giza Pyramids & Sphinx — small group",
      startDate: "2026-08-12",
      date: "2026-08-12",
      minSeats: 4,
      pledges: [{ id: "p1", seats: 1, status: "confirmed", customerEmail: "traveller@example.test" }],
    },
    product: { id: "prod", type: "day_tour", confirmDeadlineDays: 7 },
  }];
}

function spies({ candidates = oneCandidate() } = {}) {
  const calls = { cancelOne: 0, send: 0, sentTo: [] };
  return {
    calls,
    deps: {
      loadCandidates: async () => candidates,
      cancelOne: async (candidate) => {
        calls.cancelOne += 1;
        return {
          cancelled: true,
          recipients: candidate.dep.pledges.map((p) => p.customerEmail),
          departure: candidate.dep,
        };
      },
      send: async (mail) => {
        calls.send += 1;
        calls.sentTo.push(mail.to);
        return { ok: true };
      },
    },
  };
}

test("dry run: a candidate is found, and neither cancelled nor emailed", async () => {
  const { calls, deps } = spies();
  const lines = [];
  const result = await runCancelUnconfirmed({ dryRun: true, deps, log: (l) => lines.push(l) });

  // The guard against a vacuous pass. If this ever fails, the two assertions
  // below are meaningless and must not be read as a green light.
  assert.ok(result.candidates >= 1, "no candidate was present — the rest of this test proves nothing");

  assert.equal(calls.cancelOne, 0, "dry run reached cancelOne()");
  assert.equal(calls.send, 0, "dry run reached sendEmail()");
  assert.equal(result.cancelled, 0);
  assert.equal(result.notified, 0);
  assert.ok(lines.some((l) => l.includes("[would cancel]")), "the candidate was not reported");
});

test("live run on the same candidate does cancel and does email", async () => {
  // The other half of the pair. Without it, the dry-run test above would pass
  // just as well against a job that had quietly stopped working altogether.
  const { calls, deps } = spies();
  const result = await runCancelUnconfirmed({ dryRun: false, deps, log: () => {} });

  assert.ok(result.candidates >= 1, "no candidate was present — this test proves nothing");
  assert.equal(calls.cancelOne, 1);
  assert.equal(calls.send, 1);
  assert.deepEqual(calls.sentTo, ["traveller@example.test"]);
  assert.equal(result.cancelled, 1);
  assert.equal(result.notified, 1);
});

test("the vacuity guard fires when there is nothing to act on", async () => {
  // Proves the guard above is load-bearing rather than decorative: with an
  // empty candidate list the counters are identical to the dry-run case.
  const { calls, deps } = spies({ candidates: [] });
  const result = await runCancelUnconfirmed({ dryRun: true, deps, log: () => {} });

  assert.equal(result.candidates, 0);
  assert.equal(calls.cancelOne, 0);
  assert.equal(calls.send, 0);
  // Identical to a passing dry run — which is why `candidates >= 1` has to be
  // asserted there and cannot be inferred.
});

test("an unanswered request is closed with the request's own letter, not the GoAhead cancellation", async () => {
  const [c] = oneCandidate();
  const lapsed = [{
    ...c,
    kind: "lapsed_request",
    dep: { ...c.dep, status: "pending_review",
      pledges: [{ id: "p1", seats: 2, status: "pending", customers: "Ana", customerEmail: "traveller@example.test" }] },
  }];
  const mails = [];
  const { calls, deps } = spies({ candidates: lapsed });
  const send = deps.send;
  deps.send = async (mail) => { mails.push(mail); return send(mail); };

  const dry = [];
  await runCancelUnconfirmed({ dryRun: true, deps, log: (l) => dry.push(l) });
  assert.equal(calls.cancelOne, 0, "dry run reached cancelOne()");
  assert.ok(dry.some((l) => l.includes("unanswered request") && l.includes("[would cancel]")));

  const result = await runCancelUnconfirmed({ dryRun: false, deps, log: () => {} });
  assert.ok(result.candidates >= 1, "no candidate was present — this test proves nothing");
  assert.equal(calls.cancelOne, 1);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].kind, "departure_request_declined");
  assert.match(mails[0].text, /Hi Ana/);
  assert.match(mails[0].text, /weren't able to review this date/);
});
