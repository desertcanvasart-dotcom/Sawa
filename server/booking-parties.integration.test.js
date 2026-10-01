// Group bookings (migration 056, catalogue_v2) on a real Postgres:
//
//   link        a booking's "Join my group" link: made once, the same link
//               after; shows the lead's first name and the seats left
//   join        a booking through the link books the same date and joins the
//               party; refused past the free seats, on another date, or with a
//               bad token
//   payment     each member gets its own full-price request at GoAhead (mode C)
//   manifest    a party's bookings together, lead first, one contact number
//   admin       link bookings into a party, unlink them; audited; refused
//               across dates or across two parties
//   flag off    the routes answer 404 and a token in the body is ignored
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createHash } from "node:crypto";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { makeToursBookable } from "./test-rate-cards.js";
import { shiftDate } from "../shared/catalogue.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_booking_parties";
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000091", email: "boss@sawa.test", role: "super_admin" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, pag;
let productId, X, on, off;
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
  X = (await ops.createOperator(db, { legalName: "Nile Tours S.A.E.", email: "dispatch@nile-tours.test" }, "it")).id;
  for (const kind of ["tourism_license", "commercial_registration", "tax_card", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, X, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await ops.setApprovals(db, X, [productId], "it");
  await ops.setOperatorStatus(db, X, "active", { by: "it" });

  const r = await db.query(
    `SELECT id, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 3`, [productId, today()]);
  [deps.a, deps.b, deps.c] = r.rows.map((x) => ({ id: Number(x.id), legacy: Number(x.legacy_departure_id) }));
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

test("a booking's group link: made once, the same link after; it shows the lead's first name and the seats left", { skip }, async () => {
  const lead = await bookPublic(on, deps.a, 2, { name: "Ana Lima" });
  assert.equal(lead.status, 201, JSON.stringify(lead.body));
  s.lead = lead;
  const page = await get(on, `/api/public/bookings/${lead.code}`);
  assert.deepEqual(page.body.booking.group, { url: null }, "the booking page offers a link before one exists");

  const made = await post(on, `/api/public/bookings/${lead.code}/party`);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(made.body.group.url, /\/join\/[A-Za-z0-9_-]{16}$/);
  assert.equal(made.body.group.seatsLeft, 6);
  const again = await post(on, `/api/public/bookings/${lead.code}/party`);
  assert.equal(again.body.group.url, made.body.group.url, "the same link every time, so a link already shared keeps working");
  s.token = decodeURIComponent(made.body.group.url.split("/join/")[1]);
  assert.equal((await db.query("SELECT 1 FROM booking_parties")).rowCount, 1);
  assert.equal((await one("SELECT party_id FROM pledges WHERE id = $1", [lead.id])).party_id != null, true);

  const view = await get(on, `/api/public/parties/${s.token}`);
  assert.equal(view.status, 200);
  assert.deepEqual([view.body.group.leadFirstName, view.body.group.seats, view.body.seatsLeft, view.body.bookable, view.body.departure.id],
    ["Ana", 2, 6, true, deps.a.legacy]);
  assert.match(view.body.departure.path, /^\/tour\//);
  const pageAfter = await get(on, `/api/public/bookings/${lead.code}`);
  assert.deepEqual(pageAfter.body.booking.group, { url: made.body.group.url, bookings: 1, seats: 2, seatsLeft: 6 });
  const audit = await one("SELECT * FROM audit_log WHERE action = 'party.create'");
  assert.ok(audit, "the party's creation is audited");
  assert.equal((await get(on, "/api/public/parties/not-a-token")).status, 404);
});

test("booking through the link joins the same date and party; refused past the free seats, on another date, or with a bad token", { skip }, async () => {
  // A booking outside the group lands between the lead and the member.
  s.other = await bookPublic(on, deps.a, 1, { name: "Omar Said" });
  assert.equal(s.other.status, 201);
  const member = await bookPublic(on, deps.a, 3, { name: "Bea Costa", partyToken: s.token });
  assert.equal(member.status, 201, JSON.stringify(member.body));
  s.member = member;
  const party = Number((await one("SELECT party_id FROM pledges WHERE id = $1", [s.lead.id])).party_id);
  assert.equal(Number((await one("SELECT party_id FROM pledges WHERE id = $1", [member.id])).party_id), party);
  assert.equal((await one("SELECT party_id FROM pledges WHERE id = $1", [s.other.id])).party_id, null);
  const joined = await one("SELECT detail FROM audit_log WHERE action = 'booking.create' AND entity_id = $1", [member.id]);
  assert.equal(Number(joined.detail.partyId), party);
  assert.equal((await get(on, `/api/public/parties/${s.token}`)).body.seatsLeft, 2);

  // The party holds 5 (2 + 3) and the date has 2 left. 4 more would make a party of 9, more
  // than a departure holds: refused, and the party is not split. (A joiner that fits on the
  // next departure moves the whole party there: see phase6.integration.test.js.)
  const tooMany = await bookPublic(on, deps.a, 4, { partyToken: s.token });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.body.error, /Only 2 seats are left on this date/);
  const otherDate = await bookPublic(on, deps.b, 1, { partyToken: s.token });
  assert.equal(otherDate.status, 409);
  assert.match(otherDate.body.error, /different date/);
  const bad = await bookPublic(on, deps.a, 1, { partyToken: "nope" });
  assert.equal(bad.status, 404);
  assert.equal(Number((await one("SELECT COALESCE(SUM(seats),0) AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [deps.a.legacy])).n), 6,
    "no refused booking took a seat");
});

test("at GoAhead each member gets its own full-price payment request", { skip }, async () => {
  await cat.runStatusJob({});
  assert.equal((await one("SELECT status FROM catalogue_departures WHERE id = $1", [deps.a.id])).status, "go_ahead");
  await db.query(
    `INSERT INTO catalogue_assignments (departure_id, operator_id, source, assigned_by, ack_due_at, state, acknowledged_at, acknowledged_by)
     VALUES ($1, $2, 'admin', 'it', now() + interval '4 hours', 'acknowledged', now(), 'it')`, [deps.a.id, X]);
  await pag.runPayAtGoAheadTick({ db, now: Date.now(), send: async () => ({ ok: true }) });
  const req = async (id) => one("SELECT * FROM payment_requests WHERE pledge_id = $1", [id]);
  const lead = await req(s.lead.id);
  const member = await req(s.member.id);
  assert.ok(lead && member, "one request each");
  assert.deepEqual([lead.payer, Number(lead.amount_eur), lead.reference], ["traveller", 190, s.lead.code]);
  assert.deepEqual([member.payer, Number(member.amount_eur), member.reference], ["traveller", 285, s.member.code]);
  assert.equal((await db.query("SELECT 1 FROM payment_requests WHERE pledge_id = ANY($1::text[])", [[s.lead.id, s.member.id]])).rowCount, 2);
});

test("the operator's manifest lists the party together, lead first, with one contact number", { skip }, async () => {
  const m = await asg.manifestFor(db, { departureId: deps.a.id });
  assert.deepEqual(m.travelers.map((t) => t.booking), [s.lead.code, s.lead.code, s.member.code, s.member.code, s.member.code, s.other.code]);
  const [leadRow, , memberRow] = m.travelers;
  assert.deepEqual([leadRow.lead, leadRow.contactNumber != null, leadRow.party], [true, true, { lead: "Ana Lima", leadBooking: s.lead.code, size: 5 }]);
  assert.deepEqual([memberRow.lead, memberRow.contactNumber, memberRow.party.leadBooking], [false, null, s.lead.code]);
  const otherRow = m.travelers[5];
  assert.deepEqual([otherRow.lead, otherRow.party, otherRow.contactNumber != null], [true, undefined, true], "a booking outside the party is unchanged");
  assert.equal(m.seatCount, 6);
});

test("admin links bookings into a party and unlinks them; audited; refused across dates or across two parties", { skip }, async () => {
  const b1 = await bookPublic(on, deps.b, 1);
  const b2 = await bookPublic(on, deps.b, 2);
  const c1 = await bookPublic(on, deps.c, 1);
  assert.equal((await post(on, "/api/admin/parties/link", { ids: [b1.id, b2.id] })).status, 401, "staff only");

  const across = await post(on, "/api/admin/parties/link", { ids: [b1.id, c1.id] }, staff);
  assert.equal(across.status, 409);
  assert.match(across.body.error, /same date/);

  const linked = await post(on, "/api/admin/parties/link", { ids: [b1.id, b2.id] }, staff);
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.created, true);
  const pb = linked.body.partyId;
  assert.equal((await one("SELECT lead_pledge_id FROM booking_parties WHERE id = $1", [pb])).lead_pledge_id, b1.id, "the earliest booking leads");
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'party.link' AND entity_id = $1", [String(pb)]));
  const list = await fetch(`${on}/api/admin/bookings`, { headers: staff }).then((r) => r.json());
  assert.equal(list.bookings.find((b) => b.id === b2.id).partyId, pb);

  // On date A: the booking outside the party joins it.
  const joinA = await post(on, "/api/admin/parties/link", { ids: [s.lead.id, s.other.id] }, staff);
  assert.equal(joinA.status, 200);
  assert.deepEqual([joinA.body.created, joinA.body.linked], [false, [s.other.id]]);
  // Two parties at once are refused.
  const b3 = await bookPublic(on, deps.b, 1);
  const b4 = await bookPublic(on, deps.b, 1);
  const pb2 = (await post(on, "/api/admin/parties/link", { ids: [b3.id, b4.id] }, staff)).body.partyId;
  assert.notEqual(pb2, pb);
  const two = await post(on, "/api/admin/parties/link", { ids: [b1.id, b3.id] }, staff);
  assert.equal(two.status, 409);
  assert.match(two.body.error, /two different groups/);

  // Unlinking the lead hands the lead to the earliest remaining booking;
  // unlinking the last one removes the party and its link.
  const u1 = await post(on, "/api/admin/parties/unlink", { ids: [b1.id] }, staff);
  assert.equal(u1.status, 200, JSON.stringify(u1.body));
  assert.equal((await one("SELECT lead_pledge_id FROM booking_parties WHERE id = $1", [pb])).lead_pledge_id, b2.id);
  const u2 = await post(on, "/api/admin/parties/unlink", { ids: [b2.id] }, staff);
  assert.deepEqual(u2.body.removedParties, [pb]);
  assert.equal((await db.query("SELECT 1 FROM booking_parties WHERE id = $1", [pb])).rowCount, 0);
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'party.unlink'"));
  assert.equal((await post(on, "/api/admin/parties/unlink", { ids: [b1.id] }, staff)).status, 409, "not in a group");
});

test("with catalogue_v2 off the party routes answer 404 and a token in a booking is ignored", { skip }, async () => {
  assert.equal((await post(off, `/api/public/bookings/${s.lead.code}/party`)).status, 404);
  assert.equal((await get(off, `/api/public/parties/${s.token}`)).status, 404);
  assert.equal((await post(off, "/api/admin/parties/link", { ids: ["x", "y"] }, staff)).status, 404);
  const res = await fetch(`${off}/api/public/departures/${deps.c.legacy}/bookings`, {
    method: "POST", headers: json,
    body: JSON.stringify({ customerName: "Flag Off", customerEmail: "off@example.test", seats: 1, partyToken: s.token }),
  });
  assert.equal(res.status, 201, await res.text());
  const made = await one("SELECT party_id FROM pledges WHERE customer_email = 'off@example.test'");
  assert.equal(made.party_id, null);
  const page = await get(off, `/api/public/bookings/${s.lead.code}`);
  assert.equal(page.body.booking.group, null);
});

test("email confirmation (058) holds a catalog booking too; confirming makes it a pay-at-GoAhead booking with its details", { skip }, async () => {
  const held = await startServer({ FEATURES: "catalogue_v2", BOOKING_EMAIL_CONFIRMATION: "on" });
  const before = Number((await one("SELECT COUNT(*) AS n FROM pledges WHERE departure_id = $1", [deps.c.legacy])).n);
  const b = await bookPublic(held, deps.c, 2, { name: "Held Traveler" });
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const code = b.body.booking.bookingCode;
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM pledges WHERE departure_id = $1", [deps.c.legacy])).n), before, "nothing counts yet");
  const token = `tok-${code}`;
  await db.query("UPDATE booking_confirmations SET token_hash = $2 WHERE booking_code = $1", [code, createHash("sha256").update(token).digest("hex")]);
  const c = await post(held, `/api/public/booking-confirmations/${token}`);
  assert.deepEqual([c.status, c.body.state], [200, "confirmed"]);
  const p = await one("SELECT * FROM pledges WHERE booking_code = $1", [code]);
  assert.deepEqual([p.payment_mode, p.terms_fixed_by, p.pickup_point, p.seats], ["pay_at_goahead", "traveller", "Mena House", 2]);
  assert.deepEqual(p.traveller_names, ["Held Traveler", "Held Traveler guest 2"]);
});
