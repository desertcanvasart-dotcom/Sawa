// DIR-13 — proving `audit:claims` fires.
//
// Five test files mention scripts/audit-claims.js. Every one of them reads it
// as TEXT — asserting a rule's comment is present, or that a premise is still
// written down. Not one imports `scan` and puts a claim in front of it.
//
// So the check that decides whether the public site promises things the system
// cannot do had no test proving it catches anything. It is not one of DIR-13's
// three; it is the same defect, found while retrofitting them, and cheaper to
// close now than to file.
import test from "node:test";
import assert from "node:assert/strict";
import { scan, RULES } from "../scripts/audit-claims.js";

const hits = (text) => scan(text, "fixture").map((f) => f.rule);

test("it fires — the guarantee this project removed under P1.5", () => {
  assert.ok(hits("Your departure is guaranteed to run.").includes("guarantee"),
    "the exact claim P1.5 deleted is not caught");
});

test("it fires — an unconditional promise the model cannot keep", () => {
  for (const claim of ["100% guaranteed", "A risk-free booking", "hassle-free travel"]) {
    assert.ok(hits(claim).includes("absolute-claim"), `"${claim}" was not caught`);
  }
});

test("it stops — the scoped form the site actually uses", () => {
  // The `guarantee` rule carries an `ok` predicate precisely so that saying
  // what Sawa does NOT guarantee is publishable. If this ever fires, the
  // honest sentence becomes unsayable and the rule starts causing the problem.
  assert.deepEqual(hits("We do not guarantee that a date reaches its minimum."), []);
});

test("it stops — ordinary travel prose is not a claim", () => {
  assert.deepEqual(hits("The felucca leaves from the west bank at sunset."), []);
});

test("every rule states why it exists, and can be shown to fire", () => {
  // A rule with no `why` cannot be argued with when it fires on correct copy —
  // which has happened twice in this repository.
  assert.ok(RULES.length >= 5, `only ${RULES.length} rules`);
  for (const r of RULES) {
    assert.ok(r.id, "a rule without an id cannot be reported");
    assert.ok(r.why && r.why.length > 20, `rule ${r.id} does not say why it exists`);
    assert.ok(r.re instanceof RegExp, `rule ${r.id} has no pattern`);
  }
});
