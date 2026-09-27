// Model phase 1 — the catalogue and departure calendar, end to end: the real
// migrations on an empty Postgres, the jobs run in-process with a chosen
// clock, and the real server (flag off, then flag on) driven over HTTP.
// Runs when TEST_DATABASE_URL is set (see test-db.js), and skips otherwise.
//
// The first test is the flag-off guarantee: with catalogue_v2 off, the public
// site and booking behave exactly as before, and the catalogue jobs change
// nothing a traveller can see.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { tourPath } from "../shared/slug.js";
import { shiftDate, weekdayOf } from "../shared/catalogue.js";
import { zonedDateTimeToUtc } from "./tz.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_catalogue";
const HOUR = 3600000;
let db, dbUrl, fakeAuth, cat, servers = [];

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const OPS = { token: "ops-token", id: "00000000-0000-4000-8000-000000000021", email: "ops@sawa.test", role: "super_admin" };

// The listings the catalogue links to, by the ids the seed knows.
const L = {
  giza: { id: "tour_giza_pyramids_sphinx_the_grand_e_mq41k335", type: "day_tour", title: "Giza Pyramids, Sphinx & the Grand Egyptian Museum", city: "Cairo" },
  edfu: { id: "tour_luxor_to_aswan_edfu_kom_ombo_tem_mq40h77c", type: "day_tour", title: "Luxor to Aswan — Edfu & Kom Ombo Temple Road", city: "Luxor" },
  esna: { id: "tour_luxor_to_aswan_esna_edfu_kom_omb_mq41ke7h", type: "day_tour", title: "Luxor to Aswan — Esna, Edfu & Kom Ombo Temple Road", city: "Luxor" },
  majesty: { id: "pkg_nile_majesty_luxor_5d", type: "package", title: "Nile Majesty — 5-Day River Cruise from Luxor", city: "Luxor", nights: 4 },
};

async function startServer(extraEnv) {
  const port = 19000 + Math.floor(Math.random() * 900);
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
    if ((req.headers.authorization || "") !== `Bearer ${OPS.token}`) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: OPS.id, email: OPS.email, aud: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));

  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();

  // Listings first, then the catalogue seed again, the order production sees:
  // the seed links products to listings and copies their text into the drafts.
  await db.query("TRUNCATE catalogue_products CASCADE");
  for (const t of Object.values(L)) {
    await db.query(
      `INSERT INTO tour_products (id, type, title, city, nights, cities, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                  booking_cutoff_hours, included, not_included, duration)
       VALUES ($1,$2,$3,$4,$5,$6,'08:00',4,12,100,80,'approved',true,24,$7,$8,'Full day')`,
      [t.id, t.type, t.title, t.city, t.nights || null, t.type === "package" ? JSON.stringify(["Luxor", "Aswan"]) : null,
        JSON.stringify(["Licensed guide", "Transport"]), JSON.stringify(["Tips"])]
    );
  }
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_cts', 'Capital Travel Service')");
  await db.query("INSERT INTO app_users (id, email, role) VALUES ($1, $2, $3)", [OPS.id, OPS.email, OPS.role]);

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  cat = await import("./catalogue.js");
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

const productId = async (no) => Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = $1", [no])).rows[0].id);
const count = async (sql, args = []) => Number((await db.query(sql, args)).rows[0].n);
const draftOf = async (no) => (await db.query(
  "SELECT s.id FROM catalogue_spec_versions s JOIN catalogue_products c ON c.id = s.product_id WHERE c.catalogue_no = $1 AND s.state = 'draft'", [no])).rows[0]?.id;
