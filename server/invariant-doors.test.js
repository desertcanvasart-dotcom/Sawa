// DIR-5 — invariants that hold through one door.
//
// The productive question is not "what could fail" but **"what could disagree
// without failing."** A loud incompatibility is self-limiting; a silent one is
// unbounded.
//
// Every entry in docs/audit/invariant-doors.md is an invariant that holds
// because everything happens to come through one place. This file asserts the
// ones a commit can break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BANNED, scanCatchHandlers } from "../scripts/check-catch-handlers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = (glob) =>
  execSync(`git -C ${ROOT} ls-files ${glob}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);

// The roots every file-scanning checker walks. A file outside all of them is
// not clean — it is unexamined, and the two look identical in a green run.
const SCANNED_ROOTS = ["server/", "src/", "scripts/", "shared/", "site/"];

test("no JavaScript in this repository sits outside every checker's roots", () => {
  // This is how three hand-written browser scripts — analytics.js, consent.js
  // and sawa.js, loaded on every page — went unscanned. consent.js held three
  // empty handlers, one of which dropped a throwing consent listener.
  const files = tracked("'*.js' '*.jsx'");
  assert.ok(files.length > 50, `only ${files.length} JS files found — git ls-files is not being read`);

  const unscanned = files.filter((f) => !SCANNED_ROOTS.some((r) => f.startsWith(r)));
  assert.deepEqual(unscanned, [],
    "a file outside every checker's roots is unexamined, which reads identically to clean");
});

test("the browser scripts are actually scanned now, not merely in scope", () => {
  // In scope and examined are different claims. This runs the scanner over them.
  const browser = ["site/assets/consent.js", "site/assets/analytics.js", "site/assets/sawa.js"]
    .map((f) => join(ROOT, f));
  assert.deepEqual(scanCatchHandlers(browser), [],
    "an empty handler in a script served to every visitor");
});

test("consent failures are reported, not dropped", () => {
  // The listeners are the things that ACT on consent — the referral store that
  // attributes a partner commission, and analytics loading. A listener that
  // threw was swallowed and the next one ran, so consent could be granted and
  // the thing it grants never happen.
  const src = readFileSync(join(ROOT, "site", "assets", "consent.js"), "utf8");
  assert.match(src, /listeners\.forEach[\s\S]{0,220}warnOnce\("consent-listener"/,
    "a throwing consent listener is silently dropped");
  assert.match(src, /warnOnce\("consent-clear"/,
    "a failed withdrawal must not read as a successful one");

  // And every listener still runs: one failing must not stop the others.
  assert.match(src, /listeners\.forEach\(function \(fn\) \{\s*try \{/);
});

test("the banned patterns still fire — the roots widened, the rule did not weaken", () => {
  // Widening scope while quietly loosening the rule would be the worst outcome:
  // more files, checked less.
  const planted = "load().catch(() => {});";
  assert.ok(BANNED.some(({ re }) => { re.lastIndex = 0; return re.test(planted); }));
});

test("presentDeparture's expectation is documented in a parameter name only", () => {
  // DIR-5 entry, recorded rather than fixed here: the invariant "a departure
  // served to a client has been through enrichDeparture" holds through CALLER
  // DISCIPLINE. presentDeparture names its parameter `enriched` and spreads
  // whatever it is given. Fixing it is DIR-6's job — move the invariant to the
  // boundary — and this asserts the shape has not silently changed underneath
  // that plan.
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  assert.match(app, /function presentDeparture\(enriched, user\)/,
    "presentDeparture changed shape — re-read the DIR-5 entry before assuming it still applies");
});
