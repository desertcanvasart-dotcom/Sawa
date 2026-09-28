// The pricing and money model (phase 5, catalogue_v2, migration 061) on a
// real Postgres, with the inputs it was agreed with (28 Sep 2026): prices
// 2,540 / 2,487 / 2,360 EGP; transport 2,200 / 2,200 / 3,300 per group; guide
// 2,000 per group; entry 700 per traveler; operator fee 5% / 6% / 10%; the
// collecting agent's commission 10%; published EUR rate 50.
//
//   rate card     published only when complete; the tour page shows each
//                 tier in whole euros
//   booking       keeps the published EUR rate; quoted its tier
//   8 travelers   Agency A operates (3 places), Agency B has 2, 3 direct:
//                 A 10,388 as operator + 2,819.4 as agency; B 1,879.6; the
//                 agent 4,809; statements separate, EUR at the statement date
//   tier drop     7–9 to 10–12 after payment: the EUR difference refunded
//   2 travelers   pool −1,308: the agent pays the guarantee; no agency share
//   FX            only the agent's FX line moves with the CBE rate
//   migration     phase 2 versions converted, and reported
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { shiftDate } from "../shared/catalogue.js";
import { zonedDateTimeToUtc } from "./tz.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_pool_model";
const HOUR = 3600000;
const MIN = 60000;
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const MODEL = {
  tiers: [
    { from: 4, to: 6, priceEgp: 2540, operatorFeePct: 5 },
    { from: 7, to: 9, priceEgp: 2487, operatorFeePct: 6 },
    { from: 10, to: 12, priceEgp: 2360, operatorFeePct: 10 },
  ],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [2200, 2200, 3300] },
    { name: "Guide", basis: "per_group", amounts: [2000, 2000, 2000] },
    { name: "Entry fees", basis: "per_traveller", amounts: [700, 700, 700] },
  ],
  commissionPct: 10,
  eurRate: 50,
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, pag, settle, comm, fin, tiers, poolS;
let productId, on, rateVersion;
const OP = {};
const deps = {};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const sent = [];
const send = async (m) => { sent.push(m); return { ok: true }; };

async function startServer(extraEnv) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "", TURNSTILE_SECRET_KEY: "",
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
  const OPS = { id: "00000000-0000-4000-8000-0000000000c1", email: "ops@sawa.test" };
  fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if ((req.headers.authorization || "") !== "Bearer ops-token") { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: OPS.id, email: OPS.email, aud: "authenticated" }));
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
     VALUES ($1,'day_tour','Giza Pyramids, Sphinx & the Grand Egyptian Museum','Cairo','08:00',4,12,95,95,'approved',true,24,'["Guide"]','["Tips"]')`, [GIZA]);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  await db.query("INSERT INTO app_users (id, email, role) VALUES ($1, $2, 'super_admin')", [OPS.id, OPS.email]);
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  pag = await import("./pay-at-goahead.js");
  settle = await import("./operator-settlement.js");
  comm = await import("./commissions.js");
  fin = await import("./finance.js");
  tiers = await import("./cancellation-tiers.js");
  poolS = await import("./pool-settlement.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await cat.generateDepartures({ materialise: true });

  // Two agencies that are also operators, and a rostered operator (X).
  const operator = async (key, legalName, agencyId) => {
    if (agencyId) await db.query("INSERT INTO agencies (id, name) VALUES ($1, $2)", [agencyId, legalName]);
    const o = await ops.createOperator(db, { legalName, email: `dispatch@${key.toLowerCase()}.test` }, "it");
    if (agencyId) await db.query("UPDATE operators SET agency_id = $2 WHERE id = $1", [o.id, agencyId]);
    for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
      await ops.addDocument(db, o.id, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
    }
    await ops.setApprovals(db, o.id, [productId], "it");
    await ops.setOperatorStatus(db, o.id, "active", { by: "it" });
    await db.query(
      `INSERT INTO operator_bank_accounts (operator_id, holder_name, bank_name, iban, state, decided_by, decided_at)
       VALUES ($1, $2, 'CIB', 'EG000000000000000000000001', 'verified', 'it', now())`, [o.id, legalName]);
    OP[key] = Number(o.id);
  };
  await operator("A", "Agency A Tours", "ag_a");
  await operator("B", "Agency B Travel", "ag_b");
  await operator("X", "Rostered Nile Ops", null);

  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 5`, [productId, today()]);
  [deps.a, deps.b, deps.c, deps.d, deps.e] = r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), legacy: Number(x.legacy_departure_id) }));
  on = await startServer({ FEATURES: "catalogue_v2" });
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

