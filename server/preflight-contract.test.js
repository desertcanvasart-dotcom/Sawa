// CCC3 — the gate's own scope, asserted.
//
// On 10 August 2026 "preflight is green" was reported for a command that exits
// 1. Ten steps each printed their own success line, the composite exit code was
// never read, and `audit:claims` had been failing on 14 findings throughout.
// The verdict was assembled out of fragments — which is this project's own
// recurring failure, applied to its own gate.
//
// Two things follow, and this file holds both:
//
//   One thing prints the verdict, and it prints the target with it.
//   A check that exists must be IN the gate, or its absence is a decision
//   nobody made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "../scripts/preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Deliberately outside the gate, each for a stated reason.
const NOT_IN_PREFLIGHT = {
  "test:integration": "needs a live database; named and excluded on purpose",
  "check:node": "in the gate — listed here only so the filter below is explicit",
  "audit:page": "takes explicit page arguments; it is the building block for the scheduled\n    production audit (PPP1.1), not a whole-site gate. Running it with no arguments\n    audits nothing, which must not be able to read as a pass.",
};

test("preflight is one runner, not a chain of ten", () => {
  assert.equal(pkg.scripts.preflight, "node scripts/preflight.js");
  assert.ok(!pkg.scripts.preflight.includes("&&"),
    "a chain leaves every step to print its own verdict and nothing to print the whole");
});

test("every check and audit in package.json is in the gate", () => {
  // The MM3 class: a second list is one more thing to keep in step. A check
  // written and never wired in is a check that does not exist.
  const gated = new Set(STEPS.map((s) => s.name));
  const missing = Object.keys(pkg.scripts)
    .filter((n) => /^(check|audit):/.test(n))
    .filter((n) => !gated.has(n) && !(n in NOT_IN_PREFLIGHT));
  assert.deepEqual(missing, [], `these checks exist but nothing runs them: ${missing.join(", ")}`);
});

test("every gated step points at a script that exists", () => {
  for (const s of STEPS) {
    assert.doesNotThrow(() => readFileSync(join(ROOT, s.script), "utf8"), `${s.name} -> ${s.script}`);
  }
});

test("the steps whose answer depends on the target say so", () => {
  // "smoke passed" means nothing without "against what". These two default to
  // localhost, so a green run says nothing about sawa.tours unless the base is
  // stated — the WW3 class, one level up from which Node was installed.
  const targeted = STEPS.filter((s) => s.needsTarget).map((s) => s.name);
  assert.deepEqual(targeted.sort(), ["audit:claims", "smoke"]);
});

test("the runner prints the target in its verdict", () => {
  const src = readFileSync(join(ROOT, "scripts", "preflight.js"), "utf8");
  assert.match(src, /PREFLIGHT VERDICT — target \$\{BASE\}/,
    "a green run must carry its own scope");
  assert.match(src, /NOT CHECKED:/,
    "what was skipped must be printed, or a reader cannot tell a narrow pass from a wide one");
});

test("could not check is not a pass", () => {
  // The two places that used to report a gap and still exit 0.
  const smoke = readFileSync(join(ROOT, "scripts", "smoke-routes.js"), "utf8");
  assert.match(smoke, /SKIPPED \/api\/health[\s\S]{0,200}modeFailures\+\+/,
    "a skipped assertion must count against the run, not merely print");

  const audit = readFileSync(join(ROOT, "scripts", "audit-claims.js"), "utf8");
  assert.match(audit, /coverage\.degraded/, "narrowed coverage must be recorded");
  assert.ok(!/f\.rule !== "fetch-failed"/.test(audit),
    "a file the auditor could not read was a finding that did not fail the run");
});
