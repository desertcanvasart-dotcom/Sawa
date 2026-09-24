// PPP1.1 — the watcher, and NNN1's both halves.
//
// The claims audit reached zero on 10 August 2026. Zero is a state, not an
// achievement, and it decays. Every gate in this project is triggered by
// touching the repository, and on that same day two products were added through
// the admin panel — two new routes, new copy — with nothing running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, countByRule, readBaseline } from "../scripts/audit-watch.js";
import { auditWatchBase } from "./jobs/scheduler.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const clean = { routes: 40, findings: {} };

test("it fires when a finding appears with no deploy behind it", () => {
  const r = compare(clean, { routes: 40, findings: { "absolute-claim": 1 } });
  assert.equal(r.regressed, true);
  assert.deepEqual(r.drift, [{ rule: "absolute-claim", was: 0, now: 1 }]);
});

test("it stops on an unchanged production", () => {
  const r = compare(clean, { routes: 40, findings: {} });
  assert.equal(r.regressed, false);
  assert.deepEqual(r.drift, []);
  assert.equal(r.routeChange, null);
});

test("a rule reappearing is visible even when the total is unchanged", () => {
  // Two findings swapping rules keeps the total at two and is not the same
  // state. A total cannot see it; per-rule counts can.
  const r = compare({ routes: 40, findings: { availability: 2 } }, { routes: 40, findings: { "phantom-payment-process": 2 } });
  assert.equal(r.regressed, true);
  assert.deepEqual(r.drift.map((d) => d.rule), ["availability", "phantom-payment-process"]);
});

test("a route appearing is reported but does NOT fail", () => {
  // PPP1.2. The client adds products; that is legitimate and expected. Failing
  // on it would make this noisy within a week and then ignored — the same death
  // as a rule that cannot pass.
  const r = compare(clean, { routes: 42, findings: {} });
  assert.deepEqual(r.routeChange, { was: 40, now: 42 });
  assert.equal(r.regressed, false, "a new product must not be a failure");
});

test("a finding that RESOLVED is drift, and is not a failure", () => {
  const r = compare({ routes: 40, findings: { "absolute-claim": 1 } }, clean);
  assert.equal(r.regressed, false, "the fix may simply not have updated the baseline yet");
  assert.deepEqual(r.drift, [{ rule: "absolute-claim", was: 1, now: 0 }]);
});

test("the committed baseline is the state this commit asserts", () => {
  const b = readBaseline();
  assert.equal(typeof b.routes, "number");
  assert.ok(b.routes > 0, "a baseline of zero routes would make every comparison vacuous");
  assert.deepEqual(b.findings, {}, "the baseline records zero findings; a non-zero one needs a stated reason");
});

test("countByRule counts rules, not findings", () => {
  assert.deepEqual(countByRule([{ rule: "a" }, { rule: "a" }, { rule: "b" }]), { a: 2, b: 1 });
});

test("the scheduled job writes nothing", () => {
  // The whole argument for running it inside the web process. X1's read-only
  // pool raises 25006 on any write whatever the credentials permit, so the worst
  // a bug here can do is report a wrong number.
  const audit = readFileSync(join(ROOT, "scripts", "audit-claims.js"), "utf8");
  assert.match(audit, /readOnlyPool\(\)/, "the auditor no longer uses the read-only connection");

  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /runAuditWatch/, "the audit is not scheduled");
  assert.match(sched, /auditFirst\.unref\(\)/, "the audit timers must not hold the process open");
});

test("the audit tick is offset from the cancel tick", () => {
  // Both hitting the pooler at once has already produced a spurious db-error;
  // its session-mode limit is 15.
  const sched = readFileSync(join(ROOT, "server", "jobs", "scheduler.js"), "utf8");
  assert.match(sched, /setTimeout\(auditTick, FIRST_RUN_DELAY_MS \* \d+\)/);
});

test("the scheduled base is this site, and overridable", () => {
  assert.equal(auditWatchBase({ APP_URL: "https://sawa.tours/" }), "https://sawa.tours");
  assert.equal(auditWatchBase({ AUDIT_WATCH_BASE: "http://localhost:8795" }), "http://localhost:8795");
  assert.equal(auditWatchBase({}), "https://sawa.tours");
});

// ---- 24 Sep 2026: the scheduled watch never read the site ----------------
//
// runAuditWatch took a `base` and used it only to label the alert. The fetch
// came from audit-claims' own argv default, localhost:8795, so all 116
// scheduled runs from 10 Aug failed with 28 fetch-failed while production
// served 200s.
import { createServer } from "node:http";
import { setAuditBase, publicRoutes, coverage } from "../scripts/audit-claims.js";
import { allRoutesFailed, renderWithRetry } from "../scripts/audit-watch.js";

test("the base a caller gives is the base that is fetched", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader("content-type", "application/xml");
    res.end("<urlset><url><loc>https://x/tour/a-tour</loc></url></urlset>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const before = setAuditBase();
  try {
    setAuditBase(`http://127.0.0.1:${server.address().port}/`);
    const routes = await publicRoutes();
    assert.ok(hits.includes("/sitemap.xml"), "the sitemap was not fetched from the given base");
    assert.ok(routes.includes("/tour/a-tour"));
    assert.equal(coverage.degraded, null);
  } finally {
    setAuditBase(before);
    server.close();
  }
});

test("a degraded run does not stay degraded in a long-lived process", async () => {
  const before = setAuditBase();
  try {
    setAuditBase("http://127.0.0.1:1");
    await publicRoutes();
    assert.ok(coverage.degraded, "precondition: the unreachable sitemap marks the run degraded");
    const server = createServer((_req, res) => res.end("<urlset></urlset>"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    setAuditBase(`http://127.0.0.1:${server.address().port}`);
    await publicRoutes();
    server.close();
    assert.equal(coverage.degraded, null, "the previous run's degradation leaked into this one");
  } finally {
    setAuditBase(before);
  }
});

const down = { routes: ["/", "/about"], findings: [
  { rule: "fetch-failed", where: "/" }, { rule: "fetch-failed", where: "/about" }] };
const up = { routes: ["/", "/about"], findings: [] };

test("all routes failing is unreachable; one failing is a finding", () => {
  assert.equal(allRoutesFailed(down), true);
  assert.equal(allRoutesFailed(up), false);
  assert.equal(allRoutesFailed({ routes: ["/", "/about"], findings: [{ rule: "fetch-failed", where: "/about (HTTP 500)" }] }), false);
  assert.equal(allRoutesFailed({ routes: [], findings: [] }), false);
});

test("an unreachable site is retried, and recovers without an alert", async () => {
  const seq = [down, up];
  const slept = [];
  const r = await renderWithRetry(async () => seq.shift(), { delays: [10, 20], sleep: async (ms) => slept.push(ms) });
  assert.equal(r.unreachable, false);
  assert.equal(r.attempts, 2);
  assert.deepEqual(slept, [10]);
});

test("still silent after every retry is reported as unreachable", async () => {
  const slept = [];
  const r = await renderWithRetry(async () => down, { delays: [10, 20], sleep: async (ms) => slept.push(ms) });
  assert.equal(r.unreachable, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(slept, [10, 20]);
});

test("a reachable site is read once, with no waiting", async () => {
  let calls = 0;
  const r = await renderWithRetry(async () => { calls += 1; return up; }, { delays: [10], sleep: async () => { throw new Error("slept"); } });
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
});