const nextWeekday = (from, weekdays, skipDays = 0) => {
  let d = shiftDate(from, skipDays);
  while (!weekdays.includes(weekdayOf(d))) d = shiftDate(d, 1);
  return d;
};
async function legacyDeparture(listing, date, status = "open") {
  const id = Number((await db.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id);
  await db.query(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES ($1,$2,$3,$4,$5,'08:00',$6,4,12,100,80,$7)`, [id, listing.type, listing.id, listing.title, date, listing.city, status]);
  return id;
}
async function pledge(departureId, seats, status = "confirmed") {
  const id = `pl_it_${departureId}_${Math.random().toString(36).slice(2, 8)}`;
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, status, source)
     VALUES ($1,$2,'direct_customer','Direct',$3,'Test traveller','t@example.test',$4,'public')`, [id, departureId, seats, status]);
  return id;
}

// ---------------------------------------------------------------- flag off
test("flag off: the public site and booking behave exactly as before, whatever the catalogue jobs do", { skip }, async () => {
  const esnaDate = nextWeekday(today(), [1, 3, 5], 10);
  const legacyId = await legacyDeparture(L.esna, esnaDate);
  await pledge(legacyId, 1);
  const base = await startServer({});

  const snapshot = async () => {
    const boot = await (await fetch(`${base}/api/bootstrap`)).json();
    const product = await (await fetch(`${base}/api/public/tour-products/${L.edfu.id}`)).json();
    const head = await (await fetch(`${base}/api/public/route-head?path=${encodeURIComponent(tourPath(L.edfu))}`)).json();
    const redirect = await fetch(`${base}${tourPath(L.edfu)}`, { redirect: "manual" });
    return { boot, product, head, redirectStatus: redirect.status };
  };
  const before = await snapshot();
  assert.equal("catalogue" in before.boot, false, "no catalogue key with the flag off");
  assert.equal(before.boot.tourProducts.length, await count("SELECT COUNT(*) AS n FROM tour_products"), "every listing, retired or not");
  assert.ok(before.boot.tourProducts.some((p) => p.title === L.edfu.title), "listing titles unchanged");
  assert.notEqual(before.redirectStatus, 301, "no catalogue redirects");

  // What the scheduler does with the flag off: generate (no bookable rows) and
  // move statuses. Then publish a spec, which would change the public page if
  // the flag were on.
  const gen = await cat.generateDepartures({ materialise: false });
  assert.ok(gen.created > 0 && gen.materialised === 0);
  await cat.runStatusJob();
  await cat.publishDraft({ productId: await productId(1), versionId: await draftOf(1), by: "it" });
  assert.equal(await count("SELECT COUNT(*) AS n FROM departures WHERE tour_product_id <> $1", [L.esna.id]), 0,
    "no departures created outside the catalogue tables");

  const after = await snapshot();
  assert.deepEqual(after.boot, before.boot);
  assert.deepEqual(after.product, before.product);
  assert.deepEqual(after.head, before.head);

  // Booking works as it did.
  const booked = await fetch(`${base}/api/public/departures/${legacyId}/bookings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Flag Off", customerEmail: "off@example.test", seats: 1 }),
  });
  assert.equal(booked.status, 201, await booked.text());
});

// ---------------------------------------------------------------- data model
test("a product can have only one departure per date", { skip }, async () => {
  const pid = await productId(4);
  const date = shiftDate(today(), 200);
  await db.query("INSERT INTO catalogue_departures (product_id, date) VALUES ($1, $2)", [pid, date]);
  await assert.rejects(
    db.query("INSERT INTO catalogue_departures (product_id, date) VALUES ($1, $2)", [pid, date]),
    (e) => e.code === "23505" && e.constraint === "uq_catalogue_departures_product_date");
  await db.query("DELETE FROM catalogue_departures WHERE product_id = $1 AND date = $2", [pid, date]);
});

test("the seed: 21 products, launch statuses, #14 merged into #15, drafts copied from listings", { skip }, async () => {
  const rows = (await db.query("SELECT catalogue_no, status, title, merged_into_id, legacy_product_id FROM catalogue_products ORDER BY catalogue_no")).rows;
  assert.equal(rows.length, 21);
  const by = Object.fromEntries(rows.map((r) => [r.catalogue_no, r]));
  assert.equal(by[2].status, "held");
  assert.equal(by[3].status, "held");
  assert.equal(by[14].status, "retired");
  assert.equal(Number(by[14].merged_into_id), await productId(15));
  assert.equal(by[13].title, "Aswan to Abu Simbel: Temples of Ramesses II & Nefertari");
  assert.equal(by[1].legacy_product_id, L.giza.id);
  assert.equal(by[7].legacy_product_id, null, "nothing to link to: stays unlinked");
  const esnaDraft = (await db.query("SELECT content, sources FROM catalogue_spec_versions WHERE product_id = $1", [await productId(15)])).rows[0];
  assert.deepEqual(esnaDraft.content.inclusions, ["Licensed guide", "Transport"]);
  assert.match(esnaDraft.sources.copiedFrom, new RegExp(L.esna.id));
  const safariDraft = (await db.query("SELECT content FROM catalogue_spec_versions WHERE product_id = $1", [await productId(7)])).rows[0];
  assert.deepEqual(safariDraft.content.inclusions, [], "no invented content");
  assert.equal(await count("SELECT COUNT(*) AS n FROM catalogue_calendar_rules r JOIN catalogue_products c ON c.id = r.product_id WHERE c.catalogue_no IN (2, 3, 14, 17, 18)"), 0,
    "held, retired and cruises get no rules");
});

// ---------------------------------------------------------------- generator
test("generation is idempotent, adopts existing dates, and skips held and retired products", { skip }, async () => {
  await cat.publishDraft({ productId: await productId(15), versionId: await draftOf(15), by: "it" });
  // An existing Esna date with a traveller on it, on a rule day.
  const adoptDate = nextWeekday(today(), [1, 3, 5], 20);
  const existing = await legacyDeparture(L.esna, adoptDate);
  await pledge(existing, 2);

  const first = await cat.generateDepartures({ materialise: true });
  const counts = async () => ({
    cat: await count("SELECT COUNT(*) AS n FROM catalogue_departures"),
    legacy: await count("SELECT COUNT(*) AS n FROM departures"),
  });
  const afterFirst = await counts();
  const second = await cat.generateDepartures({ materialise: true });
  assert.deepEqual(second, { created: 0, adopted: 0, materialised: 0 });
  assert.deepEqual(await counts(), afterFirst, "a second run creates nothing");
  assert.ok(first.adopted >= 1 && first.materialised > 0);

  const adopted = (await db.query(
    "SELECT * FROM catalogue_departures WHERE product_id = $1 AND date = $2", [await productId(15), adoptDate])).rows[0];
  assert.equal(adopted.origin, "adopted");
  assert.equal(Number(adopted.legacy_departure_id), existing);
  assert.equal(await count("SELECT COUNT(*) AS n FROM departures WHERE tour_product_id = $1 AND date = $2", [L.esna.id, adoptDate]), 1,
    "no duplicate of a date that already had a traveller");

  for (const no of [2, 3, 14]) {
    assert.equal(await count(
      "SELECT COUNT(*) AS n FROM catalogue_departures WHERE product_id = $1 AND origin = 'generated'", [await productId(no)]), 0,
      `#${no} generates nothing`);
  }
  // Materialised only for products with a published spec in effect.
  assert.equal(await count(
    `SELECT COUNT(*) AS n FROM catalogue_departures WHERE product_id = $1 AND legacy_departure_id IS NOT NULL`, [await productId(4)]), 0);
});

// ---------------------------------------------------------------- statuses
async function generatedDeparture(no, offsetDays) {
  const r = await db.query(
    `SELECT cd.* FROM catalogue_departures cd WHERE cd.product_id = $1 AND cd.origin = 'generated'
       AND cd.status = 'open' AND cd.legacy_departure_id IS NOT NULL AND cd.date >= $2 ORDER BY cd.date LIMIT 1`,
    [await productId(no), shiftDate(today(), offsetDays)]);
  return r.rows[0];
}
// 08:00 in Cairo, with Egypt's summer time, the way the server works it out.
const startMs = (date) => zonedDateTimeToUtc(date, "08:00");
let releasedDepartureId = null;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

test("a day tour below the minimum is cancelled at the cut-off; its bookings are released; events queued once", { skip }, async () => {
  const dep = await generatedDeparture(1, 10);
  await pledge(dep.legacy_departure_id, 2);
  const date = ymd(dep.date);
  const cutoff = startMs(date) - 48 * HOUR;

  await cat.runStatusJob({ now: cutoff - HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "open");

  await cat.runStatusJob({ now: cutoff + 60000 });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "cancelled_below_minimum");
  assert.equal((await db.query("SELECT status FROM departures WHERE id = $1", [dep.legacy_departure_id])).rows[0].status, "cancelled");
  assert.equal(await count("SELECT COUNT(*) AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [dep.legacy_departure_id]), 0);
  await cat.runStatusJob({ now: cutoff + 2 * HOUR });
  const events = (await db.query("SELECT type FROM catalogue_events WHERE departure_id = $1 ORDER BY type", [dep.id])).rows.map((r) => r.type);
  assert.deepEqual(events, ["next_date_offer", "traveller_notice.cancelled_below_minimum"]);
  releasedDepartureId = Number(dep.id);
});

test("GoAhead is sticky: a cancellation afterwards doesn't undo it; it completes once over", { skip }, async () => {
  const dep = await generatedDeparture(1, 11);
  const pledges = [];
  for (let i = 0; i < 4; i++) pledges.push(await pledge(dep.legacy_departure_id, 1));
  const date = ymd(dep.date);
  await cat.runStatusJob({ now: startMs(date) - 100 * HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "go_ahead");
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [pledges[0]]);
  await cat.runStatusJob({ now: startMs(date) - 10 * HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "go_ahead");
  await cat.runStatusJob({ now: startMs(date) + 20 * HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "completed");
});

test("a cruise below the minimum is cancelled at its GoAhead deadline", { skip }, async () => {
  const pid = await productId(18);
  const sailing = shiftDate(today(), 60);
  await cat.addRule((await import("./db/index.js")).pool, pid, { kind: "dates", dates: [sailing], activeFrom: today() });
  await cat.publishDraft({ productId: pid, versionId: await draftOf(18), by: "it" });
  await cat.generateDepartures({ materialise: true });
  const dep = (await db.query("SELECT * FROM catalogue_departures WHERE product_id = $1 AND date = $2", [pid, sailing])).rows[0];
  assert.ok(dep && dep.legacy_departure_id, "the sailing is generated and bookable");
  const deadline = startMs(sailing) - 30 * 24 * HOUR;   // the 30-day default (048)
  await cat.runStatusJob({ now: deadline - HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "open");
  await cat.runStatusJob({ now: deadline + HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "cancelled_below_minimum");
});

test("an adopted departure keeps the old rules: never cancelled below minimum here", { skip }, async () => {
  const adopted = (await db.query("SELECT * FROM catalogue_departures WHERE origin = 'adopted' LIMIT 1")).rows[0];
  await cat.runStatusJob({ now: startMs(ymd(adopted.date)) - HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [adopted.id])).rows[0].status, "open");
});

// ---------------------------------------------------------------- override
test("run below minimum: needs a reason, records who and why, and survives the cut-off", { skip }, async () => {
  const dep = await generatedDeparture(1, 20);
  const date = ymd(dep.date);
  await assert.rejects(cat.runBelowMinimum({ departureId: Number(dep.id), by: "ops@sawa.test", reason: "" }), (e) => e.status === 422);
  const done = await cat.runBelowMinimum({ departureId: Number(dep.id), by: "ops@sawa.test", reason: "Group of three from a partner hotel" });
  assert.equal(done.status, "go_ahead");
  const row = (await db.query("SELECT * FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0];
  assert.equal(row.run_below_minimum, true);
  assert.equal(row.override_by, "ops@sawa.test");
  assert.equal(row.override_reason, "Group of three from a partner hotel");
  assert.ok(row.override_at);
  assert.equal((await db.query("SELECT status FROM departures WHERE id = $1", [dep.legacy_departure_id])).rows[0].status, "minimum_reached");
  await cat.runStatusJob({ now: startMs(date) - 47 * HOUR });
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [dep.id])).rows[0].status, "go_ahead");
});

test("run below minimum is refused once started, and won't reinstate released bookings", { skip }, async () => {
  const dep = await generatedDeparture(1, 25);
  await assert.rejects(
    cat.runBelowMinimum({ departureId: Number(dep.id), by: "ops", reason: "Too late for this", now: startMs(ymd(dep.date)) + HOUR }),
    (e) => e.status === 409);
  assert.ok(releasedDepartureId, "set by the cut-off test");
  await assert.rejects(
    cat.runBelowMinimum({ departureId: releasedDepartureId, by: "ops", reason: "Changed our minds", now: Date.now() }),
    (e) => e.status === 409 && /released/.test(e.message));
});

test("the override through the admin API: staff only, audit-logged", { skip }, async () => {
  const base = await startServer({});
  const dep = await generatedDeparture(1, 30);
  const post = (token) => fetch(`${base}/api/admin/catalogue/departures/${dep.id}/run-below-minimum`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ reason: "Charter guests confirmed by phone" }),
  });
  assert.equal((await post(null)).status, 401);
  const ok = await post(OPS.token);
  assert.equal(ok.status, 200, await ok.text());
  const audit = (await db.query("SELECT * FROM audit_log WHERE action = 'catalogue.departure.run_below_minimum' AND entity_id = $1", [String(dep.id)])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_email, OPS.email);
  assert.equal(audit[0].detail.reason, "Charter guests confirmed by phone");
});

// ---------------------------------------------------------------- spec versioning
test("a new spec version never changes a departure that already has seats sold", { skip }, async () => {
  const pid = await productId(15);
  const sold = await generatedDeparture(15, 40);
  await pledge(sold.legacy_departure_id, 1);
  const unsold = (await db.query(
    `SELECT * FROM catalogue_departures WHERE product_id = $1 AND origin = 'generated' AND date > $2 ORDER BY date LIMIT 1`,
    [pid, sold.date])).rows[0];
  const v1 = Number(sold.spec_version_id);
  assert.equal(Number(unsold.spec_version_id), v1);

  const { pool } = await import("./db/index.js");
  const draft = await cat.createDraft(pool, pid, "it");
  await cat.saveDraft(pool, pid, draft.id, { ...draft.content, inclusions: ["Licensed guide", "Transport", "Lunch"] });
  const { spec, departuresMoved } = await cat.publishDraft({ productId: pid, versionId: draft.id, by: "it" });
  assert.ok(departuresMoved > 0);
  assert.equal(Number((await db.query("SELECT spec_version_id FROM catalogue_departures WHERE id = $1", [sold.id])).rows[0].spec_version_id), v1,
    "sold departure keeps the version it was sold under");
  assert.equal(Number((await db.query("SELECT spec_version_id FROM catalogue_departures WHERE id = $1", [unsold.id])).rows[0].spec_version_id), spec.id);

  // And the published version itself can't be rewritten.
  await assert.rejects(db.query("UPDATE catalogue_spec_versions SET content = '{}' WHERE id = $1", [v1]), /cannot be changed/);
});

// ---------------------------------------------------------------- flag on
test("flag on: catalogue products only, spec content, date labels, redirects, no operator names", { skip }, async () => {
  const base = await startServer({ FEATURES: "catalogue_v2" });
  const boot = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(boot.catalogue, { enabled: true });
  assert.deepEqual(boot.operatorsByProduct, {});
  const titles = boot.tourProducts.map((p) => p.title).sort();
  assert.deepEqual(titles, [
    "Giza Pyramids, Sphinx & the Grand Egyptian Museum",
    "Luxor to Aswan: Esna, Edfu & Kom Ombo Temple Road",
    "Nile Majesty: 5-Day River Cruise from Luxor",
  ], "published, active products only: no held, retired or draft-only ones");
  const esna = boot.tourProducts.find((p) => p.id === L.esna.id);
  assert.deepEqual(esna.included, ["Licensed guide", "Transport", "Lunch"], "inclusions from the active spec");
  assert.equal(esna.operatorAgencyId, null);
  assert.ok(boot.departures.length > 0);
  for (const d of boot.departures) {
    assert.match(d.catalogueLabel, /^(Going ahead|\d+ of 4 needed)$/);
    assert.equal(d.operatorAgencyId, null);
  }
  assert.ok(!JSON.stringify(boot).includes("Capital Travel Service"), "no operator name anywhere in the payload");

  // #14 is retired into #15: its old URL moves permanently, with its query.
  const r14 = await fetch(`${base}${tourPath(L.edfu)}?ref=abc`, { redirect: "manual" });
  assert.equal(r14.status, 301);
  const to15 = tourPath({ title: "Luxor to Aswan: Esna, Edfu & Kom Ombo Temple Road", city: L.esna.city, type: L.esna.type });
  assert.equal(new URL(r14.headers.get("location"), base).pathname + new URL(r14.headers.get("location"), base).search, `${to15}?ref=abc`);
  const partners = await fetch(`${base}/partners`, { redirect: "manual" });
  assert.equal(partners.status, 302);
});
