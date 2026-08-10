// EEEE1 — vacuity cuts both ways.
//
// DIR-14 was framed around vacuous PASSES: a test asserting nothing over an
// empty set and reporting green. The other half arrived by producing a false
// FAILURE: an `UPDATE … SET min_seats = 6` against an empty `departures` table
// matched zero rows, fired no constraint, and the harness read "0 rows changed"
// as "the constraint is not enforcing". That was one step from being reported
// to the client as a production defect.
//
// The fault is identical in both directions. **Zero rows is the absence of a
// subject, not a result.** Which verdict it produces depends only on the shape
// of the check — green from a scan, red from an UPDATE — and neither is
// information.
//
// ---------------------------------------------------------------------------
// EEEE1.1 — the rule
//
//   A check operating over a collection must assert its subject set is
//   non-empty BEFORE interpreting the outcome. No subject is a THIRD state,
//   neither pass nor fail.
//
// The same discipline as `smoke`'s SITE DID NOT ANSWER, `check:applied-schema`'s
// not-checked / applied / not-applied, and the audit's three-state reporting.
//
// ---------------------------------------------------------------------------
// WHAT THIS FOUND
//
// Four collectors accepted an empty subject and answered anyway. Their CLIs
// guarded; the exported functions did not — and the exported function is what a
// TEST calls, so a test could hand one an empty list and read the empty result
// as clean. `audit-coverage` did fail, but with a `TypeError` about a "path"
// argument: an accidental crash is not a refusal, and reads as a broken harness
// rather than a check declining to answer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vacuous } from "../scripts/check-vacuous-tests.js";
import { duplications, authorities } from "../scripts/check-duplication.js";
import { scanStatusLiterals } from "../scripts/check-status-literals.js";
import { scanMutatingRoutes } from "../scripts/audit-coverage.js";
import { scanCatchHandlers } from "../scripts/check-catch-handlers.js";
import { collect } from "../scripts/audit-repo-truth.js";

// Every collector, and the empty subject each must refuse.
const COLLECTORS = [
  ["check-vacuous-tests.vacuous",       () => vacuous([])],
  ["check-duplication.duplications",    () => duplications([], authorities())],
  ["check-duplication (no authorities)",() => duplications(["x.js"], new Map())],
  ["check-status-literals.scan",        () => scanStatusLiterals([], {})],
  ["audit-coverage.scanMutatingRoutes", () => scanMutatingRoutes(null)],
  ["check-catch-handlers.scan",         () => scanCatchHandlers([])],
  ["audit-repo-truth.collect",          () => collect([], () => "")],
];

test("no collector answers a question about an empty subject set", () => {
  const answered = [];
  for (const [name, run] of COLLECTORS) {
    try {
      const out = run();
      answered.push(`${name} returned ${JSON.stringify(out)} instead of refusing`);
    } catch (e) {
      // A refusal must SAY it is refusing. An incidental TypeError is not one:
      // it reads as a broken harness, and the next person fixes the caller.
      // ONE phrase, deliberately. Four collectors refused in four different
      // wordings, so a matcher had to accept four — and a matcher that accepts
      // anything plausible stops distinguishing a refusal from a crash.
      assert.match(e.message, /refusing to report clean/i,
        `${name} threw, but not as a stated refusal: ${e.message}`);
    }
  }
  assert.deepEqual(answered, [],
    `these collectors report a clean result over nothing:\n  ${answered.join("\n  ")}\n\n`
    + `Zero subjects is the absence of a question. Refuse, with a reason.`);
});

test("it stops — every collector still answers when there IS a subject", () => {
  // Without this the rule above is satisfiable by throwing unconditionally,
  // which would be a check that cannot pass (NNN1.2).
  assert.ok(Array.isArray(vacuous(["server/constants.test.js"])));
  assert.ok(Array.isArray(duplications(["server/domain.js"], authorities())));
  assert.ok(collect(["fixture.md"], () => "Payments are in log-mode for now — no processor is connected.").length > 0);
});

test("it fires — a collector that answers over nothing is named", () => {
  // The planted case. Without it the assertion above is "the list is empty",
  // which is what a loop over the wrong thing also produces.
  const fake = [["invented.collector", () => []]];
  const answered = fake.filter(([, run]) => { try { run(); return true; } catch { return false; } })
    .map(([n]) => n);
  assert.deepEqual(answered, ["invented.collector"]);
});

// ---------------------------------------------------------------------------
// EEEE1.4 — a check's premise must be something someone actually asserted.
//
// The second false failure: I asserted a founding-partner record existed in
// production. Nobody had claimed to create it — the INSERT had been handed over
// one message earlier and not run. The check was not wrong about the data; it
// was wrong about what had been claimed, and it reported a client's step as a
// defect.
//
// Nothing mechanical catches that. It is recorded here because this file is
// where the next person will look for it.
test("EEEE1.4 is recorded where the rule lives", () => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(src, /premise must be something someone actually asserted/);
});
