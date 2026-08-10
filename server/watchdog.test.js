// TTT2 — the monitor's own heartbeat, and the state its silence hides.
//
// A daily job that stops running produces no alert, and no alert reads as no
// drift. That is the mirror's shape one level up: the monitor becomes the thing
// that fails silently, and its silence is indistinguishable from success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { watchdogReport, STALE_AFTER_MS, WATCH_ACTION } from "./watchdog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-08-12T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test("never run is not the same as ran and found nothing", () => {
  // ZZ2's lesson applied to the monitor. A boolean would collapse them, and the
  // collapsed value reads as the good one.
  const r = watchdogReport(null, NOW);
  assert.equal(r.neverRun, true);
  assert.equal(r.stale, true, "never having run must not read as fresh");
  assert.equal(r.lastRun, null);
});

test("a recent run is fresh", () => {
  const r = watchdogReport(hoursAgo(3), NOW);
  assert.equal(r.stale, false);
  assert.equal(r.ageHours, 3);
  assert.equal(r.neverRun, false);
});

test("one missed daily run is not staleness", () => {
  // TTT1 — a signal that fires when nothing is wrong stops being a signal. A
  // 24h threshold fires on every deploy that lands near the tick.
  assert.equal(watchdogReport(hoursAgo(26), NOW).stale, false);
  assert.equal(watchdogReport(hoursAgo(47), NOW).stale, false);
});

test("two missed runs is a finding", () => {
  assert.equal(watchdogReport(hoursAgo(49), NOW).stale, true);
  assert.equal(watchdogReport(hoursAgo(24 * 7), NOW).stale, true);
});

test("the threshold is two daily runs, not one", () => {
  assert.equal(STALE_AFTER_MS, 48 * 60 * 60 * 1000);
});

test("lastRun is a timestamp, not a boolean", () => {
  assert.match(watchdogReport(hoursAgo(1), NOW).lastRun, /^\d{4}-\d{2}-\d{2}T/);
});

test("every run is recorded durably, in the append-only table", () => {
  // Not a new table: audit_log is already durable and 024's triggers reject
  // UPDATE, DELETE and TRUNCATE on it. And 024 is not yet applied, so adding a
  // migration 025 would make the client's pending action larger for no gain.
  const w = readFileSync(join(ROOT, "server", "watchdog.js"), "utf8");
  assert.match(w, /INSERT INTO audit_log/);
  assert.equal(WATCH_ACTION, "audit.watch");

  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /recordWatchRun\(/, "the run is not recorded");
});

test("a site that did not answer is availability, not drift", () => {
  // Observed on the first live tick against production: 40 routes collapsed to
  // 23 with 27 fetch-failed, while the site was serving 200s throughout — the
  // audit had been run repeatedly in quick succession and was being throttled.
  // Reporting that as "27 findings appeared" is the false alarm TTT1 warns
  // kills a signal.
  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /SITE DID NOT ANSWER/);
  assert.match(sched, /availability, not drift/);
});

test("the alert is sent on drift and never on green — TTT3.3", () => {
  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

  // Anchored on the condition's SHAPE, not its exact text. The first version
  // matched the literal `if (r.regressed || r.degraded)` and broke the moment
  // VVV1.2 added a third term — a test that fails while the code is still
  // correct is the NNN1 failure, and it gets "fixed" by deletion.
  const branchAt = sched.search(/if \(r\.regressed[^)]*\) \{/);
  assert.ok(branchAt > -1, "the drift branch is not recognisable any more");
  const fromBranch = sched.slice(branchAt);
  const elseAt = fromBranch.indexOf("} else {");
  assert.ok(elseAt > -1, "there is no green branch");
  assert.match(fromBranch.slice(0, elseAt), /await alert\(/, "drift does not alert");
  assert.ok(!/alert\(/.test(fromBranch.slice(elseAt)), "an alert is sent when nothing changed");
});

test("VVV1.2 — an unapplied migration alerts at findings severity", () => {
  // Not route-count severity. A migration that has not been applied is a
  // failure: it does not resolve itself, and every hour it stays open is an
  // hour the schema the code expects is not the schema that exists.
  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /checkAppliedSchema/, "the watcher does not check the applied schema");
  assert.match(sched, /if \(r\.regressed \|\| r\.degraded \|\| schema\)/,
    "an unapplied schema must reach the same branch as findings drift");
  assert.match(sched, /could not check the applied schema/, "unable to say must not read as applied");
  // The mislabel this replaced: verdict() passes when there are no credentials,
  // by design, and the first version reported schema: "applied" for a run that
  // never opened a connection.
  assert.match(sched, /schemaState = "not-checked"/, "no credentials must not read as applied");
  assert.match(sched, /schemaState = v\.pass \? "applied" : "not-applied"/);
  assert.match(sched, /readOnlyPool\(/, "the watcher must read production without being able to write");
});

test("the alert applies PP2 discipline", () => {
  // An alert that does not arrive is worse than no alerting, because it is
  // trusted. Intended sends counted, outcome asserted, shortfall loud.
  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /reportNotifications\(\{[\s\S]{0,120}intended: 1/);
});

test("/api/modes reports the heartbeat, and cannot report unknown as healthy", () => {
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  assert.match(app, /watchdogReport\(await lastWatchRunAt\(pool\)\)/);
  // Three states, not two: the read itself can fail, and "unable to say" must
  // not collapse into "fine" — the same argument as no-auth-provider.
  assert.match(app, /stale: null, unavailable/);
});

test("the limitation is stated where it will be read", () => {
  // TTT2.3 — a monitor inside the process it monitors cannot report that the
  // process is gone.
  const w = readFileSync(join(ROOT, "server", "watchdog.js"), "utf8");
  assert.match(w, /cannot report that the\n\/\/ process is gone/);
  assert.match(w, /E-12/, "the limitation must be in the evidence register too");
});
