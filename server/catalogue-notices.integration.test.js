// Phase 1 gap — the below-minimum cancellation notice, on a real Postgres:
// sent once per traveler, copied to the agency for agency bookings, safe to
// re-run, with the next dates and a same-city alternative. Skips without
// TEST_DATABASE_URL (see test-db.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { zonedDateTimeToUtc } from "./tz.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_catalogue_notices";
const HOUR = 3600000;
const ON = { FEATURES: "catalogue_v2" };
let db, cat, notices;

const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const MEMPHIS = "tour_memphis_saqqara_dahshur_birth_of_mq41k505";

before(async () => {
  if (skip) return;
  const dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("TRUNCATE catalogue_products CASCADE");
  for (const [id, title] of [[GIZA, "Giza Pyramids, Sphinx & the Grand Egyptian Museum"], [MEMPHIS, "Memphis, Saqqara & Dahshur — Birth of the Pyramid"]]) {
    await db.query(
      `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                  booking_cutoff_hours, included, not_included)
       VALUES ($1,'day_tour',$2,'Cairo','08:00',4,12,100,80,'approved',true,24,'["Guide"]','["Tips"]')`, [id, title]);
  }
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_x', 'Agency X')");
  await db.query(`INSERT INTO app_users (id, email, role, agency_id) VALUES
    ('00000000-0000-4000-8000-000000000031', 'owner@agency-x.test', 'agency_owner', 'ag_x'),
    ('00000000-0000-4000-8000-000000000032', 'agent@agency-x.test', 'agency_agent', 'ag_x')`);

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  cat = await import("./catalogue.js");
  notices = await import("./catalogue-notices.js");
  for (const no of [1, 4]) {
    const pid = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = $1", [no])).rows[0].id);
    const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [pid])).rows[0].id;
    await cat.publishDraft({ productId: pid, versionId: Number(draft), by: "it" });
  }
  await cat.generateDepartures({ materialise: true });
});

after(async () => {
  if (skip) return;
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  await dropDatabase(DB_NAME);
});

async function pledge(departureId, { email, agencyId = "direct_customer", agency = "Direct", name }) {
  const id = `pl_n_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, status, source)
     VALUES ($1,$2,$3,$4,1,$5,$6,'confirmed','public')`, [id, departureId, agencyId, agency, name, email]);
  return id;
}

test("a below-minimum cancellation emails each traveler once, copies the agency, and says what to book instead", { skip }, async () => {
  const pid = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const dep = (await db.query(
    `SELECT * FROM catalogue_departures WHERE product_id = $1 AND legacy_departure_id IS NOT NULL
       AND date >= (now() AT TIME ZONE 'Africa/Cairo')::date + 5 ORDER BY date LIMIT 1`, [pid])).rows[0];
  const date = dep.date.toISOString().slice(0, 10);
  await pledge(dep.legacy_departure_id, { email: "ana@example.test", name: "Ana" });
  await pledge(dep.legacy_departure_id, { email: "ben@example.test", name: "Ben", agencyId: "ag_x", agency: "Agency X" });
  // Someone who had already canceled on their own is not told again.
  const earlier = await pledge(dep.legacy_departure_id, { email: "cleo@example.test", name: "Cleo" });
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [earlier]);

  const cutoff = zonedDateTimeToUtc(date, "08:00") - 48 * HOUR;
  await cat.runStatusJob({ now: cutoff + 60000 });

  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  const first = await notices.runCancellationNotices({ send, env: ON });
  assert.equal(first.sent, 3, JSON.stringify(first));
  const to = sent.map((m) => m.to).sort();
  assert.deepEqual(to, ["ana@example.test", "ben@example.test", "owner@agency-x.test"]);

  const ana = sent.find((m) => m.to === "ana@example.test");
  assert.match(ana.subject, /won't run/);
  assert.match(ana.text, /Nothing was charged/);
  assert.match(ana.text, /Other dates for this tour:/);
  assert.match(ana.text, /Or try Memphis, Saqqara & Dahshur: Birth of the Pyramid/, "an alternative from the same city");
  const copy = sent.find((m) => m.to === "owner@agency-x.test");
  assert.match(copy.subject, /^Copy:/);
  assert.match(copy.text, /Ben/);

  // Re-running sends nothing more.
  const again = await notices.runCancellationNotices({ send, env: ON });
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 3);
  const rows = (await db.query("SELECT status, kind FROM catalogue_notices ORDER BY id")).rows;
  assert.deepEqual(rows.map((r) => r.status), ["sent", "sent", "sent"]);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["agency_copy", "traveler", "traveler"]);
});

test("a failed send is recorded and retried; a booking with a payment is told it is being refunded", { skip }, async () => {
  const pid = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const dep = (await db.query(
    `SELECT * FROM catalogue_departures WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open'
       AND date >= (now() AT TIME ZONE 'Africa/Cairo')::date + 20 ORDER BY date LIMIT 1`, [pid])).rows[0];
  const date = dep.date.toISOString().slice(0, 10);
  const paidPledge = await pledge(dep.legacy_departure_id, { email: "dina@example.test", name: "Dina" });
  await db.query(
    `INSERT INTO booking_payments (pledge_id, kind, amount, link_url, link_sent_at, due_at, due_bound_by, state, paid_at, provider_reference)
     VALUES ($1, 'full', 100, 'https://pay.tab.travel/x', now(), now() + interval '3 days', 'window', 'paid', now(), 'TAB-1')`, [paidPledge]);
  await cat.runStatusJob({ now: zonedDateTimeToUtc(date, "08:00") - 47 * HOUR });

  let fail = true;
  const sent = [];
  const send = async (m) => { if (fail) return { ok: false, error: "provider down" }; sent.push(m); return { ok: true }; };
  const first = await notices.runCancellationNotices({ send, env: ON });
  assert.equal(first.failed, 1);
  const row = (await db.query("SELECT * FROM catalogue_notices WHERE pledge_id = $1", [paidPledge])).rows[0];
  assert.equal(row.status, "failed");
  assert.match(row.last_error, /provider down/);

  fail = false;
  const second = await notices.runCancellationNotices({ send, env: ON });
  assert.equal(second.sent, 1);
  assert.match(sent[0].text, /being refunded in full/);
});

test("with catalogue_v2 off nothing is sent", { skip }, async () => {
  const r = await notices.runCancellationNotices({ send: async () => { throw new Error("must not send"); }, env: {} });
  assert.deepEqual(r, { skipped: "catalogue_v2 is off" });
});
