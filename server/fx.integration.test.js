// The automatic EUR/EGP rate (064) on a real Postgres:
//
//   daily fetch     stores the day's rate, its source and when; a second run
//                   the same day fetches nothing
//   failed fetch    keeps the last good rate, alerts the admin once, and the
//                   next good fetch clears the alert
//   > 5% jump       stored as pending, alerted, not used until approved
//   weekly          the traveler rate is renewed from the market less the buffer
//   > 3% move       renews it early
//   locked rate     a booking keeps its rate (pool-model.integration.test.js
//                   books and charges at it; here, the stamp itself)
//   override        needs a reason; recorded in the history and the audit log
//
// No network: every fetch is a stub. Skips without TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_fx";
const DAY = 24 * 3600 * 1000;
const ON = { FEATURES: "catalogue_v2", FX_PROVIDERS: "" };
// 09:00 Cairo on a given day.
const at = (ymd) => Date.parse(`${ymd}T06:00:00Z`);

let db, dbUrl, fakeAuth, server, base, fx;
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const sent = [];
const send = async (m) => { sent.push(m); return { ok: true }; };

// A stub for both providers: Frankfurter's CBE answer and ExchangeRate-API's.
function fetcher({ rate = null, date, fail = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (fail) throw new Error("getaddrinfo ENOTFOUND");
    if (url.includes("frankfurter")) {
      return { ok: true, status: 200, json: async () => ({ date, base: "EUR", quote: "EGP", rate }) };
    }
    return { ok: true, status: 200, json: async () => ({ result: "success", base_code: "EUR", time_last_update_unix: Date.parse(`${date}T00:00:00Z`) / 1000, rates: { EGP: rate } }) };
  };
  impl.calls = calls;
  return impl;
}

async function startServer() {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "catalogue_v2", TURNSTILE_SECRET_KEY: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d; });
  server.stderr.on("data", (d) => { out += d; });
  const b = `http://127.0.0.1:${port}`;
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${b}/api/health`);
      if (r.ok) return b;
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;   // not listening yet — reported below if it never is
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start (${lastError}):\n${out}`);
}

before(async () => {
  if (skip) return;
  const OPS = { id: "00000000-0000-4000-8000-0000000000f1", email: "finance@sawa.test" };
  fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if ((req.headers.authorization || "") !== "Bearer ops-token") { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: OPS.id, email: OPS.email, aud: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));
  dbUrl = await freshDatabase(DB_NAME);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("INSERT INTO app_users (id, email, role) VALUES ($1, $2, 'super_admin')", [OPS.id, OPS.email]);
  // Start from nothing: no rates, no traveler rate (064 may have moved one in).
  await db.query("DELETE FROM fx_rates");
  await db.query("DELETE FROM fx_traveller_rates");
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  fx = await import("./fx.js");
  base = await startServer();
});

after(async () => {
  if (skip) return;
  server?.kill();
  fakeAuth?.close();
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

test("the daily fetch stores the day's rate with its source and a timestamp; the first traveler rate follows, less 3%", { skip }, async () => {
  const f = fetcher({ rate: 50.1234, date: "2026-09-10" });
  const out = await fx.runFxDaily({ db, now: at("2026-09-10"), fetchImpl: f, send, env: ON });
  assert.deepEqual(out.market, { day: "2026-09-10", egpPerEur: 50.1234, source: "frankfurter-cbe", status: "approved" });
  const row = await one("SELECT * FROM fx_rates WHERE day = '2026-09-10'");
  assert.deepEqual([Number(row.egp_per_eur), row.status, row.source, row.entered_by], [50.1234, "approved", "frankfurter-cbe", "fx-daily"]);
  assert.match(row.source_note, /Central Bank of Egypt/);
  assert.ok(row.fetched_at instanceof Date, "when it was fetched");
  assert.equal(f.calls.length, 1, "the CBE source answered; the fallback wasn't asked");
  // The first traveler rate: 50.1234 × 0.97 = 48.6197, down to 48.61.
  assert.equal(out.traveller.changed.egpPerEur, 48.61);
  assert.equal(out.traveller.changed.reason, "initial");
  // Run again the same day: nothing fetched, nothing changed.
  const again = fetcher({ rate: 99, date: "2026-09-10" });
  const out2 = await fx.runFxDaily({ db, now: at("2026-09-10") + 6 * 3600 * 1000, fetchImpl: again, send, env: ON });
  assert.match(out2.market.skipped, /already has a rate/);
  assert.equal(again.calls.length, 0);
});

test("the fallback source is used when CBE's fails, and says so", { skip }, async () => {
  const f = async (url) => (url.includes("frankfurter")
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ result: "success", base_code: "EUR", time_last_update_unix: at("2026-09-11") / 1000, rates: { EGP: 50.2 } }) });
  const out = await fx.runFxDaily({ db, now: at("2026-09-11"), fetchImpl: f, send, env: ON });
  assert.deepEqual([out.market.egpPerEur, out.market.source], [50.2, "exchangerate-api"]);
});

