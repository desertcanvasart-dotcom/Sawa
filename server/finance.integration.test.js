// Model phase 3 on a real Postgres: the rate card's currencies, required
// booking details and the completion requests, commission locked at booking
// and decided at the trip, agency billing, the operator advance and balance,
// adjustments and the cap, statements (auto-acceptance, dispute and
// resolution), bank details gating payment, payment recording, monthly
// commission statements, the margin report and parity with catalogue_v2 off.
// Skips without TEST_DATABASE_URL (see test-db.js).
//
// The tests share one database and run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { zonedDateTimeToUtc } from "./tz.js";
import { shiftDate } from "../shared/catalogue.js";
import { egyptBusinessDaysAfter } from "../shared/settlement-rules.js";
import { statementPdf } from "./pdf.js";

const statementPdfText = (st) => statementPdf(st).toString("latin1");

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_finance";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000071", email: "boss@sawa.test", role: "super_admin" },
  "staff-token": { id: "00000000-0000-4000-8000-000000000072", email: "finance@sawa.test", role: "ops_staff" },
  "ag-a-token": { id: "00000000-0000-4000-8000-000000000073", email: "owner@agency-a.test", role: "agency_owner", agency: "ag_a" },
  "ag-b-token": { id: "00000000-0000-4000-8000-000000000074", email: "owner@agency-b.test", role: "agency_owner", agency: "ag_b" },
  "op-token": { id: "00000000-0000-4000-8000-000000000075", email: "owner@nile-tours.test", role: "operator_owner" },
};
const ADMIN = { id: USERS["ops-token"].id, email: USERS["ops-token"].email, role: "super_admin" };
const STAFF = { id: USERS["staff-token"].id, email: USERS["staff-token"].email, role: "ops_staff" };

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, roster, rates, asg, settle, fin, bank, comm, details, jobs, pag;
let productId, X;
const deps = {};
const sent = [];
const send = async (m) => { sent.push(m); return { ok: true }; };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function startServer(extraEnv) {
  // A port nothing is listening on: a random one could land on the other
  // server this suite started, and the health check would answer from it.
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(proc);
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return base;
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
  fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    if (!u) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));

  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("TRUNCATE catalogue_products CASCADE");
  await db.query("TRUNCATE operators CASCADE");
  await db.query(
    `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                booking_cutoff_hours, included, not_included)
     VALUES ($1,'day_tour','Giza Pyramids, Sphinx & the Grand Egyptian Museum','Cairo','08:00',4,12,100,80,'approved',true,24,'["Guide"]','["Tips"]')`, [GIZA]);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  await db.query(`INSERT INTO agencies (id, name, billing_approved, billing_due_days) VALUES ('ag_a', 'Agency A', true, 14)`);
  await db.query(`INSERT INTO agencies (id, name, country_code) VALUES ('ag_b', 'Cairo Agency B', 'EG')`);
  for (const u of Object.values(USERS)) {
    if (u.role === "operator_owner") continue;
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency || null]);
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  process.env.EMAIL_REPLY_TO = "ops-alerts@sawa.test";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  roster = await import("./roster.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  settle = await import("./operator-settlement.js");
  fin = await import("./finance.js");
  bank = await import("./bank-details.js");
  comm = await import("./commissions.js");
  details = await import("./booking-details.js");
  jobs = await import("./jobs/operator-jobs.js");
  pag = await import("./pay-at-goahead.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await db.query("UPDATE catalogue_products SET needs_nationality = true WHERE id = $1", [productId]);
  await cat.generateDepartures({ materialise: true });

  // One operator, active, approved, rostered on the month's dates.
  X = (await ops.createOperator(db, { legalName: "Nile Tours S.A.E.", email: "dispatch@nile-tours.test" }, "it")).id;
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, X, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await ops.setApprovals(db, X, [productId], "it");
  await ops.setOperatorStatus(db, X, "active", { by: "it" });
  await db.query("INSERT INTO app_users (id, email, role, operator_id) VALUES ($1, $2, 'operator_owner', $3)",
    [USERS["op-token"].id, USERS["op-token"].email, X]);

  const month = shiftDate(today(), 45).slice(0, 7);
  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND to_char(date, 'YYYY-MM') = $2
      ORDER BY date LIMIT 9`, [productId, month]);
  assert.ok(r.rows.length >= 9, `need nine departures in ${month}`);
  [deps.a, deps.b, deps.c, deps.d, deps.e, deps.f, deps.g, deps.h, deps.i] = r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), legacy: x.legacy_departure_id }));
  deps.month = month;
  for (const d of [deps.a, deps.b]) await roster.overrideEntry(db, { productId, date: d.date, operatorId: X, by: "it" });
  await roster.publishMonth(db, month, { by: "it" });
});

after(async () => {
  if (skip) return;
  for (const s of servers) s.kill();
  fakeAuth?.close();
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

let seq = 0;
async function pledge(dep, seats, extra = {}) {
  const id = `pl_fin_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  const names = extra.names || Array.from({ length: seats }, (_, i) => `Traveler ${seq}.${i + 1}`);
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source,
                          pickup_point, nationality, safety_needs, traveller_names, booking_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed','public',$9,$10,$11,$12,$13)`,
    [id, dep.legacy, extra.agencyId || "direct_customer", extra.agency || "Direct", seats, names[0], extra.email ?? "t@example.test",
      extra.phone === undefined ? "+201000000000" : extra.phone, extra.pickup === undefined ? "Mena House" : extra.pickup,
      extra.nationality === undefined ? "Brazilian" : extra.nationality, extra.safety === undefined ? "None" : extra.safety,
      JSON.stringify(extra.noNames ? [] : names), 100 * seats]);
  return id;
}
const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const cutoffOf = async (dep) => {
  const hours = Number((await db.query("SELECT cutoff_hours FROM catalogue_products WHERE id = $1", [productId])).rows[0].cutoff_hours);
  return zonedDateTimeToUtc(dep.date, "08:00") - hours * HOUR;
};
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

