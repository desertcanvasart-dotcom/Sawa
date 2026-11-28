import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addT2eDayTours, tourRow } from "./add-t2e-day-tours.js";
import { cleanHtml } from "../sanitize.js";
import { livePriceFor } from "../../shared/pricing.js";

const content = JSON.parse(await readFile(new URL("../../content/tours/t2e-day-tours.json", import.meta.url), "utf8"));

test("the content file holds the four priced sheet tours, each with a 4–8 grid from the sheet", () => {
  assert.equal(content.tours.length, 4);
  const byId = Object.fromEntries(content.tours.map((t) => [t.id, t]));
  // The EUR column of "sawa for T2E", day tour sheet.
  assert.deepEqual(byId.tour_luxor_highlights_from_hurghada.tiers.map((t) => t.price), [149, 136, 127, 121, 116]);
  assert.deepEqual(byId.tour_dendera_abydos_from_hurghada.tiers.map((t) => t.price), [124, 104, 91, 81, 74]);
  assert.deepEqual(byId.tour_cairo_by_car_from_hurghada.tiers.map((t) => t.price), [165, 149, 138, 130, 125]);
  assert.deepEqual(byId.tour_nubian_temples_kalabsha_aswan.tiers.map((t) => t.price), [49, 43, 39, 36, 34]);
  for (const t of content.tours) {
    assert.deepEqual(t.tiers.map((x) => x.seats), [4, 5, 6, 7, 8]);
    assert.equal(t.minSeats, 4);
    assert.equal(t.maxSeats, 8);
  }
});

test("every row passes the editor's own validation and prices like the grid mode would", () => {
  for (const t of content.tours) {
    const r = tourRow(t);
    assert.equal(r.publishedRate, t.tiers[0].price);
    assert.equal(r.breakPrice, t.tiers[4].price);
    assert.equal(r.overviewHtml, cleanHtml(r.overviewHtml));
    assert.match(r.overviewHtml, /<h3>The Shape of the Day<\/h3>/);
    assert.doesNotMatch(r.overviewHtml, /<h1>|<h2>/);
    // The public price for N travellers is the sheet's price for N.
    const item = { publishedRate: r.publishedRate, breakPrice: r.breakPrice, priceTiers: r.priceTiers, minSeats: 4, maxSeats: 8 };
    for (const tier of t.tiers) assert.equal(livePriceFor(item, tier.seats), tier.price);
    assert.ok(r.included.length >= 4 && r.notIncluded.length >= 2);
    assert.ok(r.images.length >= 2);
  }
});

test("every gallery image is a file the server actually serves", () => {
  for (const t of content.tours) {
    for (const img of t.images) {
      const p = fileURLToPath(new URL(`../../public${img.url}`, import.meta.url));
      assert.ok(existsSync(p), `${t.id}: missing ${img.url}`);
      assert.ok(img.alt && img.alt.length > 10, `${t.id}: alt text for ${img.url}`);
    }
  }
});

test("the import inserts four approved day tours once and is a no-op afterwards", async () => {
  let marked = false;
  const inserts = [];
  const client = { async query(sql, values) {
    if (sql.startsWith("SELECT 1 FROM schema_migrations")) return { rows: marked ? [{}] : [] };
    if (sql.startsWith("INSERT INTO tour_products")) { inserts.push({ sql, values }); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith("INSERT INTO schema_migrations")) { assert.equal(values[0], content.marker); marked = true; }
    return { rows: [] };
  } };
  assert.equal(await addT2eDayTours(client), "4 inserted");
  assert.equal(await addT2eDayTours(client), "already applied");
  assert.equal(inserts.length, 4);
  for (const { sql, values } of inserts) {
    assert.match(sql, /'day_tour'/);
    assert.match(sql, /'approved'/);
    assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
    assert.equal(values.length, (sql.match(/\$\d+/g) || []).map((s) => Number(s.slice(1))).reduce((a, b) => Math.max(a, b), 0));
  }
});

test("a row that already exists is left alone and reported", async () => {
  let marked = false;
  const client = { async query(sql, values) {
    if (sql.startsWith("SELECT 1 FROM schema_migrations")) return { rows: marked ? [{}] : [] };
    if (sql.startsWith("INSERT INTO tour_products")) return { rowCount: values[0].includes("nubian") ? 0 : 1, rows: [] };
    if (sql.startsWith("INSERT INTO schema_migrations")) marked = true;
    return { rows: [] };
  } };
  assert.equal(await addT2eDayTours(client), "3 inserted, already present: tour_nubian_temples_kalabsha_aswan");
});

test("a failed insert is not marked as applied", async () => {
  const client = { async query(sql) {
    assert.doesNotMatch(sql, /INSERT INTO schema_migrations/);
    if (sql.startsWith("INSERT INTO tour_products")) throw new Error("insert failed");
    return { rows: [] };
  } };
  await assert.rejects(addT2eDayTours(client), /insert failed/);
});
