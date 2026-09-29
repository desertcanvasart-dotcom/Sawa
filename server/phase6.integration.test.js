// Phase 6 (29 Sep 2026, catalogue_v2, migration 063) on a real Postgres:
//
//   numbered departures   a 9th traveler opens departure 2, which needs its own 4;
//                         a party of 3 when departure 1 has 6 goes whole to departure 2;
//                         departure 2 below 4 at the cut-off is cancelled while 1 runs;
//                         each departure has its own operator offer and settlement;
//                         the public list shows the date once
//   maximum group of 8    a party over 8 is not booked; merging above 8 is refused
//   one price             4 travelers 5,192 EGP: pool 2,678.7; 8 travelers: 10,239.9
//   operator fee          not publishable empty; a per-departure override moves that
//                         departure only, is refused after acknowledgement, and the
//                         statements show the % used
//   migration 063         a multi-tier version gets a NEW DRAFT from its first tier
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readFileSync } from "node:fs";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { shiftDate } from "../shared/catalogue.js";
import { zonedDateTimeToUtc } from "./tz.js";

const MODEL = {
  // One price: a single tier 4–8. Transport and guide per departure, entrance and lunch per traveler.
  tiers: [{ from: 4, to: 8, priceEgp: 5192, operatorFeePct: 5 }],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [2650] },
    { name: "Guide", basis: "per_group", amounts: [2000] },
    { name: "Entrance fees", basis: "per_traveller", amounts: [2250] },
    { name: "Lunch", basis: "per_traveller", amounts: [400] },
  ],
  commissionPct: 10,
  eurRate: 97,
};
const HOUR = 3600000;
const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_phase6";
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000091", email: "boss@sawa.test", role: "super_admin" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, pag, poolS;
let productId, X, Y, on, off;
const deps = {};
const s = {};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const json = { "Content-Type": "application/json" };
const staff = { Authorization: "Bearer ops-token", "Content-Type": "application/json" };

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
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency || null]);
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  pag = await import("./pay-at-goahead.js");
  poolS = await import("./pool-settlement.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await cat.generateDepartures({ materialise: true });
  const rd = await rates.saveRateDraft(db, productId, MODEL, { by: "it" });
  await rates.publishRate({ productId, versionId: rd.id, by: "it" });
  const operator = async (legalName, email) => {
    const id = (await ops.createOperator(db, { legalName, email }, "it")).id;
    for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
      await ops.addDocument(db, id, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
    }
    await ops.setApprovals(db, id, [productId], "it");
    await ops.setOperatorStatus(db, id, "active", { by: "it" });
    await db.query(
      `INSERT INTO operator_bank_accounts (operator_id, holder_name, bank_name, iban, state, decided_by, decided_at)
       VALUES ($1, $2, 'CIB', 'EG000000000000000000000001', 'verified', 'it', now())`, [id, legalName]);
    return Number(id);
  };
  X = await operator("Nile Tours S.A.E.", "dispatch@nile-tours.test");
  Y = await operator("Delta Travel S.A.E.", "dispatch@delta-travel.test");
  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 8`, [productId, today()]);
  [deps.a, deps.b, deps.c, deps.d, deps.e, deps.f] = r.rows.map((x) => ({ id: Number(x.id), date: String(x.date instanceof Date ? x.date.toISOString() : x.date).slice(0, 10), legacy: Number(x.legacy_departure_id) }));
  on = await startServer({ FEATURES: "catalogue_v2" });
  off = await startServer({ FEATURES: "" });
});

after(async () => {
  if (skip) return;
  for (const p of servers) p.kill();
  fakeAuth?.close();
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

let seq = 0;
// A complete direct booking through the public route, as the tour page makes it.
async function bookPublic(base, dep, seats, { name, partyToken } = {}) {
  seq += 1;
  const lead = name || `Traveler ${seq}`;
  const res = await fetch(`${base}/api/public/departures/${dep.legacy}/bookings`, {
    method: "POST", headers: json,
    body: JSON.stringify({
      customerName: lead, customerEmail: `t${seq}@example.test`, customerPhone: `+2010000000${String(seq).padStart(2, "0")}`, seats,
      travelerNames: Array.from({ length: seats }, (_, i) => (i === 0 ? lead : `${lead} guest ${i + 1}`)),
      pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true, ...(partyToken ? { partyToken } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, id: body.booking?.id, code: body.booking?.bookingCode };
}
const post = (base, path, body, headers = json) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (base, path) => fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));


// The numbered departures of a date, lowest first, with the seats each holds.
const numbered = async (date) => (await db.query(
  `SELECT cd.id, cd.departure_no AS no, cd.status, cd.legacy_departure_id AS legacy,
          (SELECT COALESCE(SUM(seats), 0)::int FROM pledges p WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled') AS seats
     FROM catalogue_departures cd WHERE cd.product_id = $1 AND cd.date = $2 ORDER BY cd.departure_no`, [productId, date])).rows
  .map((r) => ({ id: Number(r.id), no: Number(r.no), status: r.status, legacy: Number(r.legacy), seats: r.seats }));
const legacyOf = (row) => ({ id: row.id, legacy: row.legacy });
const cutoffOf = async (date) => {
  const h = Number((await one("SELECT cutoff_hours FROM catalogue_products WHERE id = $1", [productId])).cutoff_hours);
  return zonedDateTimeToUtc(date, "08:00") - h * HOUR;
};

test("the calendar makes departure 1 of a date only, and again changes nothing", { skip }, async () => {
  await cat.generateDepartures({ materialise: true });
  const rows = (await db.query("SELECT date, count(*)::int AS n, max(departure_no)::int AS top FROM catalogue_departures WHERE product_id = $1 GROUP BY date", [productId])).rows;
  assert.ok(rows.length > 10);
  assert.ok(rows.every((r) => r.n === 1 && r.top === 1), "one departure per date, numbered 1");
  await assert.rejects(db.query("INSERT INTO catalogue_departures (product_id, date, departure_no) SELECT product_id, date, departure_no FROM catalogue_departures WHERE id = $1", [deps.a.id]),
    /uq_catalogue_departures_product_date_no/, "the same number twice on a date is still refused");
});

test("a 9th traveler opens departure 2, which needs its own 4 to go ahead", { skip }, async () => {
  const first = await bookPublic(on, deps.a, 8, { name: "Full Party" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  let rows = await numbered(deps.a.date);
  assert.deepEqual(rows.map((r) => [r.no, r.seats]), [[1, 8], [2, 0]], "the last seat of departure 1 opened departure 2");
  const ninth = await bookPublic(on, deps.a, 1, { name: "Ninth Traveler" });
  assert.equal(ninth.status, 201, JSON.stringify(ninth.body));
  assert.equal(ninth.body.departureNo, 2);
  rows = await numbered(deps.a.date);
  assert.deepEqual(rows.map((r) => [r.no, r.seats]), [[1, 8], [2, 1]]);
  await cat.runStatusJob({ now: Date.now() });
  rows = await numbered(deps.a.date);
  assert.deepEqual(rows.map((r) => [r.no, r.status]), [[1, "go_ahead"], [2, "open"]], "departure 2 has 1 of 4: it does not go ahead on departure 1's seats");
  assert.equal((await bookPublic(on, deps.a, 3, { name: "More For Two" })).status, 201);
  await cat.runStatusJob({ now: Date.now() });
  assert.deepEqual((await numbered(deps.a.date)).map((r) => [r.no, r.seats, r.status]), [[1, 8, "go_ahead"], [2, 4, "go_ahead"]], "its own 4 make it go ahead");
  assert.equal((await numbered(deps.a.date)).length, 2, "not a third: departure 2 has room");
});

test("a party of 3 when departure 1 has 6 goes whole to departure 2", { skip }, async () => {
  assert.equal((await bookPublic(on, deps.b, 6, { name: "Six" })).status, 201);
  assert.deepEqual((await numbered(deps.b.date)).map((r) => [r.no, r.seats]), [[1, 6]], "6 of 8: departure 1 is not full, so nothing is opened yet");
  const three = await bookPublic(on, deps.b, 3, { name: "Three Together" });
  assert.equal(three.status, 201, JSON.stringify(three.body));
  assert.equal(three.body.departureNo, 2);
  const rows = await numbered(deps.b.date);
  assert.deepEqual(rows.map((r) => [r.no, r.seats]), [[1, 6], [2, 3]], "the party of 3 was not split: all 3 are on departure 2");
  const pledge = await one("SELECT departure_id, seats FROM pledges WHERE id = $1", [three.id]);
  assert.deepEqual([Number(pledge.departure_id), pledge.seats], [rows[1].legacy, 3]);
  // A booking of 2 still fits departure 1 (the lowest number with room).
  assert.equal((await bookPublic(on, deps.b, 2, { name: "Two Fit" })).body.departureNo, 1);
});

test("departure 2 below 4 at the cut-off is cancelled while departure 1 runs", { skip }, async () => {
  await cat.runStatusJob({ now: Date.now() });
  const at = await cutoffOf(deps.b.date);
  await cat.runStatusJob({ now: at + 60000 });
  const rows = await numbered(deps.b.date);
  assert.deepEqual(rows.map((r) => [r.no, r.status]), [[1, "go_ahead"], [2, "cancelled_below_minimum"]],
    "departure 1 (8) runs; departure 2 (3) is cancelled like any other");
  assert.equal(rows[0].seats, 8, "departure 1 keeps every traveler");
  const two = await one("SELECT count(*) FILTER (WHERE status = 'cancelled')::int AS c, count(*)::int AS n FROM pledges WHERE departure_id = $1", [rows[1].legacy]);
  assert.deepEqual([two.c, two.n], [1, 1], "the three travelers of departure 2 are canceled with it (one party booking), and departure 1 is untouched");
});

test("each departure has its own operator offer and its own settlement calculation", { skip }, async () => {
  const [d1, d2] = await numbered(deps.a.date);
  const a1 = await asg.assignByAdmin(db, { departureId: d1.id, operatorId: X, by: "ops" });
  const a2 = await asg.assignByAdmin(db, { departureId: d2.id, operatorId: Y, by: "ops" });
  assert.notEqual(a1.id, a2.id);
  assert.deepEqual([a1.operatorId, a2.operatorId].map(Number), [X, Y]);
  const live = (await db.query("SELECT departure_id, operator_id FROM catalogue_assignments WHERE state IN ('offered','acknowledged') AND departure_id = ANY($1::bigint[]) ORDER BY departure_id", [[d1.id, d2.id]])).rows;
  assert.equal(live.length, 2, "one live offer per departure");
  const e1 = await asg.expectedAmountFor(db, d1.id);
  const e2 = await asg.expectedAmountFor(db, d2.id);
  assert.equal(e1.travelers, 8);
  assert.equal(e2.travelers, 4);
  assert.equal(e1.total, 27142.5, "8 travelers: 2,650 + 2,000 + 8 × 2,650, plus 5%");
  assert.equal(e2.total, 16012.5, "4 travelers: 2,650 + 2,000 + 4 × 2,650, plus 5%");
  const p1 = await poolS.departurePool(db, d1.id);
  const p2 = await poolS.departurePool(db, d2.id);
  assert.deepEqual([p1.economics.pool, p2.economics.pool], [10239.9, 2678.7], "the agreed single-price examples, one per departure");
});

test("the public list shows a date once, with the status of the departure a new booking would join", { skip }, async () => {
  const listed = async (date) => ((await get(on, "/api/bootstrap")).body.departures || []).filter((d) => d.tourProductId === GIZA && d.date === date);
  // Departure 1 full (8) and departure 2 open: the date is shown once, as departure 2.
  assert.equal((await bookPublic(on, deps.d, 8, { name: "Eight" })).status, 201);
  assert.equal((await bookPublic(on, deps.d, 2, { name: "Two More" })).status, 201);
  const rows = await numbered(deps.d.date);
  assert.deepEqual(rows.map((r) => [r.no, r.seats]), [[1, 8], [2, 2]]);
  let shown = await listed(deps.d.date);
  assert.equal(shown.length, 1, "one entry for the date");
  assert.equal(shown[0].id, rows[1].legacy, "the departure a new booking would join (departure 1 is full and never shown as bookable)");
  assert.equal(shown[0].catalogueLabel, "2 of 4 needed");
  // Departure 1 with room: it is the one shown, and departure 2 stays out of the list.
  assert.equal((await bookPublic(on, deps.e, 3, { name: "Three" })).status, 201);
  shown = await listed(deps.e.date);
  assert.deepEqual(shown.map((d) => d.id), [deps.e.legacy]);
  assert.equal(shown[0].catalogueLabel, "1 of 4 needed");
});

test("\"Join my group\": when the joiner doesn't fit, the whole party moves to the next departure together", { skip }, async () => {
  const lead = await bookPublic(on, deps.f, 2, { name: "Party Lead" });
  assert.equal(lead.status, 201, JSON.stringify(lead.body));
  const link = await post(on, `/api/public/bookings/${lead.code}/party`, {});
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const token = decodeURIComponent(link.body.group.url.split("/join/")[1]);
  assert.equal((await bookPublic(on, deps.f, 2, { name: "Party Member", partyToken: token })).status, 201);
  assert.equal((await bookPublic(on, deps.f, 3, { name: "Not In The Party" })).status, 201);
  assert.deepEqual((await numbered(deps.f.date)).map((r) => [r.no, r.seats]), [[1, 7]], "7 of 8: 1 seat left on departure 1");
  const joiner = await bookPublic(on, deps.f, 2, { name: "Party Joiner", partyToken: token });
  assert.equal(joiner.status, 201, JSON.stringify(joiner.body));
  assert.equal(joiner.body.departureNo, 2);
  const rows = await numbered(deps.f.date);
  assert.deepEqual(rows.map((r) => [r.no, r.seats]), [[1, 3], [2, 6]], "the party (2 + 2) and its joiner (2) are together on departure 2; the other booking stays on 1");
  const members = (await db.query("SELECT DISTINCT departure_id FROM pledges WHERE party_id = (SELECT party_id FROM pledges WHERE id = $1) AND status <> 'cancelled'", [lead.id])).rows;
  assert.deepEqual(members.map((m) => Number(m.departure_id)), [rows[1].legacy], "one departure for the whole party: it is never split");
  assert.equal(Number((await one("SELECT departure_id FROM booking_parties WHERE join_token = $1", [token])).departure_id), rows[1].legacy);
});

test("a party over 8 is not booked", { skip }, async () => {
  const before = (await one("SELECT count(*)::int AS n FROM pledges")).n;
  const r = await bookPublic(on, deps.c, 9, { name: "Nine" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await one("SELECT count(*)::int AS n FROM pledges")).n, before, "nothing booked");
  assert.deepEqual((await numbered(deps.c.date)).map((x) => x.no), [1], "and no departure opened for it");
});

test("merging is refused above 8 and allowed within it", { skip }, async () => {
  const TOUR2 = "tour_merge_it";
  await db.query(`INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Merge Tour','Cairo','08:00',4,8,80,64,'approved',true,24)`, [TOUR2]);
  const day = shiftDate(today(), 40);
  const mk = async (id, seats) => {
    await db.query(`INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
                    VALUES ($1,'day_tour',$2,'Merge Tour',$3,'08:00','Cairo',4,8,80,64,'open')`, [id, TOUR2, day]);
    await db.query(`INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, status) VALUES ($1,$2,'direct_customer','Direct traveler',$3,'Guest','confirmed')`, [`pl_mg_${id}`, id, seats]);
  };
  await mk(930001, 5);
  await mk(930002, 4);
  const over = await post(on, "/api/admin/departures/merge", { keptId: 930001, duplicateIds: [930002] }, staff);
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error, /Together they hold 9 travelers; the kept date takes at most 8/);
  await mk(930003, 3);
  const ok = await post(on, "/api/admin/departures/merge/preview", { keptId: 930001, duplicateIds: [930003] }, staff);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.seatsAfter, 8, "5 + 3 fits exactly");
});

