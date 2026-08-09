// WW3.1 — the unit suite, run identically on every Node the project supports.
//
// `npm test` was `node --test server/ src/`. Node 20 resolves a bare directory
// there; Node 22 does not, and reports:
//
//   Error: Cannot find module '/…/server'
//
// which surfaces as `# tests 2 / # fail 2` — two "tests", both the directories.
// It does not look like a toolchain problem. It looks like two failing tests.
//
// The pre-commit hook runs `npm test`, so under Node 22 it blocked EVERY commit,
// not just red ones. That is worse than no gate: the first person under time
// pressure reaches for `--no-verify` and the gate is gone permanently. Switching
// Node versions to get past it — which is what I did — is the benign version of
// the same move, and it leaves the gate broken for the next person.
//
// So the files are enumerated here and passed explicitly. Both versions accept
// an explicit list.
//
// Deliberately readdirSync rather than a glob helper: `fs.globSync` does not
// exist on Node 20, and a previous check in this repo used it, found zero files
// and exited 0 — a green run that had tested nothing. The whole point of this
// file is not to depend on which Node is installed.
import { readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["server", "src"];

function findTests(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findTests(full, out);
    else if (entry.endsWith(".test.js")) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => findTests(join(ROOT, r))).sort();

// A suite that finds nothing must fail, loudly. An empty run exits 0 and reads
// exactly like a passing one — the same shape as the glob failure above.
if (!files.length) {
  console.error("No test files found under " + ROOTS.join(", ") + ". Refusing to report a pass.");
  process.exit(1);
}

// YY3.1 — pin the timezone.
//
// This machine's TZ is Africa/Cairo, which is the ONE timezone in which a
// host-timezone bug in this application is invisible: every deadline, cutoff and
// "has this date started" is Egyptian local time, so code that accidentally uses
// the host clock agrees with code that correctly uses Cairo, and the suite
// cannot tell them apart.
//
// UTC is the pin because it is what Railway runs, and because it differs from
// Cairo by 2 or 3 hours depending on the season — so anything relying on the
// host surfaces as a wrong instant rather than as nothing at all.
//
// This is a YY1 case: an incompatibility that breaks is self-limiting; one that
// only makes the numbers wrong is unbounded. Nothing here would have failed.
//
// An explicit TZ is respected, so `TZ=Africa/Cairo npm test` still works for
// checking the other side deliberately.
const timeZone = process.env.TZ || "UTC";

// WW3.2 / YY3.3 — say which environment produced this result. A check whose
// outcome depends on an unstated environmental condition is not a verdict.
console.log(`# node ${process.version} · TZ=${timeZone} · ${files.length} test files`);

const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...files.map((f) => relative(ROOT, f))],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, TZ: timeZone } }
);
process.exit(result.status ?? 1);