// A booking as the booking routes make one: terms fixed, the published EUR
// rate and the tier price stamped, and the agency's pool row.
let seq = 0;
async function book(dep, seats, agencyId = null) {
  const id = `pl_pool_${++seq}`;
  const names = Array.from({ length: seats }, (_, i) => `Traveler ${seq}.${i + 1}`);
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source,
                          pickup_point, nationality, safety_needs, traveller_names, booking_total, booking_code)
     VALUES ($1,$2,$3,$3,$4,$5,$6,'+201000000000','confirmed',$7,'Mena House','Brazilian','None',$8,$9,$10)`,
    [id, dep.legacy, agencyId || "direct_customer", seats, names[0], `t${seq}@example.test`, agencyId ? "agency" : "public",
      JSON.stringify(names), 95 * seats, `POOL${String(seq).padStart(5, "0")}`]);
  await tiers.fixBookingTerms(db, { pledgeId: id, by: agencyId ? "agency" : "traveller" });
  await poolS.stampBookingPrice(db, { pledgeId: id });
  if (agencyId) await comm.recordAgencyBooking(db, { pledgeId: id, agency: { id: agencyId, billing_approved: false }, catalogueDepartureId: dep.id });
  return id;
}
const reqOf = (pledgeId) => one("SELECT * FROM payment_requests WHERE pledge_id = $1 ORDER BY id DESC LIMIT 1", [pledgeId]);
const payAll = async (dep) => {
  for (const r of (await db.query("SELECT * FROM payment_requests WHERE departure_id = $1 AND state IN ('awaiting_link', 'sent')", [dep.id])).rows) {
    if (r.state === "awaiting_link") await pag.attachLink(db, { requestId: Number(r.id), linkUrl: `https://pay.tab.travel/${r.reference}`, by: "ops" });
    await pag.markRequestPaid(db, { requestId: Number(r.id), providerReference: `TAB-${r.id}`, by: "ops" });
  }
};
const cutoffOf = (dep) => zonedDateTimeToUtc(dep.date, "08:00") - 24 * HOUR;
// No roster in this suite: a departure with no agency on it is assigned by
// an admin to the rostered-style operator X.
const assignX = async (dep) => {
  const a = await asg.assignByAdmin(db, { departureId: dep.id, operatorId: OP.X, by: "ops", send });
  await asg.acknowledge(db, { assignmentId: a.id, operatorId: OP.X, by: "it", send });
  return a;
};
const acknowledgeLive = async (dep) => {
  const a = await one("SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND state = 'offered'", [dep.id]);
  await asg.acknowledge(db, { assignmentId: Number(a.id), operatorId: Number(a.operator_id), by: "it", send });
  return a;
};
const finish = async (dep) => {
  await asg.freezeManifests({ db, now: cutoffOf(dep) + MIN });
  const cut = await poolS.runPoolTick({});
  await db.query("UPDATE catalogue_departures SET status = 'completed' WHERE id = $1", [dep.id]);
  await settle.runSettlementTick({});
  const fin2 = await poolS.runPoolTick({});
  return { cut, fin: fin2 };
};