// ---------------------------------------------------------------- A. rate card
test("the rate card imports with commission in EUR and operator amounts in EGP, without the old USD warning", { skip }, async () => {
  const out = await rates.importRateCard({ db, buffer: readFileSync(join(ROOT, "docs", "model", "sawa-rate-card.xlsx")), by: "it" });
  assert.equal(out.imported.length, 21);
  assert.equal(out.skipped.filter((s) => s.reason === "EXAMPLE row").length, 2);
  assert.ok(!out.notes.some((n) => /USD/.test(n)), out.notes.join("\n"));
  const draft = (await rates.ratesFor(db, productId)).find((v) => v.state === "draft");
  assert.equal(draft.currency, "EGP");
  assert.equal(draft.commissionCurrency, "EUR");
  // The first catalog rates: 40 per traveler, fees 150/200/260 EGP, commission 12 EUR per seat.
  await rates.saveRateDraft(db, productId, { perTraveler: 40, fee4_6: 150, fee7_9: 200, fee10_12: 260, commissionPerSeat: 12 }, { by: "it" });
  const v1 = await rates.publishRate({ productId, versionId: draft.id, by: "it" });
  assert.equal(v1.commissionPerSeat, 12);
  await assert.rejects(db.query("UPDATE catalogue_rate_versions SET commission_currency = 'EGP' WHERE id = $1", [v1.id]));
});

// ---------------------------------------------------------------- B. booking data
test("under the flag a catalog booking needs every traveler's details; commission locks and the agency is invoiced", { skip }, async () => {
  const on = await startServer({ FEATURES: "catalogue_v2" });
  const book = (token, body) => fetch(`${on}/api/departures/${deps.a.legacy}/pledges`, { method: "POST", headers: auth(token), body: JSON.stringify(body) });
  const lacking = await book("ag-a-token", { seats: 2, customers: "A-2-2", customerEmail: "c@example.test", customerPhone: "+201001112233" });
  assert.equal(lacking.status, 422);
  assert.match((await lacking.json()).error, /every traveler's name.*pickup point.*nationality.*safety needs/);
  const noNone = await book("ag-a-token", { seats: 2, customers: "A-2-2", customerPhone: "+201001112233", travelerNames: ["Ana Lima", "Bo Lima"], pickupPoint: "Mena House", nationality: "Brazilian" });
  assert.equal(noNone.status, 422, "safety needs are asked every time");
  const ok = await book("ag-a-token", {
    seats: 2, customers: "A-2-2", customerEmail: "c@example.test", customerPhone: "+201001112233",
    travelerNames: ["Ana Lima", "Bo Lima"], pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true,
  });
  assert.equal(ok.status, 201, await ok.text());
  const p = await one("SELECT * FROM pledges WHERE departure_id = $1 AND agency_id = 'ag_a' ORDER BY created_at DESC LIMIT 1", [deps.a.legacy]);
  deps.a.agencyPledge = p.id;
  assert.equal(p.safety_needs, "None");
  assert.deepEqual(p.traveller_names, ["Ana Lima", "Bo Lima"]);

  // Commission locked from the rate version in force: 12 EUR × 2 seats.
  const c = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [p.id]);
  assert.equal(Number(c.per_seat_eur), 12);
  assert.equal(Number(c.amount_eur), 24);
  assert.equal(c.state, "pending");
  // Agency billing: invoiced the published price less commission, and the
  // seats count toward GoAhead from booking.
  const inv = await one("SELECT * FROM agency_invoices WHERE pledge_id = $1", [p.id]);
  assert.equal(Number(inv.amount_eur), Number(p.booking_total) - 24);
  // Model phase 4: every catalog booking under the flag pays at GoAhead, so
  // the invoice has no due date until the payment deadline after GoAhead.
  assert.equal(inv.due_on, null);
  assert.equal(p.payment_mode, "pay_at_goahead");
  assert.equal(p.terms_fixed_by, "agency");
  assert.equal(Number((await one("SELECT seats_sold FROM catalogue_departure_seats WHERE catalogue_departure_id = $1", [deps.a.id])).seats_sold), 2);

  // A later rate version doesn't change a locked commission.
  const v2 = await rates.saveRateDraft(db, productId, { commissionPerSeat: 20 }, { by: "it" });
  await rates.publishRate({ productId, versionId: v2.id, by: "it" });
  assert.equal(Number((await one("SELECT amount_eur FROM agency_commissions WHERE pledge_id = $1", [p.id])).amount_eur), 24);

  // Agency B (no billing) books on departure B: commission, no invoice.
  const b = await fetch(`${on}/api/departures/${deps.b.legacy}/pledges`, { method: "POST", headers: auth("ag-b-token"), body: JSON.stringify({
    seats: 1, customers: "B-1-1", customerPhone: "+201009998877", travelerNames: ["Omar Said"], pickupPoint: "Zamalek", nationality: "Egyptian", safetyNeeds: "Uses a cane",
  }) });
  assert.equal(b.status, 201, await b.text());
  const bp = await one("SELECT id FROM pledges WHERE departure_id = $1 AND agency_id = 'ag_b'", [deps.b.legacy]);
  deps.b.agencyPledge = bp.id;
  assert.equal(Number((await one("SELECT per_seat_eur FROM agency_commissions WHERE pledge_id = $1", [bp.id])).per_seat_eur), 20, "the version in force at this booking");
  assert.equal(await one("SELECT 1 FROM agency_invoices WHERE pledge_id = $1", [bp.id]), undefined);

  // With the flag off the same booking without details goes through as today.
  const off = await startServer({ FEATURES: "" });
  const plain = await fetch(`${off}/api/departures/${deps.e.legacy}/pledges`, { method: "POST", headers: auth("ag-a-token"), body: JSON.stringify({ seats: 1, customers: "A-1-3" }) });
  assert.equal(plain.status, 201, await plain.text());
  const pp = await one("SELECT id FROM pledges WHERE departure_id = $1 AND agency_id = 'ag_a'", [deps.e.legacy]);
  assert.equal(await one("SELECT 1 FROM agency_commissions WHERE pledge_id = $1", [pp.id]), undefined, "no commission record with the flag off");
  assert.equal(await one("SELECT 1 FROM agency_invoices WHERE pledge_id = $1", [pp.id]), undefined);
  for (const path of ["/api/agency/commissions", "/api/operator/statements", "/api/public/booking-details/abc"]) {
    const token = path.includes("agency") ? "ag-a-token" : "op-token";
    assert.equal((await fetch(`${off}${path}`, { headers: auth(token) })).status, 404, `${path} with the flag off`);
  }
  await db.query("DELETE FROM pledges WHERE id = $1", [pp.id]);
});

