// Reservation integrity (migration 057, catalogue_v2) on a real Postgres:
//
//   clusters    three single-seat reservations on one date within 6 hours
//               sharing a device, a network or a phone country code are
//               flagged with the reason, never refused; staff mark them a
//               confirmed group (linked as a party), suspicious (held from
//               GoAhead until reviewed) or clear them; audited
//   privacy     only hashes, /24 prefixes and country codes are stored,
//               deleted at 30 days; the privacy page's sentence goes out
//               with the flag
//   058         a booking made from the email-confirmation link carries the
//               signals of the form it was submitted from
//   flag off    nothing of the above
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
import { shiftDate } from "../shared/catalogue.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_booking_integrity";
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000095", email: "boss@sawa.test", role: "super_admin" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, pag, integ;
let productId, X, on, off, held;
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
  integ = await import("./booking-integrity.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await cat.generateDepartures({ materialise: true });
  const rd = await rates.saveRateDraft(db, productId, { perTraveler: 2200, fee4_6: 1500, fee7_9: 2000, fee10_12: 2600, commissionPerSeat: 10 }, { by: "it" });
  await rates.publishRate({ productId, versionId: rd.id, by: "it" });
  X = (await ops.createOperator(db, { legalName: "Nile Tours S.A.E.", email: "dispatch@nile-tours.test" }, "it")).id;
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, X, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await ops.setApprovals(db, X, [productId], "it");
  await ops.setOperatorStatus(db, X, "active", { by: "it" });

  const r = await db.query(
    `SELECT id, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 5`, [productId, today()]);
  [deps.a, deps.b, deps.c, deps.d, deps.e] = r.rows.map((x) => ({ id: Number(x.id), legacy: Number(x.legacy_departure_id) }));
  on = await startServer({ FEATURES: "catalogue_v2", TRUST_PROXY: "1" });
  off = await startServer({ FEATURES: "", TRUST_PROXY: "1" });
  held = await startServer({ FEATURES: "catalogue_v2", TRUST_PROXY: "1", BOOKING_EMAIL_CONFIRMATION: "on" });
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
// A complete direct booking through the public route, from a given network,
// browser and phone.
async function book(base, dep, seats, { ip = null, ua = "Mozilla/5.0 (Test)", hint = "1920|1080", phone = null, name = null } = {}) {
  seq += 1;
  const lead = name || `Traveler ${seq}`;
  const res = await fetch(`${base}/api/public/departures/${dep.legacy}/bookings`, {
    method: "POST", headers: { ...json, "User-Agent": ua, "X-Forwarded-For": ip || `10.${seq}.0.1` },
    body: JSON.stringify({
      customerName: lead, customerEmail: `t${seq}@example.test`, customerPhone: phone || `+44770090${String(seq).padStart(4, "0")}`, seats,
      travelerNames: Array.from({ length: seats }, (_, i) => (i === 0 ? lead : `${lead} guest ${i + 1}`)),
      pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true, deviceHint: hint,
    }),
  });
  const b = await res.json().catch(() => ({}));
  return { status: res.status, body: b, id: b.booking?.id, code: b.booking?.bookingCode };
}
const post = (base, path, body, headers = json) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (base, path, headers = {}) => fetch(`${base}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const seatsOf = (dep) => one("SELECT s.seats_sold, g.goahead_seats FROM catalogue_departure_seats s JOIN catalogue_departure_goahead g USING (catalogue_departure_id) WHERE s.catalogue_departure_id = $1", [dep.id]);
const legacyStatus = async (dep) => (await one("SELECT status FROM departures WHERE id = $1", [dep.legacy])).status;

test("three single-seat reservations within 6 hours sharing a device, network or phone country are flagged with the reason, never refused", { skip }, async () => {
  const same = { ip: "41.33.12.7", ua: "Mozilla/5.0 (Bot)", hint: "800|600", phone: "+201001112233" };
  const c1 = await book(on, deps.c, 1, same);
  const c2 = await book(on, deps.c, 1, { ...same, ip: "41.33.12.99", phone: "+201001112244" });
  assert.equal((await db.query("SELECT 1 FROM booking_flags")).rowCount, 0, "two aren't a cluster");
  const c3 = await book(on, deps.c, 1, { ...same, ip: "41.33.12.150", phone: "+201001112255" });
  for (const b of [c1, c2, c3]) assert.equal(b.status, 201, "a flag never refuses a booking");
  const flag = await one("SELECT * FROM booking_flags WHERE departure_id = $1", [deps.c.legacy]);
  assert.ok(flag);
  assert.deepEqual([...flag.pledge_ids].sort(), [c1.id, c2.id, c3.id].sort());
  assert.deepEqual(flag.reasons.map((r) => [r.kind, r.value, r.count]).sort(),
    [["device", "same device", 3], ["ip", "41.33.12.0/24", 3], ["phone_cc", "+20", 3]].sort());
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'booking_flag.raise' AND entity_id = $1", [String(flag.id)]));
  assert.equal(await legacyStatus(deps.c), "open", "three seats, under the minimum of four");

  // What is stored: a hash, a /24 and a country code; never the raw values.
  const sig = await one("SELECT * FROM booking_signals WHERE pledge_id = $1", [c1.id]);
  assert.match(sig.device_hash, /^[0-9a-f]{32}$/);
  assert.deepEqual([sig.ip_prefix, sig.phone_cc], ["41.33.12.0/24", "+20"]);
  assert.ok(!JSON.stringify(sig).includes("41.33.12.7") && !JSON.stringify(sig).includes("1001112233"));

  // Outside 6 hours they don't cluster.
  const far = { ip: "196.1.1.1", ua: "Mozilla/5.0 (Slow)", hint: "1|1", phone: "+33612345678" };
  await book(on, deps.d, 1, far);
  await book(on, deps.d, 1, { ...far, phone: "+33612345679" });
  await db.query("UPDATE booking_signals SET created_at = created_at - interval '7 hours' WHERE departure_id = $1", [deps.d.legacy]);
  await book(on, deps.d, 1, { ...far, phone: "+33612345670" });
  assert.equal((await db.query("SELECT 1 FROM booking_flags WHERE departure_id = $1", [deps.d.legacy])).rowCount, 0);
  s.c = { flagId: flag.id, same };

  // The admin calendar shows the flag with its reasons.
  const cal = await get(on, "/api/admin/catalogue/departures", staff);
  const row = cal.body.departures.find((d) => d.id === deps.c.id);
  assert.equal(row.flags.length, 1);
  assert.deepEqual([row.flags[0].state, row.flags[0].seats, row.flags[0].bookings.length], ["open", 3, 3]);
  assert.equal(row.flags[0].reasons.length, 3);
});

test("staff mark a cluster suspicious (held from GoAhead until reviewed), clear it on review, or confirm it as a group (linked as a party)", { skip }, async () => {
  assert.equal((await post(on, `/api/admin/booking-flags/${s.c.flagId}/decision`, { decision: "suspicious" })).status, 401, "staff only");
  const sus = await post(on, `/api/admin/booking-flags/${s.c.flagId}/decision`, { decision: "suspicious" }, staff);
  assert.equal(sus.status, 200, JSON.stringify(sus.body));
  // A fourth joins the suspicious flag and is held too; a two-seat booking is
  // never part of one. Six seats sold would reach the minimum; two count.
  const c4 = await book(on, deps.c, 1, { ...s.c.same, ip: "41.33.12.201", phone: "+201001112266" });
  const two = await book(on, deps.c, 2, s.c.same);
  const grown = await one("SELECT * FROM booking_flags WHERE id = $1", [s.c.flagId]);
  assert.equal(grown.pledge_ids.length, 4);
  assert.ok(grown.pledge_ids.includes(c4.id) && !grown.pledge_ids.includes(two.id));
  assert.deepEqual(await seatsOf(deps.c), { seats_sold: 6, goahead_seats: 2 });
  assert.equal(await legacyStatus(deps.c), "open");
  await cat.runStatusJob({});
  assert.equal((await one("SELECT status FROM catalogue_departures WHERE id = $1", [deps.c.id])).status, "open");
  const cal = await get(on, "/api/admin/catalogue/departures", staff);
  const row = cal.body.departures.find((d) => d.id === deps.c.id);
  assert.deepEqual([row.flags[0].state, row.goaheadSeats, row.seatsSold], ["suspicious", 2, 6]);

  const cleared = await post(on, `/api/admin/booking-flags/${s.c.flagId}/decision`, { decision: "cleared", note: "Called them: one family." }, staff);
  assert.equal(cleared.status, 200);
  assert.equal(await legacyStatus(deps.c), "minimum_reached", "reviewed: the seats count again");
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'booking_flag.suspicious'"));
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'booking_flag.cleared' AND detail->>'note' = 'Called them: one family.'"));
  assert.equal((await post(on, `/api/admin/booking-flags/${s.c.flagId}/decision`, { decision: "suspicious" }, staff)).status, 409, "decided");

  // A cluster on another date, confirmed as a group: linked as one party.
  const same = { ip: "62.114.9.1", ua: "Mozilla/5.0 (Family)", hint: "390|844", phone: "+491511234560" };
  const e = [];
  for (let i = 0; i < 3; i++) e.push(await book(on, deps.e, 1, { ...same, ip: `62.114.9.${i + 1}`, phone: `+49151123456${i}` }));
  const f = await one("SELECT id FROM booking_flags WHERE departure_id = $1", [deps.e.legacy]);
  const grp = await post(on, `/api/admin/booking-flags/${f.id}/decision`, { decision: "confirmed_group" }, staff);
  assert.equal(grp.status, 200, JSON.stringify(grp.body));
  assert.ok(grp.body.partyId);
  const parties = (await db.query("SELECT DISTINCT party_id FROM pledges WHERE id = ANY($1::text[])", [e.map((x) => x.id)])).rows;
  assert.deepEqual(parties.map((r) => Number(r.party_id)), [grp.body.partyId]);
  assert.equal((await one("SELECT state FROM booking_flags WHERE id = $1", [f.id])).state, "confirmed_group");
  const after = await get(on, "/api/admin/catalogue/departures", staff);
  assert.deepEqual(after.body.departures.find((d) => d.id === deps.e.id).flags, [], "a decided flag leaves the calendar");
});

test("a booking made from the email-confirmation link (058) carries the signals of the form it was submitted from", { skip }, async () => {
  const b = await book(held, deps.b, 1, { ip: "81.10.20.30", ua: "Mozilla/5.0 (Held)", hint: "1|2", phone: "+447700900111" });
  assert.equal(b.status, 202, JSON.stringify(b.body));
  const code = b.body.booking.bookingCode;
  const hold = await one("SELECT * FROM booking_confirmations WHERE booking_code = $1", [code]);
  assert.deepEqual([hold.payload.signals.ipPrefix, hold.payload.signals.phoneCc], ["81.10.20.0/24", "+44"], "reduced when held");
  assert.ok(!JSON.stringify(hold.payload).includes("81.10.20.30"), "the raw address isn't kept");
  assert.equal((await db.query("SELECT 1 FROM booking_signals s JOIN pledges p ON p.id = s.pledge_id WHERE p.booking_code = $1", [code])).rowCount, 0);
  await db.query("UPDATE booking_confirmations SET created_at = now() - interval '2 hours' WHERE id = $1", [hold.id]);
  const token = `tok-${code}`;
  await db.query("UPDATE booking_confirmations SET token_hash = $2 WHERE id = $1", [hold.id, createHash("sha256").update(token).digest("hex")]);
  // Confirmed from another network: the signals are still the form's.
  const r = await fetch(`${held}/api/public/booking-confirmations/${token}`, { method: "POST", headers: { ...json, "X-Forwarded-For": "5.5.5.5" } });
  assert.equal((await r.json()).state, "confirmed");
  const sig = await one("SELECT s.* FROM booking_signals s JOIN pledges p ON p.id = s.pledge_id WHERE p.booking_code = $1", [code]);
  assert.deepEqual([sig.ip_prefix, sig.phone_cc], ["81.10.20.0/24", "+44"]);
  assert.ok(Date.now() - new Date(sig.created_at).getTime() > 1.5 * HOUR, "dated when the form was submitted");
});

test("signals are deleted after 30 days and the values on older flags blanked", { skip }, async () => {
  await db.query("UPDATE booking_signals SET created_at = now() - interval '31 days' WHERE departure_id = $1", [deps.c.legacy]);
  await db.query("UPDATE booking_flags SET created_at = now() - interval '31 days' WHERE departure_id = $1", [deps.c.legacy]);
  const out = await integ.purgeSignals({ db });
  assert.ok(out.signalsPurged >= 5);
  assert.equal((await db.query("SELECT 1 FROM booking_signals WHERE departure_id = $1", [deps.c.legacy])).rowCount, 0);
  assert.ok((await db.query("SELECT 1 FROM booking_signals")).rowCount > 0, "newer signals stay");
  const f = await one("SELECT reasons FROM booking_flags WHERE id = $1", [s.c.flagId]);
  assert.deepEqual(f.reasons.map((r) => [r.kind, r.value]).sort(), [["device", undefined], ["ip", undefined], ["phone_cc", undefined]]);
});

test("the privacy page's sentence goes out with the flag", { skip }, async () => {
  const withFlag = await fetch(`${on}/privacy`).then((r) => r.text());
  const without = await fetch(`${off}/privacy`).then((r) => r.text());
  assert.match(withFlag, /one-way \(hashed\) fingerprint/);
  assert.match(withFlag, /deleted after 30 days/);
  assert.doesNotMatch(without, /hashed\) fingerprint|reservation signals/);
  assert.doesNotMatch(without, /catalogue_v2/);
});

test("with catalogue_v2 off: no signals, no flags, and the routes answer 404", { skip }, async () => {
  const before = Number((await one("SELECT COUNT(*) AS n FROM booking_signals")).n);
  const res = await fetch(`${off}/api/public/departures/${deps.d.legacy}/bookings`, {
    method: "POST", headers: json, body: JSON.stringify({ customerName: "Flag Off", customerEmail: "off@example.test", seats: 1 }),
  });
  assert.equal(res.status, 201, await res.text());
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM booking_signals")).n), before);
  assert.equal((await post(off, `/api/admin/booking-flags/${s.c.flagId}/decision`, { decision: "cleared" }, staff)).status, 404);
});