// ---------------------------------------------------------------- the rate card
test("the rate card: prices need the EUR rate; published, the tour page shows each tier in whole euros", { skip }, async () => {
  const noRate = await rates.saveRateDraft(db, productId, { ...MODEL, eurRate: null }, { by: "it" });
  await assert.rejects(rates.publishRate({ productId, versionId: noRate.id, by: "it" }), /published EUR rate/);
  await assert.rejects(rates.saveRateDraft(db, productId, { ...MODEL, costLines: [{ name: "Van", basis: "per_room", amounts: [1, 1, 1] }] }, { by: "it" }), /per group" or "per traveler/);
  // Seen by the tour page before the version is published: the listing's price.
  const before = (await (await fetch(`${on}/api/bootstrap`)).json()).tourProducts.find((p) => p.id === GIZA);
  assert.deepEqual([before.catalogue.priceLine, before.publishedRate], [null, 95]);
  // Published through the admin screen, which drops the public caches.
  const v = await rates.saveRateDraft(db, productId, MODEL, { by: "it" });
  const res = await fetch(`${on}/api/admin/rates/${productId}/versions/${v.id}/publish`, {
    method: "POST", headers: { Authorization: "Bearer ops-token", "Content-Type": "application/json" }, body: "{}" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  rateVersion = body.version;
  assert.deepEqual([rateVersion.eurRate, rateVersion.commissionPct, rateVersion.tiers.map((t) => t.priceEgp)], [50, 10, [2540, 2487, 2360]]);

  const boot = await (await fetch(`${on}/api/bootstrap`)).json();
  const giza = boot.tourProducts.find((p) => p.id === GIZA);
  assert.equal(giza.catalogue.priceLine, "€51 per person, €50 from 7 travelers, €47 from 10");
  assert.deepEqual([giza.publishedRate, giza.breakPrice], [51, 47]);
  assert.deepEqual(giza.priceTiers, [{ seats: 4, price: 51 }, { seats: 7, price: 50 }, { seats: 10, price: 47 }]);
});

test("a booking keeps the published EUR rate and is quoted its tier; the request charges the tier the departure is in then", { skip }, async () => {
  const r = await fetch(`${on}/api/public/departures/${deps.a.legacy}/bookings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Ana Lima", customerEmail: "ana@example.test", customerPhone: "+201001112233", seats: 2,
      travelerNames: ["Ana Lima", "Bo Lima"], pickupPoint: "Mena House", safetyNone: true }),
  });
  assert.equal(r.status, 201, await r.text());
  const p = await one("SELECT * FROM pledges WHERE customer_email = 'ana@example.test'");
  assert.deepEqual([Number(p.published_eur_rate), Number(p.price_per_person), Number(p.booking_total)], [50, 51, 102], "2 seats: the 4–6 tier, €51");
  // Six more: GoAhead at 8, in the 7–9 tier. The request asks €50 a seat.
  for (let i = 0; i < 3; i++) await book(deps.a, 2);
  await cat.runStatusJob({});
  await assignX(deps.a);
  const req = await reqOf(p.id);
  assert.equal(Number(req.amount_eur), 100, "2 × €50 at 7–9, not the €102 quoted");
  assert.equal(Number((await one("SELECT booking_total FROM pledges WHERE id = $1", [p.id])).booking_total), 100);
});

// ---------------------------------------------------------------- the worked example
test("8 travelers: A operates (3 places), B 2, 3 direct: A 10,388 as operator + 2,819.4 as agency; B 1,879.6; the agent 4,809", { skip }, async () => {
  const d = deps.b;
  d.a = await book(d, 3, "ag_a");
  d.b = await book(d, 2, "ag_b");
  d.direct = await book(d, 3);
  await cat.runStatusJob({});
  await asg.processGoAheadEvents({ db, send });
  const offer = await acknowledgeLive(d);
  assert.equal(Number(offer.operator_id), OP.A, "the agency with the most travelers operates it");
  // The advance: 50% of the entitlement, 10,388.
  const adv = await one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [offer.id]);
  assert.equal(Number(adv.amount), 5194);
  assert.equal(Number((await reqOf(d.a)).amount_eur), 150, "3 × €50");
  await payAll(d);
  const { fin: tick } = await finish(d);
  assert.equal(tick.poolFinal, 1);

  const money = await poolS.departureMoney(db, d.id);
  assert.deepEqual([money.lines.revenue, money.lines.entitlement, money.lines.commission, money.lines.pool, money.lines.poolPerTraveller],
    [19896, 10388, 1989.6, 7518.4, 939.8]);
  assert.equal(money.onlineEra.total, 4809, "1,989.6 commission + 2,819.4 on the direct places");
  const row = (id) => one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [id]);
  assert.deepEqual([(await row(d.a)).state, Number((await row(d.a)).earned_egp)], ["earned", 2819.4]);
  assert.deepEqual([(await row(d.b)).state, Number((await row(d.b)).earned_egp)], ["earned", 1879.6]);

  // As operator: the entitlement, on its operator statement, with a note that
  // its agency's share is paid separately.
  const bal = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [d.id]);
  assert.deepEqual([Number(bal.operator_id), Number(bal.detail.operatorAmount), Number(bal.amount)], [OP.A, 10388, 5194]);
  const st = await settle.statementFor(db, d.id);
  assert.equal(st.snapshot.distribution.model, "pool");
  assert.deepEqual(st.snapshot.distribution.ownAgencyShare && [st.snapshot.distribution.ownAgencyShare.places, st.snapshot.distribution.ownAgencyShare.amountEgp], [3, 2819.4]);
  assert.match(st.snapshot.distribution.ownAgencyShare.note, /paid on your agency statement/);

  // As agency: the monthly statement, EGP converted at the statement date's CBE rate.
  const [y, m] = d.date.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const now = zonedDateTimeToUtc(`${next}-02`, "09:00");
  await fin.setFxRate(db, { day: `${next}-02`, egpPerEur: 49.5, by: "it" });
  sent.length = 0;
  const out = await comm.runCommissionStatements({ now, send });
  assert.ok(out.sent >= 2, JSON.stringify(out));
  const sA = comm.mapStatement(await one("SELECT * FROM commission_statements WHERE agency_id = 'ag_a'"));
  assert.deepEqual([sA.basis, sA.currency, sA.totalEgp, sA.egpPerEur, sA.totalEur], ["pool", "EUR", 2819.4, 49.5, 56.96]);
  const depA = sA.departures.find((x) => x.departureId === d.id);
  assert.deepEqual([depA.calculation.revenue, depA.calculation.operatingCost, depA.calculation.operatorFee, depA.calculation.entitlement,
    depA.calculation.commission, depA.calculation.pool, depA.calculation.poolPerTraveller], [19896, 9800, 588, 10388, 1989.6, 7518.4, 939.8]);
  assert.equal(depA.youOperated, true);
  assert.match(depA.operatorNote, /operator entitlement \(EGP 10388\) is paid on your operator statement/);
  const sB = comm.mapStatement(await one("SELECT * FROM commission_statements WHERE agency_id = 'ag_b'"));
  assert.deepEqual([sB.totalEgp, sB.totalEur], [1879.6, 37.97]);
});

test("FX: the CBE rate on the charge day moves only the agent's FX line", { skip }, async () => {
  const d = deps.b;
  const days = (await db.query(
    "SELECT DISTINCT to_char(paid_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS day FROM payment_requests WHERE departure_id = $1 AND state = 'paid'", [d.id])).rows.map((r) => r.day);
  const at = async (rate) => {
    for (const day of days) await fin.setFxRate(db, { day, egpPerEur: rate, by: "it" });
    return poolS.departureMoney(db, d.id);
  };
  const par = await at(49.74);   // €400 × 49.74 = 19,896: the nominal revenue
  const up = await at(52);
  assert.deepEqual([par.fx.collectedEur, par.fx.fxEgp, up.fx.fxEgp], [400, 0, 904]);
  assert.equal(up.onlineEra.resultEgp - par.onlineEra.resultEgp, 904, "the whole difference is the agent's");
  assert.deepEqual([up.lines.entitlement, up.shares.agencies.map((a) => a.amount)], [par.lines.entitlement, par.shares.agencies.map((a) => a.amount)]);
  const margin = (await fin.marginReport(db, { from: d.date, to: d.date })).find((r) => r.departure.id === d.id);
  assert.deepEqual([margin.model, margin.marginEgp], ["pool", up.onlineEra.resultEgp]);
});

// ---------------------------------------------------------------- the tier drop
test("a departure that moves from 7–9 to 10–12 after payment refunds the EUR difference to each paid traveler; nobody pays more", { skip }, async () => {
  const d = deps.c;
  const early = [];
  for (let i = 0; i < 4; i++) early.push(await book(d, 2));
  await cat.runStatusJob({});
  await assignX(d);
  for (const id of early) assert.equal(Number((await reqOf(id)).amount_eur), 100, "8 travelers: 7–9, €50 a seat");
  await payAll(d);
  // Two more before the cut-off: 10 travelers, the 10–12 tier (€47).
  const late = await book(d, 2);
  assert.equal(Number((await one("SELECT price_per_person FROM pledges WHERE id = $1", [late])).price_per_person), 47);
  await pag.runPayAtGoAheadTick({ db, now: Date.now(), send });
  assert.equal(Number((await reqOf(late)).amount_eur), 94, "the later booking pays the cheaper tier");
  await payAll(d);
  await asg.freezeManifests({ db, now: cutoffOf(d) + MIN });
  const tick = await poolS.runPoolTick({});
  assert.equal(tick.tierRefunds, 4, JSON.stringify(tick));
  const refunds = (await db.query("SELECT * FROM payment_refunds WHERE pledge_id = ANY($1::text[]) AND kind = 'tier_difference'", [early])).rows;
  assert.deepEqual(refunds.map((f) => Number(f.amount_eur)), [6, 6, 6, 6], "2 × (€50 − €47)");
  const tasks = (await db.query(
    "SELECT t.* FROM payment_tasks t JOIN payment_refunds f ON f.id = t.refund_id WHERE f.kind = 'tier_difference' AND t.kind = 'issue_refund'")).rows;
  assert.equal(tasks.length, 4, "with tab-manual, an ops task each");
  assert.match(tasks[0].title, /^Refund €6 in Tab for /);
  assert.equal((await db.query("SELECT 1 FROM payment_refunds WHERE pledge_id = $1", [late])).rowCount, 0);
  assert.equal((await poolS.runPoolTick({})).tierRefunds, 0, "once");
});

// ---------------------------------------------------------------- the guarantee
test("2 travelers, guaranteed: pool −1,308; the agent pays a 1,308 guarantee; the agency gets nothing", { skip }, async () => {
  const d = deps.d;
  d.a = await book(d, 2, "ag_a");
  await cat.runBelowMinimum({ departureId: d.id, by: "ops", reason: "guaranteed for the test" });
  await asg.processGoAheadEvents({ db, send });
  await acknowledgeLive(d);
  assert.equal(Number((await reqOf(d.a)).amount_eur), 102, "below 4 is the first tier: 2 × €51");
  await payAll(d);
  await finish(d);
  const money = await poolS.departureMoney(db, d.id);
  assert.deepEqual([money.lines.tier, money.lines.revenue, money.lines.entitlement, money.lines.commission, money.lines.pool, money.lines.guarantee],
    ["4–6", 5080, 5880, 508, -1308, 1308]);
  assert.equal(money.onlineEra.total, 508 - 1308);
  const row = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [d.a]);
  assert.deepEqual([row.state, Number(row.earned_egp)], ["void", 0]);
  assert.match(row.state_reason, /pool was not positive/);
  const bal = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [d.id]);
  assert.equal(Number(bal.detail.operatorAmount), 5880, "the operator is paid its entitlement in full");
  const st = await settle.statementFor(db, d.id);
  assert.ok(st.snapshot.distribution.lines.some((l) => l.key === "minimum_departure_guarantee" && l.amountEgp === 1308));
});

// ---------------------------------------------------------------- the migration
test("migration 061 converts a phase 2 version and records what it did", { skip }, async () => {
  const old = (await db.query(
    `INSERT INTO catalogue_rate_versions (product_id, version, land_per_traveler, room_twin, room_single, fee_4_6, fee_7_9, fee_10_12, commission_per_seat)
     VALUES ($1, 99, 3000, 5000, 4000, 1500, 2000, 2600, 12) RETURNING id`, [productId])).rows[0].id;
  await db.query("UPDATE catalogue_rate_versions SET tiers = NULL, cost_lines = NULL WHERE id = $1", [old]);
  await db.query(readFileSync(join(ROOT, "server", "db", "schema_061_pool_model.sql"), "utf8"));
  const v = rates.mapRate(await one("SELECT * FROM catalogue_rate_versions WHERE id = $1", [old]));
  assert.deepEqual(v.tiers.map((t) => [t.from, t.to, t.priceEgp, t.operatorFeePct]), [[4, 6, null, 0], [7, 9, null, 0], [10, 12, null, 0]]);
  assert.deepEqual(v.costLines, [
    { name: "Departure fee", basis: "per_group", amounts: [1500, 2000, 2600] },
    { name: "Land services", basis: "per_traveller", amounts: [3000, 3000, 3000] },
    { name: "Room or cabin (twin share)", basis: "per_traveller", amounts: [2500, 2500, 2500] },
  ]);
  const notes = v.source.migration061.notes.join("; ");
  assert.match(notes, /single room 4000(\.00)? not carried/);
  assert.match(notes, /fixed agency commission 12(\.00)? per seat retired/);
  // The same rule as the shared conversion, so the import and the migration agree.
  const { convertLegacyRate } = await import("../shared/pool-model.js");
  assert.deepEqual(convertLegacyRate({ landPerTraveler: 3000, roomTwin: 5000, roomSingle: 4000, fee4_6: 1500, fee7_9: 2000, fee10_12: 2600 }).costLines, v.costLines);
  // Reported, for the rate card screen and the script.
  const lines = rates.migrationReportLines((await db.query(
    `SELECT c.catalogue_no, c.code, v.version, v.state, v.cost_lines, v.source
       FROM catalogue_rate_versions v JOIN catalogue_products c ON c.id = v.product_id WHERE v.id = $1`, [old])).rows);
  assert.match(lines[0], /converted/);
  assert.match(lines.at(-1), /1 of 1 version converted by 061/);
  // Running the migration again changes nothing already converted.
  await db.query(readFileSync(join(ROOT, "server", "db", "schema_061_pool_model.sql"), "utf8"));
  assert.deepEqual(rates.mapRate(await one("SELECT * FROM catalogue_rate_versions WHERE id = $1", [old])).costLines, v.costLines);
});

// ---------------------------------------------------------------- merge into a catalog date
test("a legacy date beside a catalog date merges into it; each booking becomes a catalog booking, and the undo restores it", { skip }, async () => {
  const d = deps.e;
  const merge = await import("./departure-merge.js");
  const legacyTour = (await one("SELECT tour_product_id, date FROM departures WHERE id = $1", [d.legacy]));
  const dupId = Number((await one(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES (nextval('departures_id_seq'), 'day_tour', $1, 'Giza', $2, '08:00', 'Cairo', 4, 12, 95, 95, 'open') RETURNING id`,
    [legacyTour.tour_product_id, legacyTour.date])).id);
  const pid = "pl_pool_merge";
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source, booking_total, booking_code)
     VALUES ($1, $2, 'ag_b', 'ag_b', 2, 'Old Date Traveler', 'old@example.test', '+201000000000', 'confirmed', 'agency_request', 190, 'POOLMERGE1')`, [pid, dupId]);
  const out = await merge.mergeDepartures({ keptId: d.legacy, duplicateIds: [dupId], by: "ops" });
  const p = await one("SELECT * FROM pledges WHERE id = $1", [pid]);
  assert.deepEqual([Number(p.departure_id), p.payment_mode, Number(p.published_eur_rate), Number(p.price_per_person)], [d.legacy, "pay_at_goahead", 50, 51],
    "a catalog booking: pay at GoAhead, the published rate, 2 travelers at the 4–6 tier");
  assert.ok(p.cancellation_tier_version_id, "the tiers in force");
  assert.equal((await one("SELECT basis FROM agency_commissions WHERE pledge_id = $1", [pid])).basis, "pool");
  await merge.revertMerge({ mergeId: out.merge.id, by: "ops" });
  const back = await one("SELECT * FROM pledges WHERE id = $1", [pid]);
  assert.deepEqual([Number(back.departure_id), back.payment_mode === "pay_at_goahead", back.published_eur_rate, Number(back.booking_total)], [dupId, false, null, 190]);
  assert.equal(await one("SELECT 1 FROM agency_commissions WHERE pledge_id = $1", [pid]), undefined);
});