test("bookings missing details get a private link 7 days before and a reminder at 3, once each", { skip }, async () => {
  const lacking = await pledge(deps.d, 2, { noNames: true, pickup: null, safety: null, email: "late@example.test" });
  const at = (daysBefore) => zonedDateTimeToUtc(shiftDate(deps.d.date, -daysBefore), "10:00");
  sent.length = 0;
  assert.equal((await details.runCompletionRequests({ now: at(9), send })).requested, 0, "not yet: 9 days out");
  const first = await details.runCompletionRequests({ now: at(6), send });
  assert.equal(first.requested, 1, JSON.stringify(first));
  const mail = sent.find((m) => m.to === "late@example.test");
  assert.match(mail.subject, /^Details needed/);
  assert.match(mail.text, /every traveler's name, a pickup point, health or safety needs/);
  const token = /\/booking-details\/([A-Za-z0-9_-]+)/.exec(mail.text)[1];
  assert.equal((await details.runCompletionRequests({ now: at(5), send })).requested, 0, "sent once");
  assert.equal((await details.runCompletionRequests({ now: at(4), send })).reminded, 0, "no reminder before 3 days");
  const rem = await details.runCompletionRequests({ now: at(2), send });
  assert.equal(rem.reminded, 1);
  assert.match(sent[sent.length - 1].subject, /^Reminder/);
  assert.equal((await details.runCompletionRequests({ now: at(1), send })).reminded, 0, "the reminder, once");

  // The manifest marks what is missing.
  const rows = asg.manifestRows([await one("SELECT * FROM pledges WHERE id = $1", [lacking])], { needsNationality: true });
  assert.deepEqual(rows[0].missing, ["name", "pickupPoint", "safetyNeeds"]);

  // The link completes it, over HTTP, with the same rule.
  const on = await startServer({ FEATURES: "catalogue_v2" });
  const page = await (await fetch(`${on}/api/public/booking-details/${token}`)).json();
  assert.equal(page.seats, 2);
  assert.equal(page.needsNationality, true);
  const half = await fetch(`${on}/api/public/booking-details/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ travelerNames: ["Cy"], pickupPoint: "Mena House", safetyNone: true }) });
  assert.equal(half.status, 422);
  const done = await fetch(`${on}/api/public/booking-details/${token}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ travelerNames: ["Cy Ode", "Di Ek"], customerPhone: "+201002223344", pickupPoint: "Mena House", nationality: "Kenyan", safetyNone: true }) });
  assert.equal(done.status, 200, await done.text());
  assert.deepEqual(details.missingForPledge(await one("SELECT * FROM pledges WHERE id = $1", [lacking]), { needsNationality: true }), []);
  assert.equal((await fetch(`${on}/api/public/booking-details/not-a-token`)).status, 404);
});

// ---------------------------------------------------------------- D. operator settlement
test("acknowledging creates a 50% advance due 2 Egyptian business days later", { skip }, async () => {
  // A public holiday tomorrow moves the due date.
  await fin.setHoliday(db, { day: shiftDate(today(), 1), name: "Test holiday", by: "it" });
  for (const d of [deps.a, deps.b]) {
    const have = Number((await one("SELECT COALESCE(SUM(seats), 0) AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [d.legacy])).n);
    for (let n = have; n < 8; n += 2) await pledge(d, Math.min(2, 8 - n));
  }
  deps.a.early = await one("SELECT id FROM pledges WHERE departure_id = $1 AND agency_id = 'direct_customer' ORDER BY created_at LIMIT 1", [deps.a.legacy]);
  await cat.runStatusJob({});
  const now = Date.now();
  const tick = await asg.runAssignmentTick({ now, send });
  assert.equal(tick.assigned, 2, JSON.stringify(tick));
  const holidays = new Set([shiftDate(today(), 1)]);
  for (const d of [deps.a, deps.b]) {
    const a = await one("SELECT * FROM catalogue_assignments WHERE departure_id = $1", [d.id]);
    d.assignment = Number(a.id);
    await asg.acknowledge(db, { assignmentId: d.assignment, operatorId: X, by: "dispatch", now: now + HOUR });
    const adv = await one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [d.assignment]);
    assert.equal(Number(adv.amount), 260, "50% of 8 × 40 + 200");
    assert.equal(ymd(adv.due_on), egyptBusinessDaysAfter(today(), 2, holidays));
    assert.equal(adv.state, "due");
    d.advance = Number(adv.id);
  }
});

test("the balance is the final amount from the frozen manifest less the advance: 390 − 260 and 520 − 260", { skip }, async () => {
  // Departure A: two cancel before the cut-off → 6 travelers, 390.
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [deps.a.early.id]);
  for (const d of [deps.a, deps.b]) await asg.freezeManifests({ db, now: (await cutoffOf(d)) + 60000 });
  // Departure B: two cancel after the cut-off → still 8 on the frozen manifest.
  const lateB = await one("SELECT id FROM pledges WHERE departure_id = $1 AND agency_id = 'direct_customer' ORDER BY created_at LIMIT 1", [deps.b.legacy]);
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [lateB.id]);
  await db.query("UPDATE catalogue_departures SET status = 'completed' WHERE id = ANY($1::bigint[])", [[deps.a.id, deps.b.id]]);
  const t = await settle.runSettlementTick({});
  assert.equal(t.balancesCreated, 2);
  const balA = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [deps.a.id]);
  const balB = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [deps.b.id]);
  assert.equal(Number(balA.amount), 130, "6 × 40 + 150 = 390, less the 260 advance");
  assert.equal(Number(balB.amount), 260, "8 × 40 + 200 = 520, less the 260 advance");
  assert.equal(ymd(balB.due_on), shiftDate(deps.b.date, 7), "7 days after the departure ends");
  deps.a.balance = Number(balA.id);
  deps.b.balance = Number(balB.id);
  assert.equal((await settle.statementFor(db, deps.b.id)).state, "draft");
  assert.equal((await settle.runSettlementTick({})).balancesCreated, 0, "once");
});