test("operator fee: a rate card can't be published with an empty fee", { skip }, async () => {
  const draft = await rates.saveRateDraft(db, productId, { tiers: [{ from: 4, to: 8, priceEgp: 5192, operatorFeePct: "" }], costLines: MODEL.costLines, commissionPct: 10, eurRate: 97 }, { by: "it" });
  await assert.rejects(rates.publishRate({ productId, versionId: draft.id, by: "it" }), /operator fee/i);
  assert.equal((await one("SELECT state FROM catalogue_rate_versions WHERE id = $1", [draft.id])).state, "draft", "still a draft");
  await db.query("DELETE FROM catalogue_rate_versions WHERE id = $1", [draft.id]);
});

test("operator fee: a per-departure override changes that departure's entitlement and pool only", { skip }, async () => {
  const [d1, d2] = await numbered(deps.a.date);
  const base1 = await poolS.departurePool(db, d1.id);
  assert.deepEqual([base1.economics.entitlement, base1.economics.pool], [27142.5, 10239.9]);
  const { setOperatorFeeOverride } = await import("./operator-fee.js");
  // No override without a reason.
  await assert.rejects(setOperatorFeeOverride(db, { departureId: d1.id, pct: 8, reason: " ", by: "boss@sawa.test" }), /reason is required/);
  const done = await setOperatorFeeOverride(db, { departureId: d1.id, pct: 8, reason: "Two vehicles needed", by: "boss@sawa.test" });
  assert.deepEqual([done.from, done.to], [null, 8]);
  const over1 = await poolS.departurePool(db, d1.id);
  // 25,850 operating cost × 1.08 = 27,918.0 exactly; the pool is 41,536 − 27,918 − 4,153.6.
  assert.deepEqual([over1.economics.operatorFeePct, over1.economics.entitlement, over1.economics.pool], [8, 27918, 9464.4]);
  const other = await poolS.departurePool(db, d2.id);
  assert.deepEqual([other.economics.operatorFeePct, other.economics.entitlement, other.economics.pool], [5, 16012.5, 2678.7], "departure 2 keeps the rate card's 5%");
  assert.equal((await asg.expectedAmountFor(db, d1.id)).total, 27918, "the operator's offer shows what applies");
  const row = await one("SELECT operator_fee_pct_override, operator_fee_override_reason, operator_fee_override_by FROM catalogue_departures WHERE id = $1", [d1.id]);
  assert.deepEqual([Number(row.operator_fee_pct_override), row.operator_fee_override_reason, row.operator_fee_override_by], [8, "Two vehicles needed", "boss@sawa.test"], "logged with who changed it");
  // The rate card itself is untouched.
  assert.equal((await one("SELECT (tiers->0->>'operatorFeePct')::numeric AS fee FROM catalogue_rate_versions WHERE product_id = $1 AND state = 'published'", [productId])).fee, "5");
});

