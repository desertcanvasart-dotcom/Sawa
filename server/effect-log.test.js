// ZZ1.4 / ZZ2 — a non-fatal failure is not a silent one, and a mode reports
// effect rather than configuration.
//
// The state this exists to make visible: configured, tried, and never once
// succeeded. The mirror was in it for the whole life of the feature, and
// `/api/modes` reported `autoura: on` — true, and read by two people as
// evidence that data was flowing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordSuccess, recordFailure, effectReport, __resetEffects } from "./effect-log.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("configured but never once worked is its own state", () => {
  __resetEffects();
  recordFailure("autouraSync", "#1: emit failed: loadEnriched is not defined");
  recordFailure("autouraSync", "#2: emit failed: loadEnriched is not defined");

  const r = effectReport().autouraSync;
  assert.equal(r.neverWorked, true, "the exact state the mirror was in, unreported, for years");
  assert.equal(r.lastSuccess, null);
  assert.equal(r.failures, 2);
  assert.match(r.lastError, /loadEnriched/);
});

test("worked once and is now failing is a DIFFERENT state", () => {
  // These must not collapse. "Never worked" is a build error; "worked and
  // stopped" is an outage, and they call for different responses.
  __resetEffects();
  recordSuccess("email");
  recordFailure("email", "Resend rejected: 401");

  const r = effectReport().email;
  assert.equal(r.neverWorked, false);
  assert.ok(r.lastSuccess, "the success timestamp is what distinguishes the two");
  assert.ok(r.lastFailure);
});

test("lastSuccess is a timestamp, not a boolean", () => {
  // The counters are per-process. "Never since boot" and "not for three days"
  // are different claims, and a boolean cannot tell them apart.
  __resetEffects();
  recordSuccess("email");
  assert.match(effectReport().email.lastSuccess, /^\d{4}-\d{2}-\d{2}T/);
});

test("a recorded failure must carry a reason", () => {
  __resetEffects();
  recordFailure("x");
  assert.equal(effectReport().x.lastError, "unknown",
    "a reasonless failure is the console.warn this replaces, one indirection away");
});

test("a failure is an ERROR, not a warning", () => {
  // The whole finding in one assertion. console.warn is why nobody noticed.
  // Comments stripped first: the module's own header explains what it replaces,
  // and the word "console.warn" appears there. Matching that would be the same
  // shortcut-verification mistake this project keeps finding.
  const code = readFileSync(join(ROOT, "server", "effect-log.js"), "utf8")
    .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(code, /console\.error/);
  assert.ok(!/console\.warn/.test(code), "a recorded failure must not be logged at warn level");
});

test("nothing in production can clear the record", () => {
  const src = readFileSync(join(ROOT, "server", "effect-log.js"), "utf8");
  assert.equal(src.split("__resetEffects").length - 1, 1, "__resetEffects is referenced more than once");
});

test("the two paths that mattered record their effect", () => {
  // Email, because it reaches a named person. The mirror, because it is the one
  // that was configured and inert.
  const email = readFileSync(join(ROOT, "server", "email.js"), "utf8");
  assert.match(email, /recordSuccess\("email"\)/, "a successful send is not recorded");
  assert.match(email, /recordFailure\("email"/, "a failed send is not recorded");

  const sync = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8");
  assert.match(sync, /recordSuccess\("autouraSync"\)/);
  assert.match(sync, /recordFailure\("autouraSync"/);
});

test("/api/modes reports effect, not only configuration", () => {
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  assert.match(app, /effects:\s*effectReport\(\)/,
    "modes answers 'is this switched on' only — which is what misled us about the mirror");
});