test("adjustments: deductions are capped at the operator amount; penalties use the configured amount; reimbursements point at the cost sheet", { skip }, async () => {
  const add = (x) => settle.addAdjustment(db, { departureId: deps.b.id, by: "ops", ...x });
  await assert.rejects(add({ kind: "service_failure", amountEgp: 600, reason: "missed the museum", clauseRef: "12.2" }), /capped at the operator amount/);
  await add({ kind: "service_failure", amountEgp: 100, reason: "late pickup, refund to two travelers", clauseRef: "Operator 12.2", evidence: ["receipt:sawa/1-x.pdf"] });
  const zero = await add({ kind: "penalty", penaltyCode: "no_show", reason: "guide did not turn up for 1 hour" });
  assert.equal(zero.amountEgp, 0, "0 until the amount is set");
  await fin.setPenaltyRate(db, { code: "no_show", amountEgp: 50, by: "it" });
  await add({ kind: "penalty", penaltyCode: "no_show", reason: "second incident" });
  await assert.rejects(add({ kind: "service_failure", amountEgp: 400, reason: "x", clauseRef: "12.2" }), /At most EGP 370 more/);
  await assert.rejects(add({ kind: "reimbursement", amountEgp: 30, reason: "closed site", clauseRef: "14", costLineIds: [999] }), /approved line/);
  const line = await one(
    `INSERT INTO departure_costs (departure_id, category, description, amount, state, approved_amount, reviewed_at) VALUES ($1, 'entrance', 'Tickets, site closed', 10, 'approved', 10, now()) RETURNING id`, [deps.b.legacy]);
  await add({ kind: "reimbursement", amountEgp: 30, reason: "site closed by authorities; tickets non-refundable", clauseRef: "Operator 14", costLineIds: [Number(line.id)] });
  const bal = await one("SELECT amount FROM operator_payables WHERE id = $1", [deps.b.balance]);
  assert.equal(Number(bal.amount), 520 - 150 + 30 - 260, "520 − (100 + 0 + 50) + 30 − 260");
  const snap = (await settle.statementFor(db, deps.b.id)).snapshot;
  assert.equal(snap.balance, 140);
  assert.equal(snap.adjustments.length, 4);
  assert.equal(snap.band, "7-9");
  assert.equal(snap.travelers.length, 8);
  // Departure B's first seat sold after version 2 (a commission change) was
  // published, so it is locked to version 2; the operator amounts are the same.
  assert.equal(snap.rateVersion.version, 2);
});

test("a statement is accepted automatically 30 days after sending; a dispute holds payment until it is resolved", { skip }, async () => {
  sent.length = 0;
  const st = await settle.sendStatement(db, { departureId: deps.b.id, by: "ops", send });
  assert.equal(st.state, "sent");
  assert.ok(sent.some((m) => m.to === "dispatch@nile-tours.test" && /Settlement statement/.test(m.subject)));
  await assert.rejects(settle.addAdjustment(db, { departureId: deps.b.id, kind: "service_failure", amountEgp: 1, reason: "late", clauseRef: "12.2", by: "ops" }), /statement is sent/);
  const sentAt = new Date(st.sentAt).getTime();
  assert.equal((await settle.autoAcceptStatements({ db, now: sentAt + 29 * DAY })).statementsAccepted, 0);
  assert.equal((await settle.autoAcceptStatements({ db, now: sentAt + 30 * DAY + HOUR })).statementsAccepted, 1);
  const accepted = await settle.statementFor(db, deps.b.id);
  assert.deepEqual([accepted.state, accepted.autoAccepted], ["accepted", true]);
  await assert.rejects(settle.disputeStatement(db, { departureId: deps.b.id, operatorId: X, reason: "too late now", by: "x" }), /not yet accepted/);

  await settle.sendStatement(db, { departureId: deps.a.id, by: "ops" });
  const disputed = await settle.disputeStatement(db, { departureId: deps.a.id, operatorId: X, reason: "We ran with 6, but the guide fee rose.", by: "owner@nile-tours.test" });
  assert.equal(disputed.state, "disputed");
  deps.a.disputed = true;
});