test("operator fee: the statements and the margin report show the % used and mark an override", { skip }, async () => {
  const [d1, d2] = await numbered(deps.a.date);
  const m1 = await poolS.departureMoney(db, d1.id);
  assert.deepEqual([m1.lines.operatorFeePct, m1.lines.operatorFeeOverride], [8, true]);
  const m2 = await poolS.departureMoney(db, d2.id);
  assert.deepEqual([m2.lines.operatorFeePct, m2.lines.operatorFeeOverride], [5, false]);
  const label = readFileSync(join(ROOT, "server", "operator-settlement.js"), "utf8");
  assert.match(label, /Operator fee, \$\{l\.operatorFeePct\}%\$\{l\.operatorFeeOverride \? " \(override for this departure\)" : ""\}/);
  assert.match(readFileSync(join(ROOT, "src", "AdminFinance.jsx"), "utf8"), /fee \{r\.lines\.operatorFeePct\}%\{r\.lines\.operatorFeeOverride \? " · override" : ""\}/);
  assert.match(readFileSync(join(ROOT, "server", "commissions.js"), "utf8"), /operatorFeeOverride: e\.feeOverride != null/);
});

test("operator fee: an override is refused once the operator acknowledges the offer", { skip }, async () => {
  const [d1, d2] = await numbered(deps.a.date);
  const { setOperatorFeeOverride } = await import("./operator-fee.js");
  // Until then it can still be changed, and cleared (with a reason).
  assert.equal((await setOperatorFeeOverride(db, { departureId: d2.id, pct: 7, reason: "Longer route", by: "boss@sawa.test" })).to, 7);
  assert.equal((await setOperatorFeeOverride(db, { departureId: d2.id, pct: null, reason: "Back to the card", by: "boss@sawa.test" })).to, null);
  const a = await one("SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND state = 'offered'", [d1.id]);
  await asg.acknowledge(db, { assignmentId: Number(a.id), operatorId: Number(a.operator_id), by: "it" });
  await assert.rejects(setOperatorFeeOverride(db, { departureId: d1.id, pct: 9, reason: "Too late", by: "boss@sawa.test" }), /locked/);
  const viaRoute = await post(on, `/api/admin/catalogue/departures/${d1.id}/operator-fee`, { pct: 9, reason: "Too late" }, staff);
  assert.equal(viaRoute.status, 409, JSON.stringify(viaRoute.body));
  assert.equal(Number((await one("SELECT operator_fee_pct_override AS p FROM catalogue_departures WHERE id = $1", [d1.id])).p), 8, "still 8");
  // Departure 2 is not acknowledged: its own fee is still editable.
  const ok = await post(on, `/api/admin/catalogue/departures/${d2.id}/operator-fee`, { pct: 6, reason: "Its own vehicle" }, staff);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalogue.departure.operator_fee'")).n, 1, "the route change is audited");
});

