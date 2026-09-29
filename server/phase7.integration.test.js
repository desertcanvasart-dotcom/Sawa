// Phase 7 on a real Postgres: the repaired 063 (the product's own range, the
// first tier, every cost line), and the conversion of existing rate cards to
// EUR prices as drafts for review. docs/phase7/REPORT.md.
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
const DB_NAME = "sawa_test_phase7";
const skip = testDbSkip;
let db, dbUrl, conv, fx, rates;
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

const THREE = JSON.stringify([
  { from: 4, to: 6, priceEgp: 5192, operatorFeePct: 5 }, { from: 7, to: 9, priceEgp: 4307, operatorFeePct: 6 }, { from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }]);
const LINES = JSON.stringify([
  { name: "Transport", basis: "per_group", amounts: [2650, 2650, 3300] }, { name: "Guide", basis: "per_group", amounts: [2000, 2000, 2000] },
  { name: "Entrance fees", basis: "per_traveller", amounts: [2250, 2250, 2250] }, { name: "Lunch", basis: "per_traveller", amounts: [400, 400, 400] }]);
const ids = {};

async function product(no, code, { goahead = 4, max = 8 } = {}) {
  const r = await one(
    `INSERT INTO catalogue_products (catalogue_no, code, slug, title, type, base_city, status, goahead_min, max_group)
     VALUES ($1, $2, $3, $4, 'day_tour', 'Cairo', 'active', $5, $6) RETURNING id`, [no, code, code.toLowerCase(), `${code} tour`, goahead, max]);
  ids[code] = Number(r.id);
  return ids[code];
}
async function version(productId, v, state, tiers, lines, { createdBy = "it", source = {} } = {}) {
  await db.query(
    `INSERT INTO catalogue_rate_versions (product_id, version, state, effective_from, published_by, published_at, tiers, cost_lines, commission_pct, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 10, $9, $10)`,
    [productId, v, state, state === "published" ? "2026-01-01" : null, state === "published" ? "it" : null, state === "published" ? new Date() : null, tiers, lines, JSON.stringify(source), createdBy]);
}

before(async () => {
  if (skip) return;
  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("TRUNCATE catalogue_products CASCADE");
  await db.query("DELETE FROM fx_traveller_rates");
  await db.query("DELETE FROM fx_rates");
  await db.query("ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable");
  // GIZA: three tiers with cost lines, and the draft the editor left (10–12, no cost lines).
  await version(await product(1, "GIZA"), 1, "published", THREE, LINES);
  await version(ids.GIZA, 2, "draft", JSON.stringify([{ from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }]), "[]",
    { createdBy: "ops@sawa.test", source: { copiedFrom: "version 1" } });
  // LUXOR (4–8) and ASWAN (6–8): three tiers, no draft: 063 makes one.
  await version(await product(2, "LUXOR"), 1, "published", THREE, LINES);
  await version(await product(3, "ASWAN", { goahead: 6 }), 1, "published", THREE, LINES);
  // ALEX: one price, 3,200 EGP.
  await version(await product(4, "ALEX"), 1, "published", JSON.stringify([{ from: 4, to: 8, priceEgp: 3200, operatorFeePct: 5 }]), JSON.stringify([{ name: "Car", basis: "per_group", amounts: [1500] }]));
  // SIWA: a draft a person priced by hand.
  await version(await product(5, "SIWA"), 1, "published", JSON.stringify([{ from: 4, to: 8, priceEgp: 6000, operatorFeePct: 5 }]), "[]");
  await version(ids.SIWA, 2, "draft", JSON.stringify([{ from: 4, to: 8, priceEgp: 6500, operatorFeePct: 5 }]), "[]", { createdBy: "ops@sawa.test" });
  await db.query("ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable");
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  conv = await import("./eur-conversion.js");
  fx = await import("./fx.js");
  rates = await import("./rates.js");
});