// ---------------------------------------------------------------- C. bank details and payments
test("no payment without verified bank details; a change blocks payment until it is verified", { skip }, async () => {
  const pay = (x, user = STAFF) => fin.recordPayment(db, { kind: "operator_payable", paidOn: today(), bankReference: "CIB-001", user, ...x });
  await assert.rejects(pay({ id: deps.b.advance, amount: 260 }), /no verified bank details/);
  await assert.rejects(bank.submitBankDetails(db, X, { holderName: "Someone Else", bankName: "CIB", iban: "EG380019000500000000263180002" }, { user: ADMIN }), /legal name/);
  sent.length = 0;
  const acct = await bank.submitBankDetails(db, X, { holderName: "Nile Tours SAE", bankName: "CIB", iban: "EG38 0019 0005 0000 0000 2631 80002" },
    { user: { id: USERS["op-token"].id, email: "owner@nile-tours.test", role: "operator_owner" }, send, adminEmail: "ops-alerts@sawa.test" });
  assert.equal(acct.state, "pending");
  assert.deepEqual(sent.map((m) => m.to).sort(), ["dispatch@nile-tours.test", "ops-alerts@sawa.test", "owner@nile-tours.test"]);
  assert.ok(!sent.some((m) => m.text.includes("EG380019")), "no account number in an email");
  await assert.rejects(pay({ id: deps.b.advance, amount: 260 }), /haven't been verified/);
  await bank.decideBankDetails(db, acct.id, { approve: true, user: ADMIN });

  // A different amount: refused, then only a super admin may override, with a reason.
  await assert.rejects(pay({ id: deps.b.advance, amount: 250 }), (e) => e.status === 409 && e.warning?.due === 260);
  await assert.rejects(pay({ id: deps.b.advance, amount: 250, override: true, overrideReason: "bank fee" }), /Only a super admin/);
  const p = await pay({ id: deps.b.advance, amount: 250, override: true, overrideReason: "bank fee withheld" }, ADMIN);
  assert.equal(p.differs, true);
  assert.equal((await one("SELECT state FROM operator_payables WHERE id = $1", [deps.b.advance])).state, "paid");
  assert.equal(Number((await one("SELECT bank_account_id FROM finance_payments WHERE payable_id = $1 AND payable_kind = 'operator_payable'", [deps.b.advance])).bank_account_id), acct.id);
  await assert.rejects(pay({ id: deps.b.advance, amount: 250 }), /Already paid/);

  // The disputed balance can't be paid; resolved, it can.
  await pay({ id: deps.a.advance, amount: 260 });
  await assert.rejects(pay({ id: deps.a.balance, amount: 130 }), /disputes this statement/);
  const resolved = await settle.resolveStatement(db, { departureId: deps.a.id, note: "Rate card applies; no change.", by: "ops" });
  assert.equal(resolved.state, "resolved");

  // A new change of details holds payment again until verified.
  const change = await bank.submitBankDetails(db, X, { holderName: "Nile Tours S.A.E.", bankName: "NBE", accountNumber: "1234567890" }, { user: ADMIN });
  await assert.rejects(pay({ id: deps.a.balance, amount: 130 }), /haven't been verified/);
  await bank.decideBankDetails(db, change.id, { approve: true, user: ADMIN });
  assert.equal((await pay({ id: deps.a.balance, amount: 130 })).amount, 130);

  // Every view and change is logged.
  await bank.bankAccountsFor(db, X, { user: ADMIN });
  const log = (await db.query("SELECT action FROM operator_bank_access_log WHERE operator_id = $1 ORDER BY id", [X])).rows.map((r) => r.action);
  assert.deepEqual(log, ["submit", "verify", "submit", "verify", "view"]);
});

// ---------------------------------------------------------------- E. commission
test("commission is earned when the traveler travels, 50% on a late cancellation, nothing without GoAhead", { skip }, async () => {
  // Model phase 4: the two agency bookings pay at GoAhead. Agency A's seats
  // (agency-billed) are paid through the agency's request; agency B's
  // traveler pays, then cancels 24 hours before the start, after GoAhead:
  // Sawa keeps 10% under the tiers, so the commission is half.
  const payUp = async (pledgeId, dep) => {
    const departure = await pag.departureFor(db, { id: dep.id });
    const r = await pag.requestPayment(db, { pledgeId, departure });
    await pag.attachLink(db, { requestId: r.id, linkUrl: "https://pay.tab.travel/x", by: "ops" });
    return pag.markRequestPaid(db, { requestId: r.id, providerReference: `TAB-${r.id}`, by: "ops" });
  };
  const paidA = await payUp(deps.a.agencyPledge, deps.a);
  assert.equal(paidA.payer, "agency");
  assert.equal((await one("SELECT state FROM agency_invoices WHERE pledge_id = $1", [deps.a.agencyPledge])).state, "paid");
  await payUp(deps.b.agencyPledge, deps.b);
  const start = zonedDateTimeToUtc(deps.b.date, "08:00");
  const cancel = await pag.cancelPayAtGoAheadBooking(db, { pledgeId: deps.b.agencyPledge, reason: "traveler", by: "ops", now: start - DAY });
  assert.deepEqual([cancel.retainedPct, cancel.fee, cancel.refund], [10, 10, 90]);
  // Departure C: an agency seat on a date that never reached GoAhead.
  const cPledge = await pledge(deps.c, 1, { agencyId: "ag_a", agency: "Agency A" });
  await comm.recordAgencyBooking(db, { pledgeId: cPledge, agency: { id: "ag_a", billing_approved: true, billing_due_days: 14 }, catalogueDepartureId: deps.c.id });
  await db.query("UPDATE catalogue_departures SET status = 'cancelled_below_minimum' WHERE id = $1", [deps.c.id]);

  const out = await comm.decideCommissions({});
  assert.equal(out.decided, 3);
  const a = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [deps.a.agencyPledge]);
  assert.deepEqual([a.state, Number(a.earned_eur)], ["earned", 24]);
  const b = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [deps.b.agencyPledge]);
  assert.deepEqual([b.state, Number(b.earned_eur)], ["half", 10]);
  const c = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [cPledge]);
  assert.deepEqual([c.state, Number(c.earned_eur)], ["void", 0]);
  assert.equal((await one("SELECT state FROM agency_invoices WHERE pledge_id = $1", [cPledge])).state, "void");
});

test("the monthly statement lists each seat and totals it; an Egyptian agency waits for the day's EGP rate", { skip }, async () => {
  const [y, m] = deps.month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const now = zonedDateTimeToUtc(`${next}-02`, "09:00");
  sent.length = 0;
  const first = await comm.runCommissionStatements({ now, send });
  assert.deepEqual([first.sent, first.held], [1, 1], JSON.stringify(first));
  const stA = comm.mapStatement(await one("SELECT * FROM commission_statements WHERE agency_id = 'ag_a'"));
  assert.equal(stA.period, deps.month);
  assert.equal(stA.state, "sent");
  assert.equal(stA.totalEur, 24, "24 earned + 0 void");
  assert.deepEqual(stA.lines.map((l) => [l.seats, l.status, l.earnedEur]).sort(), [[1, "void", 0], [2, "earned", 24]]);
  assert.ok(sent.some((x) => x.to === "owner@agency-a.test" && /Commission statement for/.test(x.subject)));
  const stB = await one("SELECT * FROM commission_statements WHERE agency_id = 'ag_b'");
  assert.equal(stB.state, "draft");
  assert.match(stB.hold_reason, /No EGP rate/);
  await fin.setFxRate(db, { day: `${next}-02`, egpPerEur: 55, by: "it" });
  assert.equal((await comm.runCommissionStatements({ now, send })).sent, 1);
  const b = comm.mapStatement(await one("SELECT * FROM commission_statements WHERE agency_id = 'ag_b'"));
  assert.deepEqual([b.state, b.currency, b.totalEur, b.totalEgp, b.egpPerEur], ["sent", "EGP", 10, 550, 55]);
  // Recorded like any payment.
  const paid = await fin.recordPayment(db, { kind: "commission_statement", id: b.id, amount: 550, paidOn: `${next}-05`, bankReference: "NBE-77", user: STAFF });
  assert.equal(paid.currency, "EGP");
});

