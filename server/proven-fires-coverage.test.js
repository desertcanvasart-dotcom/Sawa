// DIR-13 — the mechanism, so "half done" cannot happen again quietly.
//
// W3's rule: no check may enter the gate without a test proving it fires on a
// case it should catch. That was a promise, kept by memory, and memory lost
// three of them for two months. The directive's own words: *"half done is the
// more dangerous label — 'not done' invites work, 'looks done' invites
// nobody."*
//
// This derives the list from preflight's STEPS rather than restating it, for
// the same reason ci-gate.js does: a check added to the gate and not to a
// hand-written list here would be invisible in exactly the situation this test
// exists for.
//
// WHAT THIS ASSERTS, AND WHAT IT CANNOT
//
// That a test IMPORTS each check's module. It cannot tell whether that test
// plants a defect or merely asserts today's clean state — that judgement lives
// in the test, and pretending to automate it would be its own vacuous pass.
// What it does close is the case that actually occurred: a check in the gate
// with no test exercising it at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "../scripts/preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Per-step opt-outs, each with a reason — the status-literal discipline. A
// blanket exemption for "steps that are awkward" is how the first three were
// lost.
const ACCEPTED = {
  "check:node":
    "a process-level assertion about the running Node major, with no pure "
    + "function to exercise: importing it calls process.exit. Refactoring it to "
    + "be testable is a change to a check, which is not what DIR-13 asked for. "
    + "Recorded here rather than left looking covered.",
  "test":
    "scripts/run-tests.js IS the runner executing this file. A test that "
    + "imports it is circular.",
};

test("every check in the gate has a test that exercises it", () => {
  const tests = readdirSync(join(ROOT, "server")).filter((f) => f.endsWith(".test.js"));
  assert.ok(tests.length > 20, `only ${tests.length} test files found — refusing to report clean`);
  const src = new Map(tests.map((f) => [f, readFileSync(join(ROOT, "server", f), "utf8")]));

  const uncovered = [];
  for (const step of STEPS) {
    if (step.name in ACCEPTED) continue;
    // An IMPORT, not a mention. Five test files name audit-claims.js in a
    // comment or read it as text; none of that runs a line of it, and that is
    // exactly how `audit:claims` looked covered while being unexercised.
    const importers = tests.filter((f) => new RegExp(`from\\s+["']\\.\\./${step.script}["']`).test(src.get(f)));
    if (!importers.length) uncovered.push(`${step.name}  (${step.script})`);
  }

  assert.deepEqual(uncovered, [],
    `these checks are in preflight with no test importing them:\n  ${uncovered.join("\n  ")}\n`
    + `Write one that plants a defect and asserts it is caught, or add the step to `
    + `ACCEPTED with a reason.`);
});

test("and the opt-outs are still steps — an accepted name that left the gate is stale", () => {
  const names = new Set(STEPS.map((s) => s.name));
  const stale = Object.keys(ACCEPTED).filter((n) => !names.has(n));
  assert.deepEqual(stale, [], `ACCEPTED names a step preflight no longer has: ${stale.join(", ")}`);
});

test("it fires — a check with no test is reported, not skipped", () => {
  // The planted case. Without it this file asserts "the list is empty", which
  // is also what a matcher that found nothing would say.
  const fake = [{ name: "check:invented", script: "scripts/does-not-exist.js" }];
  const tests = readdirSync(join(ROOT, "server")).filter((f) => f.endsWith(".test.js"));
  const src = new Map(tests.map((f) => [f, readFileSync(join(ROOT, "server", f), "utf8")]));
  const uncovered = fake.filter((s) =>
    !tests.some((f) => new RegExp(`from\\s+["']\\.\\./${s.script}["']`).test(src.get(f))));
  assert.equal(uncovered.length, 1, "a check with no test must be reported");
});
