// Who operates a departure (phase 5, catalogue_v2) on a real Postgres:
//
//   most travelers    the agency with the most travelers on the departure,
//                     that is an approved, active operator for the product
//                     (documents current, bank details verified), is offered
//   tie               the agency whose first reservation came earliest
//   decline/timeout   the offer passes to the next agency, then to the
//                     rostered operator; only a rostered operator's missed
//                     acknowledgement is a strike
//   final             after acknowledgement, travelers added later change
//                     nothing
//   payment           no payment request before acknowledgement
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { makeToursBookable } from "./test-rate-cards.js";
import { shiftDate } from "../shared/catalogue.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_operator_selection";
const HOUR = 3600000;
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const USERS = {
  "op-a-token": { id: "00000000-0000-4000-8000-0000000000b1", email: "dispatch@agency-a.test", role: "operator_owner", operator: "A" },
  "op-b-token": { id: "00000000-0000-4000-8000-0000000000b2", email: "dispatch@agency-b.test", role: "operator_owner", operator: "B" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, pag;
let productId, on;
const OP = {};
const deps = {};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const send = async () => ({ ok: true });

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
     VALUES ($1,'day_tour','Giza Pyramids, Sphinx & the Grand Egyptian Museum','Cairo','08:00',4,12,95,95,'approved',true,24,'["Guide"]','["Tips"]')`, [GIZA]);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  pag = await import("./pay-at-goahead.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await cat.generateDepartures({ materialise: true });
  // The rate card (066: one per product): 2,200 per traveler, departure fees
  // 1,500 / 2,000, operator fee 0%, no selling prices; and a site-wide rate.
  await rates.saveRateCard(db, productId, {
    tiers: [{ from: 4, to: 6, priceEgp: null, operatorFeePct: 0 }, { from: 7, to: 8, priceEgp: null, operatorFeePct: 0 }],
    costLines: [{ name: "Departure fee", basis: "per_group", amounts: [1500, 2000] }, { name: "Per traveler", basis: "per_traveller", amounts: [2200, 2200] }],
    commissionPct: 10,
  }, { by: "it" });
  await makeToursBookable(db);

  // Three agencies that are also operators, and a rostered operator (X).
  // Agency C is an operator too, but its bank details aren't verified.
  const operator = async (key, legalName, agencyId, { bank = true } = {}) => {
    if (agencyId) await db.query("INSERT INTO agencies (id, name) VALUES ($1, $2)", [agencyId, legalName]);
    const o = await ops.createOperator(db, { legalName, email: `dispatch@${key.toLowerCase()}.test` }, "it");
    if (agencyId) await db.query("UPDATE operators SET agency_id = $2 WHERE id = $1", [o.id, agencyId]);
    for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
      await ops.addDocument(db, o.id, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
    }
    await ops.setApprovals(db, o.id, [productId], "it");
    await ops.setOperatorStatus(db, o.id, "active", { by: "it" });
    if (bank) {
      await db.query(
        `INSERT INTO operator_bank_accounts (operator_id, holder_name, bank_name, iban, state, decided_by, decided_at)
         VALUES ($1, $2, 'CIB', 'EG000000000000000000000001', 'verified', 'it', now())`, [o.id, legalName]);
    }
    OP[key] = Number(o.id);
  };
  await operator("A", "Agency A Tours", "ag_a");
  await operator("B", "Agency B Travel", "ag_b");
  await operator("C", "Agency C Unverified", "ag_c", { bank: false });
  await operator("X", "Rostered Nile Ops", null);
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, operator_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, OP[u.operator]]);
  }

  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 6`, [productId, today()]);
  [deps.a, deps.b, deps.c, deps.d, deps.e, deps.f] = r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), legacy: Number(x.legacy_departure_id) }));
  // X is rostered on every one of these dates (published months).
  for (const d of Object.values(deps)) {
    const month = d.date.slice(0, 7);
    await db.query("INSERT INTO roster_months (month, state, published_at, published_by) VALUES ($1, 'published', now(), 'it') ON CONFLICT (month) DO NOTHING", [month]);
    await db.query("INSERT INTO roster_entries (month, product_id, date, operator_id) VALUES ($1, $2, $3, $4)", [month, productId, d.date, OP.X]);
  }
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