// ---------------------------------------------------------------- F. finance view and margin
test("the finance view lists due, overdue and paid; the margin shows 'rate missing' until the rate is entered", { skip }, async () => {
  // A legacy-flow invoice (not pay at GoAhead) is due N days after booking.
  const legacyInvoice = await pledge(deps.c, 1, { agencyId: "ag_a", agency: "Agency A" });
  await comm.recordAgencyBooking(db, { pledgeId: legacyInvoice, agency: { id: "ag_a", billing_approved: true, billing_due_days: 14 }, catalogueDepartureId: deps.c.id });
  const items = await fin.financeItems(db, {});
  assert.ok(items.some((i) => i.kind === "operator_payable" && i.standing === "paid"));
  assert.ok(items.some((i) => i.kind === "agency_invoice" && i.party.id === "ag_a"));
  const overdue = await fin.financeItems(db, { now: zonedDateTimeToUtc(shiftDate(today(), 400), "12:00"), standing: "overdue" });
  assert.ok(overdue.some((i) => i.kind === "agency_invoice"), "an unpaid invoice past its due date is overdue");
  assert.ok((await fin.overdueSummary(db, zonedDateTimeToUtc(shiftDate(today(), 400), "12:00"))).overdue >= 1);
  assert.ok((await fin.financeItems(db, { party: "agency b" })).every((i) => i.party.id === "ag_b"));

  // Charges on departure A: 300 EUR on one day, 100 on another.
  const charge = async (pledgeId, amount, day) => db.query(
    `INSERT INTO booking_payments (pledge_id, kind, amount, link_url, due_at, due_bound_by, state, paid_at, provider_reference)
     VALUES ($1, 'full', $2, 'https://pay.example/x', now(), 'window', 'paid', $3, 'tab_test')`, [pledgeId, amount, new Date(zonedDateTimeToUtc(day, "12:00"))]);
  const live = (await db.query("SELECT id FROM pledges WHERE departure_id = $1 AND status <> 'cancelled' ORDER BY created_at LIMIT 2", [deps.a.legacy])).rows;
  const d1 = shiftDate(today(), -3);
  const d2 = shiftDate(today(), -2);
  await charge(live[0].id, 300, d1);
  await charge(live[1].id, 100, d2);
  await fin.setFxRate(db, { day: d1, egpPerEur: 50, by: "it" });
  // Model phase 4: agency A's pay-at-GoAhead payment (its invoice amount,
  // 200 − 24 commission = 176 EUR) counts on the day it was recorded paid.
  const modeC = await one("SELECT amount_eur, paid_at FROM payment_requests WHERE pledge_id = $1 AND state = 'paid'", [deps.a.agencyPledge]);
  const d0 = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(modeC.paid_at);
  await fin.setFxRate(db, { day: d0, egpPerEur: 55, by: "it" });
  let row = (await fin.marginReport(db, { from: deps.a.date, to: deps.a.date })).find((r) => r.departure.id === deps.a.id);
  assert.equal(row.margin, null);
  assert.equal(row.problem, "rate missing");
  assert.deepEqual(row.missingRates, [d2]);
  await fin.setFxRate(db, { day: d2, egpPerEur: 40, by: "it" });
  row = (await fin.marginReport(db, { from: deps.a.date, to: deps.a.date })).find((r) => r.departure.id === deps.a.id);
  // Operator 390 EGP, spread over the charges by share and converted at each
  // charge day's rate. Commission 24. Fees not set.
  const c0 = Number(modeC.amount_eur);
  const revenue = 400 + c0;
  const opEur = [[300, 50], [100, 40], [c0, 55]].reduce((sum, [amt, rate]) => sum + (390 * (amt / revenue)) / rate, 0);
  assert.equal(row.operatorEgp, 390);
  assert.equal(row.feesMissing, true);
  assert.ok(Math.abs(row.margin - (revenue - opEur - 24)) < 0.02, `${row.margin} vs ${revenue - opEur - 24}`);
  const legacy = await fin.legacyOpenDepartures(db);
  assert.equal(typeof legacy.open, "number");
});

// ---------------------------------------------------------------- set-off (9.4)
async function goAheadWithOperator(dep, operatorId) {
  for (let n = 0; n < 8; n += 2) await pledge(dep, 2);
  await cat.runStatusJob({});
  const a = await asg.assignByAdmin(db, { departureId: dep.id, operatorId, by: "ops" });
  await asg.acknowledge(db, { assignmentId: a.id, operatorId, by: "dispatch" });
  return one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [a.id]);
}
const payOp = (id, amount) => fin.recordPayment(db, { kind: "operator_payable", id, amount, paidOn: today(), bankReference: `T-${id}`, user: STAFF });