after(async () => {
  if (skip) return;
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

test("063, repaired: the FIRST tier, from the GoAhead minimum to the maximum group, every cost line kept", { skip }, async () => {
  await db.query(readFileSync(join(ROOT, "server", "db", "schema_063_numbered_departures.sql"), "utf8"));
  for (const [code, range] of [["LUXOR", [4, 8]], ["ASWAN", [6, 8]]]) {
    const d = await one("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 AND state = 'draft'", [ids[code]]);
    assert.deepEqual(d.tiers, [{ from: range[0], to: range[1], priceEgp: 5192, operatorFeePct: 5 }], `${code}: the first tier (4–6), not 10–12`);
    assert.deepEqual(d.cost_lines.map((l) => [l.name, l.amounts]), [["Transport", [2650]], ["Guide", [2000]], ["Entrance fees", [2250]], ["Lunch", [400]]], `${code}: all four cost lines`);
  }
  // GIZA already had a draft (one tier): 063 leaves it alone, as before.
  assert.deepEqual((await one("SELECT tiers FROM catalogue_rate_versions WHERE product_id = $1 AND state = 'draft'", [ids.GIZA])).tiers[0].from, 10);
});

test("no site-wide exchange rate: nothing is converted", { skip }, async () => {
  const plan = await conv.planEurConversion();
  assert.match(plan.error, /no site-wide exchange rate/);
});

test("the conversion: EGP ÷ the current site-wide rate, rounded up, as new drafts for review; a person's draft is listed, never overwritten; nothing published", { skip }, async () => {
  await db.query("INSERT INTO fx_rates (day, egp_per_eur, status, source) VALUES ('2026-09-29', 59, 'approved', 'manual')");
  const { pool } = await import("./db/index.js");
  assert.equal((await fx.setExchangeRateMode(pool, { mode: "automatic", by: "it" })).rate.egpPerEur, 57.23);
  const published = (await one("SELECT count(*)::int n FROM catalogue_rate_versions WHERE state = 'published'")).n;

  const dry = await conv.planEurConversion();
  const by = Object.fromEntries(dry.items.map((i) => [i.code, i]));
  assert.equal(dry.eurRate, 57.23);
  assert.deepEqual([by.GIZA.action, by.GIZA.draft.origin], ["list", "editor"], "the Giza draft is a person's (the editor): listed");
  assert.deepEqual(by.GIZA.problems, ["tiers 10–12 don't cover 4–8", "4 of 4 cost lines missing compared with v1"]);
  assert.deepEqual(by.GIZA.wouldBe.tiers, [{ from: 4, to: 8, priceEur: 91, operatorFeePct: 5 }], "5,192 ÷ 57.23 = 90.72 → €91 (never ÷ 97)");
  assert.deepEqual([by.LUXOR.action, by.LUXOR.draft.origin], ["replace", "migration063_untouched"]);
  assert.deepEqual([by.ASWAN.action, by.ASWAN.draft.origin], ["replace", "migration063_untouched"], "063's repaired range is recognised as its own");
  assert.deepEqual([by.ALEX.action, by.ALEX.wouldBe.tiers[0].priceEur], ["create", 56], "3,200 ÷ 57.23 = 55.91 → €56");
  assert.deepEqual([by.SIWA.action, by.SIWA.draft.origin], ["list", "editor"]);
  assert.equal((await one("SELECT count(*)::int n FROM catalogue_rate_versions WHERE source ? 'phase7'")).n, 0, "a dry run writes nothing");

  const done = await conv.applyEurConversion(pool, { now: Date.parse("2026-09-29T10:00:00Z") });
  assert.ok(conv.conversionLines(done).some((l) => /#1 GIZA tour: list/.test(l)));
  const draft = (code) => one("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 AND state = 'draft'", [ids[code]]);
  const alex = await draft("ALEX");
  assert.deepEqual([alex.version, alex.tiers, alex.source.phase7.needsReview, alex.source.phase7.eurRate], [2, [{ from: 4, to: 8, priceEur: 56, operatorFeePct: 5 }], true, 57.23]);
  const luxor = await draft("LUXOR");
  assert.deepEqual([luxor.tiers[0].priceEur, luxor.cost_lines.length, luxor.source.phase7.replaced], [91, 4, "v2 (migration063_untouched)"]);
  assert.equal((await draft("GIZA")).tiers[0].priceEgp, 4071, "Giza's draft untouched");
  assert.equal((await draft("SIWA")).tiers[0].priceEgp, 6500, "Siwa's draft untouched");
  assert.equal((await one("SELECT count(*)::int n FROM catalogue_rate_versions WHERE state = 'published'")).n, published, "nothing published");
  // The editor reads the new draft in EUR.
  const mapped = (await rates.ratesFor(pool, ids.ALEX)).find((v) => v.state === "draft");
  assert.deepEqual(mapped.tiers, [{ from: 4, to: 8, priceEur: 56, priceEgp: null, operatorFeePct: 5 }]);

  // Again: nothing more. Asked for by name, the Giza draft is replaced.
  const again = await conv.applyEurConversion(pool);
  assert.equal(again.items.find((i) => i.code === "ALEX").why, "already converted (phase 7)");
  await conv.applyEurConversion(pool, { replace: ["GIZA"] });
  const giza = await draft("GIZA");
  assert.deepEqual([giza.version, giza.tiers, giza.cost_lines.length], [2, [{ from: 4, to: 8, priceEur: 91, operatorFeePct: 5 }], 4]);
});