test("a failed fetch keeps the last good rate and alerts the admin once; the next good fetch clears the alert", { skip }, async () => {
  sent.length = 0;
  const out = await fx.runFxDaily({ db, now: at("2026-09-12"), fetchImpl: fetcher({ fail: true }), send, env: ON });
  assert.equal(out.market.lastGood, "2026-09-11");
  assert.equal((await db.query("SELECT 1 FROM fx_rates WHERE day = '2026-09-12'")).rowCount, 0, "nothing stored");
  assert.equal((await fx.latestApprovedFx(db)).egpPerEur, 50.2, "the last good rate stays in use");
  const [alert] = await fx.openFxAlerts(db);
  assert.equal(alert.kind, "fetch_failed");
  assert.deepEqual(alert.detail.lastGood, { day: "2026-09-11", egpPerEur: 50.2 });
  assert.equal(alert.detail.errors.length, 2, "both sources' errors");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /not fetched for 2026-09-12: still using 50.2/);
  // Failing again later the same day: the same alert, no second email.
  await fx.runFxDaily({ db, now: at("2026-09-12") + 6 * 3600 * 1000, fetchImpl: fetcher({ fail: true }), send, env: ON });
  assert.equal((await fx.openFxAlerts(db)).length, 1);
  assert.equal(sent.length, 1, "emailed once");
  // A good fetch resolves it.
  await fx.runFxDaily({ db, now: at("2026-09-12") + 12 * 3600 * 1000, fetchImpl: fetcher({ rate: 50.3, date: "2026-09-12" }), send, env: ON });
  assert.equal((await fx.openFxAlerts(db)).length, 0);
});

test("a stale answer (the source stopped updating) counts as a failed fetch", { skip }, async () => {
  // (Flag off here, so the clock jump doesn't renew the traveler rate.)
  const out = await fx.runFxDaily({ db, now: at("2026-09-20"), fetchImpl: fetcher({ rate: 50.3, date: "2026-09-01" }), send, env: { FEATURES: "" } });
  assert.match(out.market.failed, /more than 5 days old/);
  await db.query("UPDATE fx_alerts SET resolved_at = now() WHERE resolved_at IS NULL");
});

test("a rate more than 5% from the previous day's waits for approval and isn't used until approved", { skip }, async () => {
  sent.length = 0;
  const out = await fx.runFxDaily({ db, now: at("2026-09-13"), fetchImpl: fetcher({ rate: 53.5, date: "2026-09-13" }), send, env: ON });
  assert.equal(out.market.status, "pending", "53.5 is 6.4% from 50.3");
  assert.equal((await fx.latestApprovedFx(db)).egpPerEur, 50.3, "still the previous rate");
  const statement = await import("./commissions.js");
  assert.equal((await db.query("SELECT egp_per_eur FROM fx_rates WHERE day = '2026-09-13' AND status = 'approved'")).rowCount, 0);
  assert.ok(statement, "commission statements read only approved rows (commissions.js)");
  const [alert] = await fx.openFxAlerts(db);
  assert.deepEqual([alert.kind, alert.detail.changePct, alert.detail.previous.egpPerEur], ["rate_pending", 6.36, 50.3]);
  assert.match(sent[0].subject, /waiting for approval: 53.5/);
  // The traveler rate didn't move on it either.
  assert.equal((await fx.currentTravellerRate(db)).egpPerEur, 48.61);
  // Approved: used from now on, and the alert closes. 53.5 is 10% from the
  // traveler rate's base (50.1234), so it is renewed at once.
  const ok = await fx.decideFxRate(db, { day: "2026-09-13", approve: true, by: "finance@sawa.test", now: at("2026-09-13") + 3600 * 1000, env: ON });
  assert.equal(ok.rate.status, "approved");
  assert.equal((await fx.latestApprovedFx(db)).egpPerEur, 53.5);
  assert.equal((await fx.openFxAlerts(db)).length, 0);
  assert.deepEqual([ok.traveller.changed.egpPerEur, ok.traveller.changed.reason], [51.89, "market_move"], "53.5 × 0.97 = 51.895, down");
  // A rejected one is kept for the record and never used.
  await fx.runFxDaily({ db, now: at("2026-09-14"), fetchImpl: fetcher({ rate: 40, date: "2026-09-14" }), send, env: ON });
  await fx.decideFxRate(db, { day: "2026-09-14", approve: false, by: "finance@sawa.test", env: ON });
  assert.equal((await one("SELECT status FROM fx_rates WHERE day = '2026-09-14'")).status, "rejected");
  assert.equal((await fx.latestApprovedFx(db)).egpPerEur, 53.5);
  await assert.rejects(fx.decideFxRate(db, { day: "2026-09-14", approve: true, by: "x", env: ON }), /no rate waiting/);
});