test("a negative balance becomes a receivable, set off against the operator's next advance and shown on both statements", { skip }, async () => {
  // Clear what X is still owed, so the set-off lands where the test expects.
  await payOp(deps.b.balance, 140);
  const advF = await goAheadWithOperator(deps.f, X);
  await payOp(Number(advF.id), 260);
  await asg.freezeManifests({ db, now: (await cutoffOf(deps.f)) + 60000 });
  await db.query("UPDATE catalogue_departures SET status = 'completed' WHERE id = $1", [deps.f.id]);
  await settle.runSettlementTick({});
  // A service failure: 400 deducted from 520, less the 260 advance, is −140.
  await settle.addAdjustment(db, { departureId: deps.f.id, kind: "service_failure", amountEgp: 400, reason: "tour cut short; refunds to travelers", clauseRef: "Operator 12.2", by: "ops" });
  const balF = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [deps.f.id]);
  assert.deepEqual([Number(balF.amount), balF.state], [-140, "offset"], "nothing to transfer");
  const rec = await one("SELECT * FROM operator_receivables WHERE source_payable_id = $1", [balF.id]);
  assert.deepEqual([rec.source, Number(rec.amount_egp), Number(rec.outstanding_egp), rec.state], ["negative_balance", 140, 140, "open"]);
  assert.deepEqual((await fin.receivablesByOperator(db)).find((x) => x.operatorId === X)?.outstandingEgp, 140, "on the finance dashboard");

  // The next advance takes it: 260 less 140 set off, 120 to transfer.
  const advG = await goAheadWithOperator(deps.g, X);
  assert.deepEqual([Number(advG.amount), Number(advG.setoff_egp), advG.state], [260, 140, "due"]);
  assert.equal((await one("SELECT state FROM operator_receivables WHERE id = $1", [rec.id])).state, "settled");
  await assert.rejects(payOp(Number(advG.id), 260), /differs from what is due \(EGP 120\)/);
  assert.equal((await payOp(Number(advG.id), 120)).due, 120);

  // On both statements: F's says what it owed and where it was recovered.
  const sentF = await settle.sendStatement(db, { departureId: deps.f.id, by: "ops" });
  assert.equal(sentF.snapshot.balance, -140);
  assert.equal(sentF.snapshot.receivables[0].amountEgp, 140);
  assert.deepEqual(sentF.snapshot.receivables[0].setOffAgainst.map((x) => [x.payable, x.amountEgp]), [["advance", 140]]);
  assert.match(statementPdfText(sentF), /recovered EGP 140\.00 from the advance/);
  // G's balance statement lists the set-off taken from its advance.
  await asg.freezeManifests({ db, now: (await cutoffOf(deps.g)) + 60000 });
  await db.query("UPDATE catalogue_departures SET status = 'completed' WHERE id = $1", [deps.g.id]);
  await settle.runSettlementTick({});
  const stG = await settle.statementFor(db, deps.g.id);
  assert.deepEqual(stG.snapshot.setoffs.map((x) => [x.payable, x.amountEgp, x.fromDepartureId]), [["advance", 140, deps.f.id]]);
  assert.equal(stG.snapshot.balance, 260, "the advance counts in full: the operator had its value");
  assert.match(statementPdfText(stG), /140\.00 from the advance, for departure/);
});

