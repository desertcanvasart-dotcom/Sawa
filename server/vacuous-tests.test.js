// DIR-14 — the sweep, and proof it can find something.
//
// A test passed for the life of this codebase because the tables it checked
// were empty. It asserted nothing, and a vacuous pass renders identically to a
// real one.
//
// LLL5.2: this is the last point at which the empty-table assumption can be
// audited while it is still true. After the seed, a test that passed vacuously
// and one that passed genuinely are no longer distinguishable by inspection —
// the evidence for telling them apart IS the emptiness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { vacuous, testBlocks, ACCEPTED, SELF_GUARDING } from "../scripts/check-vacuous-tests.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (src) => {
  const dir = mkdtempSync(join(tmpdir(), "vacuous-"));
  const file = join(dir, "x.test.js");
  writeFileSync(file, src);
  return file;
};

test("it fires on an assertion inside a loop over a computed collection", () => {
  const f = fixture(`test("x", () => {\n  for (const p of load()) {\n    assert.ok(p);\n  }\n});\n`);
  assert.equal(vacuous([f]).length, 1);
});

test("it stops on a loop over a literal — those cannot be empty", () => {
  // The first version flagged 38 of ~200 tests, almost all of them looping over
  // a literal array written three lines above. Left as written it would have
  // been baselined inside a week and taken the real class with it.
  const f = fixture(`test("x", () => {\n  for (const s of ["a", "b"]) {\n    assert.ok(s);\n  }\n});\n`);
  assert.deepEqual(vacuous([f]), []);
});

test("it stops on an identifier bound to a literal in the same file", () => {
  const f = fixture(`const CASES = ["a"];\ntest("x", () => {\n  for (const s of CASES) {\n    assert.ok(s);\n  }\n});\n`);
  assert.deepEqual(vacuous([f]), []);
});

test("it stops when the test asserts the collection is non-empty", () => {
  const f = fixture(`test("x", () => {\n  assert.ok(load().length);\n  for (const p of load()) {\n    assert.ok(p);\n  }\n});\n`);
  assert.deepEqual(vacuous([f]), []);
});

test("the repository has no vacuous loop", () => {
  assert.deepEqual(vacuous().map((p) => `${p.file}: ${p.name}`), []);
});

test("the block reader finds tests, or the sweep is vacuous itself", () => {
  const src = readFileSync(join(ROOT, "server", "domain.test.js"), "utf8");
  assert.ok(testBlocks(src).length > 10, "the test-block reader found almost nothing");
});

test("every exemption carries a reason", () => {
  for (const [name, why] of Object.entries(ACCEPTED)) {
    assert.ok(typeof why === "string" && why.length > 40, `${name} is exempt with no real reason`);
  }
  assert.ok(Object.keys(ACCEPTED).length, "no exemptions — this asserts nothing");
});

test("a self-guarding source must still guard itself", () => {
  // An allowance that outlives its guard is worse than no allowance: it says
  // "checked" where nothing checks.
  assert.ok(Object.keys(SELF_GUARDING).length);
  const partials = readFileSync(join(ROOT, "scripts", "sync-partials.js"), "utf8");
  assert.match(partials, /Refusing to report a pass on an empty set/,
    "pages() is trusted to refuse an empty list and no longer does");
});
