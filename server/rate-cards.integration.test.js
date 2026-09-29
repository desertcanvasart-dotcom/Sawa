// One rate card per product (066) on a real Postgres:
//
//   the migration  the newest published version becomes the card; a tier
//                  ending above 8 is clamped (#2 Giza Uncovered 7–11 → 7–8), one
//                  starting above 8 dropped; a newer draft and a product with
//                  only a draft are listed; a departure locked to a version
//                  keeps it as its snapshot; the versions are archived, then
//                  deleted; running every migration again changes nothing
//   save           in place, one row per product
//   first seat     the departure takes a snapshot; later edits never touch it,
//                  a departure with no seat sold uses the card as it is now
//   delete         the tour can't be booked; snapshots stay
//   bookable       a rate card and the site-wide exchange rate
//
// Skips without TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_test_rate_cards";
const skip = testDbSkip;
let db, dbUrl, rates;
const ids = {};
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const J = (x) => JSON.stringify(x);

const GIZA_V1 = {
  tiers: [{ from: 4, to: 6, priceEgp: 5192, operatorFeePct: 5 }, { from: 7, to: 9, priceEgp: 4307, operatorFeePct: 6 }, { from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }],
  lines: [{ name: "Transport", basis: "per_group", amounts: [2650, 2650, 3300] }, { name: "Entrance", basis: "per_traveller", amounts: [2250, 2250, 2250] }],
};
const UNCOVERED_V1 = {
  tiers: [{ from: 4, to: 6, priceEur: 43, operatorFeePct: 5 }, { from: 7, to: 11, priceEur: 40, operatorFeePct: 6 }],
  lines: [
    { name: "Transport", basis: "per_group", amounts: [1850, 2200] },
    { name: "Guiding", basis: "per_group", amounts: [2000, 2000] },
    { name: "Entrance", basis: "per_traveller", amounts: [700, 700] },
  ],
};

