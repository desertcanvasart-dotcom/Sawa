// DIR-14 — a test that asserts nothing when its subject set is empty.
//
// A test passed for the life of this codebase because the tables it checked were
// empty. It asserted nothing, and a vacuous pass renders identically to a real
// one — same pixels, same green, same line in the summary.
//
// `pledges` has never held a row and `departures` currently holds none, so every
// test written against them is suspect. **This is the last point at which the
// empty-table assumption can be audited while it is still true** (LLL5.2): after
// the seed, a test that passed vacuously and one that passed genuinely are no
// longer distinguishable by inspection, because the evidence for telling them
// apart IS the emptiness.
//
// ---------------------------------------------------------------------------
// WHAT THIS DETECTS
//
// An assertion inside a loop, in a test that never asserts the loop runs:
//
//   for (const x of somethingComputed) assert.ok(x.valid);   // zero iterations
//   list.forEach((x) => assert.match(x, /y/));               // passes on []
//
// The fix is one line — assert the collection is non-empty first — and the rule
// is worth more than the instances: **a loop is a claim about every member, and
// says nothing about whether there are any.**
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT DETECT, STATED
//
// `assert.deepEqual(derived, [])` — a test that asserts emptiness is correct
// when emptiness is the point, and vacuous when the derivation is broken. The
// two are indistinguishable from syntax; several such tests in this repository
// carry an explicit "the matcher found nothing" guard for that reason, added by
// hand. A checker cannot tell which is which, and pretending otherwise would be
// its own vacuous pass.
//
//   node scripts/check-vacuous-tests.js
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["server", "src"];

// Tests that assert emptiness or a bound on purpose, each with a stated reason.
// A per-test opt-out, not a blanket exemption for a file — the status-literal
// discipline.
export const ACCEPTED = {
  "the repository has no handler that discards a failure":
    "asserts emptiness deliberately, and carries its own non-vacuity guard: the "
    + "companion test plants a defect and requires the scanner to find it.",
  "every mutating route records who did what":
    "asserts emptiness deliberately; the scanner's own test asserts it finds at "
    + "least 30 routes and the BBB1 route specifically.",
  "no fire-and-forget site in the repository leaves severity to a default":
    "already counts what it found and fails if the count is zero.",
  "E-6 — no empty handler is hiding inside a template expression":
    "asserts emptiness deliberately, with a planted-case test beside it.",
  "E-7 — no regex literal follows a closing parenthesis":
    "asserts emptiness deliberately; the limitation is recorded as an evidence-register entry.",
};

// Producers that refuse to return an empty collection, so their callers cannot
// loop zero times. Each needs a reason AND a test asserting the guard is still
// there — an allowance that outlives its guard is worse than no allowance.
export const SELF_GUARDING = {
  "pages()": "scripts/sync-partials.js throws rather than return an empty list",
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".test.js")) out.push(full);
  }
  return out;
}

// Each `test("name", ... )` block, by balancing parentheses.
export function testBlocks(src) {
  const out = [];
  for (const m of src.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
    let depth = 0;
    for (let i = m.index + 4; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) { out.push({ name: m[2], body: src.slice(m.index, i + 1) }); break; }
      }
    }
  }
  return out;
}

const ASSERTS = /\bassert[.(]/;
// Anything that would fail on an empty collection: a length assertion, a count
// comparison, or an explicit "found nothing" guard.
const GUARDS = /\.length\s*[,)]|\.length\s*[><=!]|\blength\s*>=|\bassert\.ok\(\s*\w+\s*>=|\bfound\b|\bcount\b|\brows\.length|assert\.equal\([^,]*\.length/;

export function vacuous(files = ROOTS.flatMap((r) => walk(join(ROOT, r)))) {
  const problems = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const { name, body } of testBlocks(src)) {
      if (name in ACCEPTED) continue;
      // A loop whose body asserts, over a COMPUTED collection.
      //
      // Narrowed after its first run, which flagged 38 of ~200 tests — almost
      // all of them looping over a literal array written three lines above:
      //
      //   for (const s of ["from $45-$68", "7-14 days"]) assert.equal(...)
      //
      // A literal cannot be empty, so those are not vacuous and never could be.
      // Left as written, this check would have been baselined inside a week and
      // taken the real class with it — the NNN1 failure, and the second time in
      // this session a rule of mine fired on correct code.
      const loops = [];
      for (const m of body.matchAll(/for\s*\(\s*(?:const|let)\s+[^)]*?\bof\b\s*([\s\S]*?)\)\s*\{([\s\S]*?)\n\s*\}/g)) {
        loops.push({ over: m[1].trim(), inner: m[2] });
      }
      for (const m of body.matchAll(/([\w$.\])]+)\.forEach\(\s*\(?[^)]*\)?\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\)/g)) {
        loops.push({ over: m[1].trim(), inner: m[2] });
      }
      // A literal array, or Object.entries/keys/values of a literal object, is
      // fixed at the point of writing and cannot be empty at run time — and so
      // is an identifier bound to one IN THIS FILE. `for (const p of CASES)`
      // where `const CASES = [ … ]` sits twenty lines above is as fixed as the
      // literal it names; flagging it would be asking for a guard against a
      // condition the reader can see cannot occur.
      //
      // An identifier bound elsewhere is NOT resolved, deliberately. An imported
      // list can change in a file this test does not read, which is precisely
      // when a guard earns its keep.
      const literalBindings = new Set(
        [...src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)].map((m) => m[1])
      );
      const isLiteral = (e) => /^\[/.test(e)
        || /^Object\.(entries|keys|values)\(\s*\{/.test(e)
        || literalBindings.has(e);
      const safe = (e) => isLiteral(e) || e in SELF_GUARDING;
      const assertsInLoop = loops.some((l) => ASSERTS.test(l.inner) && !safe(l.over));
      if (!assertsInLoop) continue;
      if (GUARDS.test(body)) continue;
      problems.push({ file: relative(ROOT, file).replace(/\\/g, "/"), name });
    }
  }
  return problems;
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-vacuous-tests.js");
if (isCli) {
  const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
  if (!files.length) {
    console.error("No test files found. A sweep that examined nothing must not report clean.");
    process.exit(1);
  }
  const problems = vacuous(files);
  console.log(`${files.length} test files scanned.`);
  if (!problems.length) {
    console.log("Every test that loops to assert also asserts that the loop runs.");
    process.exit(0);
  }
  console.error(`\n${problems.length} test(s) assert inside a loop without asserting the loop runs:\n`);
  for (const p of problems) console.error(`  ${p.file}\n      "${p.name}"`);
  console.error(
    "\nA loop is a claim about every member and says nothing about whether there are any.\n"
    + "Assert the collection is non-empty first, or add the test to ACCEPTED with a reason.\n"
  );
  process.exit(1);
}