test("reassigned after a paid advance, through the operator's fault: the whole advance is owed back, with a penalty; the new operator gets its own advance", { skip }, async () => {
  const Y = (await ops.createOperator(db, { legalName: "Delta Travel", email: "ops@delta.test" }, "it")).id;
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, Y, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await ops.setApprovals(db, Y, [productId], "it");
  await ops.setOperatorStatus(db, Y, "active", { by: "it" });
  deps.Y = Y;
  // X is paid what it's owed on G first, so the new receivables stay open.
  await payOp(Number((await one("SELECT id FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [deps.g.id])).id), 260);

  const advH = await goAheadWithOperator(deps.h, X);
  await payOp(Number(advH.id), 260);
  await assert.rejects(asg.assignByAdmin(db, { departureId: deps.h.id, operatorId: Y, by: "ops" }), (e) => e.code === "reason_required");
  assert.equal((await one("SELECT operator_id, state FROM catalogue_assignments WHERE departure_id = $1 AND state = 'acknowledged'", [deps.h.id])).operator_id, String(X), "nothing changed");
  // Over HTTP the admin is asked the same way.
  const on = await startServer({ FEATURES: "catalogue_v2" });
  const ask = await fetch(`${on}/api/admin/catalogue/departures/${deps.h.id}/assign`, { method: "POST", headers: auth("staff-token"), body: JSON.stringify({ operatorId: Y }) });
  assert.equal(ask.status, 409);
  assert.equal((await ask.json()).code, "reason_required");

  const a = await asg.assignByAdmin(db, { departureId: deps.h.id, operatorId: Y, by: "ops", reassign: { reason: "operator_fault", penaltyCode: "no_show", note: "Canceled the morning of the tour." } });
  const owed = (await db.query("SELECT * FROM operator_receivables WHERE departure_id = $1 AND operator_id = $2 ORDER BY id", [deps.h.id, X])).rows;
  assert.deepEqual(owed.map((r) => [r.source, Number(r.amount_egp)]), [["reassignment_advance", 260], ["penalty", 50]]);
  const pen = await one("SELECT * FROM operator_adjustments WHERE departure_id = $1 AND operator_id = $2", [deps.h.id, X]);
  assert.deepEqual([pen.kind, pen.penalty_code, Number(pen.amount_egp)], ["penalty", "no_show", 50]);
  assert.equal((await one("SELECT replaced_reason FROM catalogue_assignments WHERE departure_id = $1 AND operator_id = $2", [deps.h.id, X])).replaced_reason, "operator_fault");
  // The new operator: a fresh advance under the normal rules, nothing set off.
  await asg.acknowledge(db, { assignmentId: a.id, operatorId: Y, by: "ops@delta.test" });
  const advY = await one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [a.id]);
  assert.deepEqual([Number(advY.amount), Number(advY.setoff_egp), advY.state], [260, 0, "due"]);
  const figs = await settle.settlementFigures(db, deps.h.id);
  assert.deepEqual([figs.party.operatorId, figs.deductions], [Y, 0], "X's penalty isn't deducted from Y");

  // X repays part of it by transfer.
  const part = await fin.recordPayment(db, { kind: "operator_receivable", id: Number(owed[0].id), amount: 100, paidOn: today(), bankReference: "IN-1", user: STAFF });
  assert.equal(part.outstanding, 160);
  await assert.rejects(fin.recordPayment(db, { kind: "operator_receivable", id: Number(owed[0].id), amount: 200, paidOn: today(), bankReference: "IN-2", user: STAFF }), /Only EGP 160 is outstanding/);
  assert.equal((await fin.receivablesByOperator(db)).find((x) => x.operatorId === X).outstandingEgp, 210);
});

test("reassigned after a paid advance, not the operator's fault: it keeps its evidenced costs and owes back the rest", { skip }, async () => {
  // X's next advance first takes what it still owes (160 + 50): 50 to transfer.
  const advI = await goAheadWithOperator(deps.i, X);
  assert.deepEqual([Number(advI.amount), Number(advI.setoff_egp)], [260, 210]);
  await payOp(Number(advI.id), 50);
  assert.equal((await fin.receivablesByOperator(db)).find((x) => x.operatorId === X), undefined, "all recovered");
  // Through the pool, as the route does: a refused reassignment rolls back whole.
  const { pool } = await import("./db/index.js");
  const reassign = (extra) => asg.assignByAdmin(pool, { departureId: deps.i.id, operatorId: deps.Y, by: "ops", reassign: { reason: "not_operator_fault", ...extra } });
  await assert.rejects(reassign({ keptEgp: 60 }), /evidenced/);
  await assert.rejects(reassign({ keptEgp: 300 }), /between EGP 0 and the advance/);
  const line = await one(
    `INSERT INTO departure_costs (departure_id, category, description, amount, state, approved_amount, reviewed_at, submitted_by_agency_id)
     VALUES ($1, 'transport', 'Van deposit, non-refundable', 1.2, 'approved', 1.2, now(), NULL) RETURNING id`, [deps.i.legacy]);
  const a = await reassign({ keptEgp: 60, costLineIds: [Number(line.id)], note: "Site closed by the ministry." });
  const adj = await one("SELECT * FROM operator_adjustments WHERE departure_id = $1 AND operator_id = $2", [deps.i.id, X]);
  assert.deepEqual([adj.kind, Number(adj.amount_egp), adj.cost_line_ids], ["reimbursement", 60, [Number(line.id)]]);
  const rec = await one("SELECT * FROM operator_receivables WHERE departure_id = $1 AND operator_id = $2", [deps.i.id, X]);
  assert.deepEqual([rec.source, Number(rec.amount_egp)], ["reassignment_advance", 200]);
  assert.equal((await one("SELECT replaced_reason FROM catalogue_assignments WHERE departure_id = $1 AND operator_id = $2", [deps.i.id, X])).replaced_reason, "not_operator_fault");
  await asg.acknowledge(db, { assignmentId: a.id, operatorId: deps.Y, by: "ops@delta.test" });
  assert.equal(Number((await one("SELECT amount FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [a.id])).amount), 260, "a fresh advance for the new operator");
  // The advance counts in full (cash plus set-off): 260 less the 60 kept.
  assert.equal((await fin.receivablesByOperator(db)).find((x) => x.operatorId === X).outstandingEgp, 200);
  const items = await fin.financeItems(db, { party: "Nile Tours" });
  assert.ok(items.some((i) => i.kind === "operator_receivable" && i.amount === 200 && i.standing === "due"));
  assert.ok(items.some((i) => i.kind === "operator_receivable" && i.grossAmount === 50 && i.standing === "paid"), "the penalty, recovered by set-off");
});

test("the finance, settlement and portal routes answer, each party seeing only its own", { skip }, async () => {
  const on = await startServer({ FEATURES: "catalogue_v2" });
  const get = (path, token) => fetch(`${on}${path}`, { headers: auth(token) });
  const finance = await (await get("/api/admin/finance", "staff-token")).json();
  assert.ok(finance.items.length > 0);
  assert.equal(typeof finance.legacy.open, "number");
  assert.equal((await get("/api/admin/finance", "ag-a-token")).status, 403);
  const settlement = await (await get(`/api/admin/catalogue/departures/${deps.b.id}/settlement`, "staff-token")).json();
  assert.equal(settlement.balance, 140);
  const pdf = await get(`/api/admin/catalogue/departures/${deps.b.id}/statement.pdf`, "staff-token");
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(Buffer.from(await pdf.arrayBuffer()).toString("latin1"), /^%PDF/);
  // The operator sees its sent statements and payments, and downloads its PDF.
  const mine = await (await get("/api/operator/statements", "op-token")).json();
  assert.ok(mine.statements.every((x) => x.operatorId === X && x.state !== "draft"));
  assert.ok(mine.payables.length >= 4);
  assert.equal((await get(`/api/operator/statements/${deps.b.id}.pdf`, "op-token")).status, 200);
  assert.equal((await get(`/api/operator/statements/${deps.c.id}.pdf`, "op-token")).status, 404);
  const banks = await (await get("/api/operator/bank", "op-token")).json();
  assert.ok(banks.accounts.every((a) => !a.iban || a.iban.startsWith("••••")), "the portal shows masked numbers");
  // An agency sees its own commission only.
  const a = await (await get("/api/agency/commissions", "ag-a-token")).json();
  assert.ok(a.commissions.length >= 2 && a.commissions.every((c) => c.agencyId === "ag_a"));
  assert.ok(a.invoices.length >= 1);
  const b = await (await get("/api/agency/commissions", "ag-b-token")).json();
  assert.ok(b.commissions.every((c) => c.agencyId === "ag_b"));
  // Billing settings are a super admin's.
  const patch = (token) => fetch(`${on}/api/admin/agencies/ag_b/billing`, { method: "PATCH", headers: auth(token), body: JSON.stringify({ billingDueDays: 21 }) });
  assert.equal((await patch("staff-token")).status, 403);
  assert.equal((await patch("ops-token")).status, 200);
});

test("with catalogue_v2 off the phase 3 jobs do nothing and an acknowledgement creates no advance", { skip }, async () => {
  const OFF = { FEATURES: "" };
  assert.deepEqual(await jobs.runOperatorAssignments({ env: OFF, log: () => {} }), { skipped: "catalogue_v2 is off" });
  assert.deepEqual(await jobs.runOperatorDaily({ env: OFF, log: () => {} }), { skipped: "catalogue_v2 is off" });
  assert.deepEqual(await details.runCompletionRequests({ env: OFF }), { skipped: "catalogue_v2 is off" });
  assert.deepEqual(await comm.runCommissionStatements({ env: OFF }), { skipped: "catalogue_v2 is off" });
  // An assignment acknowledged with the flag off: no advance.
  await db.query("UPDATE catalogue_departures SET status = 'go_ahead' WHERE id = $1", [deps.e.id]);
  const a = await one(
    `INSERT INTO catalogue_assignments (departure_id, operator_id, source, assigned_by, ack_due_at) VALUES ($1, $2, 'admin', 'it', now() + interval '12 hours') RETURNING id`,
    [deps.e.id, X]);
  const saved = process.env.FEATURES;
  process.env.FEATURES = "";
  try {
    await asg.acknowledge(db, { assignmentId: Number(a.id), operatorId: X, by: "x" });
  } finally {
    process.env.FEATURES = saved;
  }
  assert.equal(await one("SELECT 1 FROM operator_payables WHERE assignment_id = $1", [a.id]), undefined);
});