test("migration 063: a version with several tiers gets a NEW DRAFT from its first tier, never published", { skip }, async () => {
  const p2 = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 2")).rows[0].id);
  await db.query("ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable");
  await db.query(
    `INSERT INTO catalogue_rate_versions (product_id, version, state, effective_from, published_by, published_at, tiers, cost_lines, commission_pct, eur_rate, source, created_by)
     VALUES ($1, 1, 'published', '2026-01-01', 'it', now(),
       '[{"from":4,"to":6,"priceEgp":2540,"operatorFeePct":5},{"from":7,"to":9,"priceEgp":2487,"operatorFeePct":6},{"from":10,"to":12,"priceEgp":2360,"operatorFeePct":10}]'::jsonb,
       '[{"name":"Transport","basis":"per_group","amounts":[2200,2200,3300]},{"name":"Entry","basis":"per_traveller","amounts":[700,700,700]}]'::jsonb, 10, 50, '{}'::jsonb, 'it')`, [p2]);
  await db.query("ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable");
  const sql = readFileSync(join(ROOT, "server", "db", "schema_063_numbered_departures.sql"), "utf8");
  await db.query(sql);
  const versions = (await db.query("SELECT version, state, tiers, cost_lines, commission_pct, eur_rate, source FROM catalogue_rate_versions WHERE product_id = $1 ORDER BY version", [p2])).rows;
  assert.deepEqual(versions.map((v) => [v.version, v.state]), [[1, "published"], [2, "draft"]], "a new draft; the published version is untouched");
  assert.equal(versions[0].tiers.length, 3, "the published version still has its three tiers");
  assert.deepEqual(versions[1].tiers, [{ from: 4, to: 8, priceEgp: 2540, operatorFeePct: 5 }], "the first tier's price and fee, as one tier 4–8");
  assert.deepEqual(versions[1].cost_lines.map((l) => [l.name, l.amounts]), [["Transport", [2200]], ["Entry", [700]]], "the first tier's cost amounts");
  assert.deepEqual([Number(versions[1].commission_pct), Number(versions[1].eur_rate)], [10, 50]);
  assert.match(versions[1].source.migration063.from, /version 1 \(published\)/);
  await db.query(sql);
  assert.equal((await db.query("SELECT 1 FROM catalogue_rate_versions WHERE product_id = $1", [p2])).rowCount, 2, "a second run makes no second draft");
});