// A booking on the departure, `minutesAgo` old, sold by an agency (or direct).
let seq = 0;
async function book(dep, seats, agencyId, minutesAgo) {
  const id = `pl_sel_${++seq}`;
  const names = Array.from({ length: seats }, (_, i) => `Traveler ${seq}.${i + 1}`);
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source,
                          pickup_point, nationality, safety_needs, traveller_names, booking_total, booking_code, created_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6,'+201000000000','confirmed',$7,'Mena House','Brazilian','None',$8,$9,$10, now() - make_interval(mins => $11))`,
    [id, dep.legacy, agencyId || "direct_customer", seats, names[0], `t${seq}@example.test`, agencyId ? "agency" : "public",
      JSON.stringify(names), 95 * seats, `SEL${String(seq).padStart(5, "0")}`, minutesAgo]);
  await (await import("./cancellation-tiers.js")).fixBookingTerms(db, { pledgeId: id, by: agencyId ? "agency" : "traveller" });
  return id;
}
const goAhead = async (now = Date.now()) => { await cat.runStatusJob({}); return asg.processGoAheadEvents({ db, now, send }); };
const live = (dep) => one("SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND state IN ('offered', 'acknowledged')", [dep.id]);
const strikes = async (key) => Number((await one("SELECT COUNT(*) AS n FROM operator_strikes WHERE operator_id = $1", [OP[key]])).n);
const authed = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

test("the agency with the most travelers on the departure is offered it first", { skip }, async () => {
  await book(deps.a, 2, "ag_b", 300);   // B booked first, but has fewer
  await book(deps.a, 3, "ag_a", 100);
  await book(deps.a, 1, null, 50);
  await goAhead();
  const a = await live(deps.a);
  assert.deepEqual([Number(a.operator_id), a.source, a.state], [OP.A, "agency", "offered"]);
  assert.deepEqual([a.candidate.travelers, a.candidate.rank, a.candidate.agencyId], [3, 1, "ag_a"]);
  assert.ok(Math.abs(new Date(a.ack_due_at).getTime() - new Date(a.assigned_at).getTime() - 4 * HOUR) < 5000, "4 hours to acknowledge");
});

test("on a tie, the agency whose first reservation came earliest", { skip }, async () => {
  await book(deps.b, 2, "ag_a", 100);
  await book(deps.b, 2, "ag_b", 200);   // earlier
  await goAhead();
  assert.equal(Number((await live(deps.b)).operator_id), OP.B);
});

test("a declined offer passes to the next qualifying agency, then to the roster; an unverified agency is skipped; no strikes", { skip }, async () => {
  await book(deps.c, 5, "ag_c", 400);   // most travelers, but no verified bank details
  await book(deps.c, 3, "ag_a", 300);
  await book(deps.c, 2, "ag_b", 200);
  await goAhead();
  const first = await live(deps.c);
  assert.equal(Number(first.operator_id), OP.A, "C isn't eligible: skipped");

  const r = await fetch(`${on}/api/operator/assignments/${first.id}/decline`, { method: "POST", headers: authed("op-a-token"), body: JSON.stringify({ reason: "No guide free" }) });
  assert.equal(r.status, 200, await r.text());
  const declined = await one("SELECT * FROM catalogue_assignments WHERE id = $1", [first.id]);
  assert.deepEqual([declined.state, declined.decline_reason], ["declined", "No guide free"]);
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'operator.assignment.decline' AND entity_id = $1", [String(first.id)]));
  const second = await live(deps.c);
  assert.deepEqual([Number(second.operator_id), second.source], [OP.B, "agency"]);
  // B can't decline A's offer, and A can't decline again.
  assert.equal((await fetch(`${on}/api/operator/assignments/${second.id}/decline`, { method: "POST", headers: authed("op-a-token"), body: "{}" })).status, 404);

  await asg.declineAssignment(db, { assignmentId: Number(second.id), operatorId: OP.B, by: "it", send });
  const third = await live(deps.c);
  assert.deepEqual([Number(third.operator_id), third.source], [OP.X, "roster"], "then the rostered operator");
  assert.deepEqual([await strikes("A"), await strikes("B")], [0, 0]);
});

test("an agency's offer not acknowledged in 4 hours passes on without a strike; the rostered operator's is a strike", { skip }, async () => {
  await book(deps.d, 4, "ag_a", 100);
  const t0 = Date.now();
  await goAhead(t0);
  assert.equal(Number((await live(deps.d)).operator_id), OP.A);
  await asg.expireAcknowledgements({ db, now: t0 + 4 * HOUR + 60000, send });
  const next = await live(deps.d);
  assert.deepEqual([Number(next.operator_id), next.source], [OP.X, "roster"]);
  assert.equal(await strikes("A"), 0);
  // The offer to X was made at the real clock; expire it past its own due time.
  await asg.expireAcknowledgements({ db, now: new Date(next.ack_due_at).getTime() + 60000, send });
  assert.ok(await one("SELECT 1 FROM operator_strikes WHERE operator_id = $1 AND departure_id = $2 AND kind = 'missed_acknowledgement'", [OP.X, deps.d.id]));
  assert.ok(await one("SELECT 1 FROM catalogue_admin_alerts WHERE departure_id = $1 AND kind = 'missed_acknowledgement'", [deps.d.id]));
});

test("no payment request before acknowledgement; after it the operator is final, whoever books later", { skip }, async () => {
  const early = await book(deps.e, 3, "ag_a", 300);
  await book(deps.e, 1, null, 200);
  await goAhead();
  const offer = await live(deps.e);
  assert.equal(Number(offer.operator_id), OP.A);
  await pag.runPayAtGoAheadTick({ db, now: Date.now(), send });
  assert.equal((await db.query("SELECT 1 FROM payment_requests WHERE departure_id = $1", [deps.e.id])).rowCount, 0, "nothing before acknowledgement");

  await asg.acknowledge(db, { assignmentId: Number(offer.id), operatorId: OP.A, by: "it", send });
  assert.ok((await db.query("SELECT 1 FROM payment_requests WHERE departure_id = $1", [deps.e.id])).rowCount >= 2, "requests once acknowledged");
  assert.ok(await one("SELECT 1 FROM payment_requests WHERE pledge_id = $1", [early]));

  // Agency B now brings more travelers than A: nothing changes.
  await book(deps.e, 5, "ag_b", 0);
  await asg.runAssignmentTick({ db, now: Date.now(), send });
  await goAhead();
  const still = await live(deps.e);
  assert.deepEqual([Number(still.id), Number(still.operator_id), still.state], [Number(offer.id), OP.A, "acknowledged"]);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM catalogue_assignments WHERE departure_id = $1", [deps.e.id])).n), 1);
});

test("with no agency on the departure, the rostered operator is offered it, as in phase 2", { skip }, async () => {
  await book(deps.f, 4, null, 100);
  await goAhead();
  const a = await live(deps.f);
  assert.deepEqual([Number(a.operator_id), a.source], [OP.X, "roster"]);
});