async function product(no, code, title) {
  const r = await one(
    `INSERT INTO catalogue_products (catalogue_no, code, slug, title, type, base_city, status, goahead_min, max_group)
     VALUES ($1, $2, $3, $4, 'day_tour', 'Cairo', 'active', 4, 8) RETURNING id`, [no, code, code.toLowerCase(), title]);
  ids[code] = Number(r.id);
  return ids[code];
}
async function version(productId, v, state, { tiers, lines }, createdBy = "it") {
  const r = await one(
    `INSERT INTO catalogue_rate_versions (product_id, version, state, effective_from, published_by, published_at, tiers, cost_lines, commission_pct, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, '{}'::jsonb, $9) RETURNING id`,
    [productId, v, state, state === "published" ? "2026-01-01" : null, state === "published" ? "ops@sawa.test" : null,
      state === "published" ? new Date("2026-02-01T10:00:00Z") : null, J(tiers), J(lines), createdBy]);
  return Number(r.id);
}
// A bookable date: a legacy departures row and its catalogue departure.
let legacySeq = 991000;
async function departure(productId, date) {
  const legacy = ++legacySeq;
  await db.query(
    `INSERT INTO departures (id, type, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES ($1, 'day_tour', 'Rate card test', $2, '08:00', 'Cairo', 4, 8, 95, 95, 'open')`, [legacy, date]);
  const r = await one("INSERT INTO catalogue_departures (product_id, date, legacy_departure_id) VALUES ($1, $2, $3) RETURNING id", [productId, date, legacy]);
  return { id: Number(r.id), legacy };
}
let pledgeSeq = 0;
async function book(dep, seats) {
  const id = `pl_rc_${++pledgeSeq}`;
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source, booking_total, booking_code)
     VALUES ($1, $2, 'direct_customer', 'direct_customer', $3, 'Test', $4, '+201000000000', 'confirmed', 'public', $5, $6)`,
    [id, dep.legacy, seats, `rc${pledgeSeq}@example.test`, 95 * seats, `RC${String(pledgeSeq).padStart(6, "0")}`]);
  return id;
}
const snapshotOf = async (dep) => (await one("SELECT rate_snapshot FROM catalogue_departures WHERE id = $1", [dep.id])).rate_snapshot;

before(async () => {
  if (skip) return;
  dbUrl = await freshDatabase(DB_NAME);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("TRUNCATE catalogue_products CASCADE");
  await db.query("DELETE FROM fx_traveller_rates");
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  rates = await import("./rates.js");
});

after(async () => {
  if (skip) return;
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

// ---------------------------------------------------------------- the migration
test("migration 066: the newest published version becomes the card, clamped to 8 and listed; drafts listed; locked departures keep their version as a snapshot; the versions go", { skip }, async () => {
  // Before 066: the versions as production has them.
  const giza = await product(1, "GIZA", "Giza Pyramids, Sphinx & the Grand Egyptian Museum");
  const gizaV1 = await version(giza, 1, "published", GIZA_V1);
  await version(giza, 2, "draft", { tiers: [{ from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }], lines: [] }, "ops@sawa.test");
  const unc = await product(2, "UNCOVERED", "Giza Uncovered");
  const uncV1 = await version(unc, 1, "published", UNCOVERED_V1);
  const siwa = await product(3, "SIWA", "Siwa Oasis");
  await version(siwa, 1, "draft", { tiers: [{ from: 4, to: 8, priceEgp: 6000, operatorFeePct: 5 }], lines: [] });
  // A departure of #2 that sold a seat under v1, and one of #1 that didn't.
  const sold = await one("INSERT INTO catalogue_departures (product_id, date, rate_version_id, rate_locked_at) VALUES ($1, '2026-11-02', $2, '2026-09-20T09:00:00Z') RETURNING id", [unc, uncV1]);
  const unsold = await one("INSERT INTO catalogue_departures (product_id, date) VALUES ($1, '2026-11-03') RETURNING id", [giza]);

  await db.query(readFileSync(join(ROOT, "server", "db", "schema_066_rate_cards.sql"), "utf8"));

  const card = async (id) => rates.getRateCard(db, id);
  // #1: the published v1, not the newer draft; 7–9 → 7–8, 10–12 dropped with its cost amounts.
  const c1 = await card(giza);
  assert.deepEqual(c1.tiers, [{ from: 4, to: 6, priceEgp: 5192, operatorFeePct: 5 }, { from: 7, to: 8, priceEgp: 4307, operatorFeePct: 6 }]);
  assert.deepEqual(c1.costLines.map((l) => l.amounts), [[2650, 2650], [2250, 2250]]);
  assert.deepEqual([c1.updatedBy, c1.source.migration066.fromVersion], ["ops@sawa.test", 1], "last updated = when it was published");
  // #2 Giza Uncovered: 7–11 → 7–8.
  const c2 = await card(unc);
  assert.deepEqual(c2.tiers, [{ from: 4, to: 6, priceEur: 43, priceEgp: null, operatorFeePct: 5 }, { from: 7, to: 8, priceEur: 40, priceEgp: null, operatorFeePct: 6 }]);
  assert.equal(c2.costLines.length, 3, "every cost line kept");
  // #3 had only a draft: no card.
  assert.equal(await card(siwa), null);

  const report = (await db.query("SELECT * FROM rate_card_migration_066 ORDER BY catalogue_no, id")).rows;
  const lines = rates.migrationReportLines(report);
  assert.ok(lines.includes("#2 Giza Uncovered: tier 7–11 → 7–8 (v1)"), lines.join("\n"));
  assert.ok(lines.includes("#1 Giza Pyramids, Sphinx & the Grand Egyptian Museum: tier 7–9 → 7–8 (v1)"));
  assert.ok(lines.includes("#1 Giza Pyramids, Sphinx & the Grand Egyptian Museum: tier 10–12 dropped (above the maximum group of 8)"));
  assert.ok(lines.some((l) => /^#1 .*: newer draft v2 \(by ops@sawa.test\) NOT used; the published v1 was kept\. Draft tiers: 10–12 EGP 4071$/.test(l)));
  assert.ok(lines.some((l) => /^#3 Siwa Oasis: only a draft \(v1\); no rate card was made/.test(l)));
  assert.ok(lines.some((l) => /^#2 Giza Uncovered: departure 2026-11-02 keeps v1 as its snapshot$/.test(l)));

  // The sold departure keeps v1 exactly as it was (7–11 included): frozen.
  const snap = (await one("SELECT rate_snapshot FROM catalogue_departures WHERE id = $1", [sold.id])).rate_snapshot;
  assert.deepEqual(snap.tiers, UNCOVERED_V1.tiers);
  assert.equal(snap.takenAt.slice(0, 10), "2026-09-20");
  assert.equal((await one("SELECT rate_snapshot FROM catalogue_departures WHERE id = $1", [unsold.id])).rate_snapshot, null, "unsold: uses the card");
  const soldRate = await rates.departureRate(db, { rate_snapshot: snap, product_id: unc });
  assert.deepEqual([soldRate.snapshot, soldRate.tiers[1].to], [true, 11]);

  // The versions: archived, then gone; nothing references them.
  assert.equal((await one("SELECT count(*)::int n FROM catalogue_rate_versions")).n, 0);
  assert.equal((await one("SELECT count(*)::int n FROM catalogue_rate_versions_archive")).n, 4);
  assert.equal((await one("SELECT row_data->>'state' AS s FROM catalogue_rate_versions_archive WHERE id = $1", [gizaV1])).s, "published");
  assert.equal((await one("SELECT count(*)::int n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'catalogue_rate_versions'::regclass")).n, 0);

  // Every migration runs on each db:migrate: nothing changes, and the first-seat trigger stays the snapshot one.
  const before = await card(unc);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });
  assert.deepEqual(await card(unc), before);
  assert.equal((await one("SELECT count(*)::int n FROM rate_card_migration_066")).n, report.length, "nothing reported twice");
  assert.match((await one("SELECT pg_get_functiondef('catalogue_lock_on_first_seat'::regproc) AS f")).f, /rate_snapshot/);
});

// ---------------------------------------------------------------- save, snapshot, delete
test("save updates in place; a departure that sold a seat keeps its snapshot while an unsold one picks up the new prices", { skip }, async () => {
  const unc = ids.UNCOVERED;
  const soldDep = await departure(unc, "2026-11-10");
  const openDep = await departure(unc, "2026-11-11");
  await book(soldDep, 2);
  const snap = await snapshotOf(soldDep);
  assert.deepEqual(snap.tiers.map((t) => [t.from, t.to, t.priceEur]), [[4, 6, 43], [7, 8, 40]], "a copy of the card at the first seat");
  assert.equal(await snapshotOf(openDep), null);

  const card = await rates.getRateCard(db, unc);
  const out = await rates.saveRateCard(db, unc, {
    tiers: [{ ...card.tiers[0], priceEur: 45 }, card.tiers[1]],
    costLines: card.costLines.map((l, i) => (i === 0 ? { ...l, note: "Higher for 7–8: bigger driver tip" } : l)),
    commissionPct: 10,
  }, { by: "boss@sawa.test" });
  assert.deepEqual([out.before.tiers[0].priceEur, out.card.tiers[0].priceEur, out.card.updatedBy], [43, 45, "boss@sawa.test"]);
  assert.equal(out.card.costLines[0].note, "Higher for 7–8: bigger driver tip");
  assert.equal((await one("SELECT count(*)::int n FROM catalogue_rate_cards WHERE product_id = $1", [unc])).n, 1, "in place: one row");

  assert.deepEqual(await snapshotOf(soldDep), snap, "the sold departure's copy is unchanged");
  const soldRate = await rates.departureRate(db, { rate_snapshot: await snapshotOf(soldDep), product_id: unc });
  const openRate = await rates.departureRate(db, { rate_snapshot: await snapshotOf(openDep), product_id: unc });
  assert.deepEqual([soldRate.tiers[0].priceEur, openRate.tiers[0].priceEur], [43, 45], "the unsold departure uses the card as it is now");
  // The status job's fallback leaves a snapshot alone too.
  await rates.lockRatesForSoldDepartures(db);
  assert.deepEqual(await snapshotOf(soldDep), snap);
  // The unsold departure's first seat takes the new prices.
  await book(openDep, 1);
  assert.equal((await snapshotOf(openDep)).tiers[0].priceEur, 45);
  // The tier rules and the EGP-looking warning hold on save.
  await assert.rejects(rates.saveRateCard(db, unc, { tiers: [{ from: 4, to: 6, priceEur: 43, operatorFeePct: 5 }, { from: 7, to: 11, priceEur: 40, operatorFeePct: 6 }], costLines: [] }, { by: "x" }), /"To" can't be more than 8/);
  const warned = await rates.saveRateCard(db, unc, { tiers: [{ ...card.tiers[0], priceEur: 2537 }, card.tiers[1]], costLines: card.costLines, commissionPct: 10 }, { by: "x" });
  assert.equal(warned.warnings.length, 1, "saved, with a warning");
  await rates.saveRateCard(db, unc, { tiers: out.card.tiers, costLines: out.card.costLines, commissionPct: 10 }, { by: "boss@sawa.test" });
});

test("delete: the tour can't be booked until a new card is saved; snapshots stay; no exchange rate also blocks booking", { skip }, async () => {
  const unc = ids.UNCOVERED;
  const soldDep = await departure(unc, "2026-11-12");
  await book(soldDep, 2);
  const snap = await snapshotOf(soldDep);
  await db.query("INSERT INTO fx_traveller_rates (egp_per_eur, reason, note, set_by) VALUES (59, 'manual', 'test', 'it')");
  await rates.assertRateCardBookable(db, soldDep.id);

  const gone = await rates.deleteRateCard(db, unc);
  assert.equal(gone.tiers.length, 2);
  assert.equal(await rates.getRateCard(db, unc), null);
  assert.deepEqual(await snapshotOf(soldDep), snap, "the snapshot is never deleted");
  await assert.rejects(rates.assertRateCardBookable(db, soldDep.id), (e) => e.status === 409 && e.reason === "no_rate_card" && /can't be booked right now/.test(e.message));
  await assert.rejects(rates.deleteRateCard(db, unc), /no rate card/);
  // A departure that sold seats still prices from its snapshot.
  const rate = await rates.departureRate(db, { rate_snapshot: snap, product_id: unc });
  assert.equal(rate.tiers[0].priceEur, 45);

  await rates.saveRateCard(db, unc, { tiers: snap.tiers, costLines: snap.costLines, commissionPct: 10 }, { by: "it" });
  await rates.assertRateCardBookable(db, soldDep.id);
  await db.query("DELETE FROM fx_traveller_rates");
  await assert.rejects(rates.assertRateCardBookable(db, soldDep.id), (e) => e.reason === "no_exchange_rate");
});