test("the weekly update renews the traveler rate from the market less the buffer; a changed buffer applies from then", { skip }, async () => {
  const current = await fx.currentTravellerRate(db);
  await fx.setTravellerBuffer(db, { bufferPct: 4, by: "finance@sawa.test" });
  // Six days on, the market 1% up: nothing due.
  await db.query("INSERT INTO fx_rates (day, egp_per_eur, status, source) VALUES ('2026-09-19', 54.0, 'approved', 'manual')");
  const early = await fx.updateTravellerRate(db, { now: Date.parse(current.effectiveAt) + 6 * DAY });
  assert.equal(early.kept, 51.89);
  // Seven days on: weekly, at the new buffer. 54.0 × 0.96 = 51.84.
  const week = await fx.updateTravellerRate(db, { now: Date.parse(current.effectiveAt) + 7 * DAY });
  assert.deepEqual([week.changed.egpPerEur, week.changed.reason, week.changed.bufferPct, week.changed.marketEgpPerEur], [51.84, "weekly", 4, 54]);
  await fx.setTravellerBuffer(db, { bufferPct: 3, by: "finance@sawa.test" });
  await assert.rejects(fx.setTravellerBuffer(db, { bufferPct: 25, by: "x" }), /between 0% and 20%/);
});

test("a market move of more than 3% renews the traveler rate early; 3% or less waits for the week", { skip }, async () => {
  const current = await fx.currentTravellerRate(db);
  const t0 = Date.parse(current.effectiveAt);
  await db.query("INSERT INTO fx_rates (day, egp_per_eur, status, source) VALUES ('2026-09-27', 55.5, 'approved', 'manual')");
  assert.equal((await fx.updateTravellerRate(db, { now: t0 + DAY })).kept, 51.84, "55.5 is 2.8% from 54");
  await db.query("INSERT INTO fx_rates (day, egp_per_eur, status, source) VALUES ('2026-09-28', 55.8, 'approved', 'manual')");
  const moved = await fx.updateTravellerRate(db, { now: t0 + 2 * DAY });
  assert.deepEqual([moved.changed.egpPerEur, moved.changed.reason, moved.from], [54.12, "market_move", 51.84], "55.8 is 3.3% from 54; × 0.97 = 54.126");
  // Each change is recorded with its date.
  const history = await fx.travellerRateHistory(db);
  assert.deepEqual(history.slice(0, 4).map((h) => h.reason), ["market_move", "weekly", "market_move", "initial"]);
  assert.ok(history.every((h) => h.effectiveAt));
});

test("with catalogue_v2 off the market rate is still fetched, and the traveler rate is left alone", { skip }, async () => {
  const before = await fx.currentTravellerRate(db);
  const out = await fx.runFxDaily({ db, now: at("2026-10-05"), fetchImpl: fetcher({ rate: 58, date: "2026-10-05" }), send, env: { FEATURES: "" } });
  assert.equal(out.market.status, "approved");
  assert.match(out.traveller.skipped, /catalogue_v2 is off/);
  assert.equal((await fx.currentTravellerRate(db)).id, before.id);
});

test("a booking stores the traveler rate in force when it is made, and keeps it when the rate changes", { skip }, async () => {
  // The stamp reads the current rate; pool-model.integration.test.js books
  // and charges end to end at it.
  const locked = (await fx.currentTravellerRate(db)).egpPerEur;
  await fx.overrideTravellerRate(db, { egpPerEur: 60, reason: "test: later", by: "it" });
  assert.equal((await fx.currentTravellerRate(db)).egpPerEur, 60);
  assert.notEqual(locked, 60);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "server", "pool-settlement.js"), "utf8");
  assert.match(src, /currentTravellerRate\(c\)/, "stamped from the site-wide rate");
  assert.match(src, /eurRate: Number\(pledge\.published_eur_rate\)/, "charged at the booking's own rate");
});

test("a manual override needs a reason and is logged: in the rate's history and the audit log", { skip }, async () => {
  const post = (body) => fetch(`${base}/api/admin/finance/traveller-rate/override`, {
    method: "POST", headers: { Authorization: "Bearer ops-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const noReason = await post({ egpPerEur: 52.4 });
  assert.equal(noReason.status, 422);
  assert.match((await noReason.json()).error, /Say why/);
  const r = await post({ egpPerEur: 52.4, reason: "CBE auction moved the market this morning" });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.deepEqual([body.egpPerEur, body.reason, body.note, body.setBy], [52.4, "override", "CBE auction moved the market this morning", "finance@sawa.test"]);
  const audit = await one("SELECT * FROM audit_log WHERE action = 'finance.traveller_rate.override' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.actor_email, "finance@sawa.test");
  assert.equal(Number(audit.detail.egpPerEur), 52.4);
  assert.equal(audit.detail.note, "CBE auction moved the market this morning");
  // The Finance screen shows it in force, with the history.
  const overview = await (await fetch(`${base}/api/admin/finance/fx`, { headers: { Authorization: "Bearer ops-token" } })).json();
  assert.deepEqual([overview.traveller.egpPerEur, overview.traveller.reason, overview.history[0].note], [52.4, "override", "CBE auction moved the market this morning"]);
  // The database refuses an override without a reason even past the API.
  await assert.rejects(db.query("INSERT INTO fx_traveller_rates (egp_per_eur, reason) VALUES (50, 'override')"), /fx_traveller_override_reason/);
});
