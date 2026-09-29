// The rate card: versions per product, in EGP, the import from
// sawa-rate-card.xlsx, and locking at first seat.
//
// Phase 5 (28 Sep 2026, migration 061): a version is the pricing and money
// model of shared/pool-model.js: tiers with a selling price and an operator
// fee, cost lines per group or per traveler, the collecting agent's commission and the
// published EUR rate. The phase 2 columns (per-traveler amount, band fees,
// rooms, per-seat commission) are kept for the import, which converts them.
import { pool, withTransaction } from "./db/index.js";
import { readXlsx } from "./xlsx.js";
import { todayIn, getProduct, CatalogueError } from "./catalogue.js";
import { rateFieldsFor } from "../shared/operators.js";
import {
  poolRateError, poolRateGaps, convertLegacyRate, DEFAULT_POOL_TIERS, DEFAULT_COMMISSION_PCT, poolRateTable,
} from "../shared/pool-model.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));

export const RATE_FIELDS = {
  perTraveler: "per_traveler", fee4_6: "fee_4_6", fee7_9: "fee_7_9", fee10_12: "fee_10_12",
  landPerTraveler: "land_per_traveler", roomTwin: "room_twin", roomSingle: "room_single",
  commissionPerSeat: "commission_per_seat",
};

export function mapRate(r) {
  const out = {
    id: Number(r.id), productId: Number(r.product_id), version: r.version, state: r.state,
    effectiveFrom: ymd(r.effective_from), currency: r.currency, commissionCurrency: r.commission_currency || "EUR", source: r.source || {},
    createdBy: r.created_by, createdAt: r.created_at, publishedBy: r.published_by, publishedAt: r.published_at,
  };
  for (const [k, col] of Object.entries(RATE_FIELDS)) out[k] = num(r[col]);
  // Migration 061. Before it, a version reads as its conversion, so the
  // calculation has one shape to work on either way.
  const legacy = r.tiers === undefined ? convertLegacyRate(out) : null;
  out.tiers = (r.tiers ?? legacy?.tiers ?? null)?.map((t) => ({ from: Number(t.from), to: Number(t.to), priceEgp: num(t.priceEgp), operatorFeePct: num(t.operatorFeePct) })) || null;
  out.costLines = (r.cost_lines ?? legacy?.costLines ?? []).map((l) => ({ name: l.name, basis: l.basis, amounts: (l.amounts || []).map(num) }));
  out.commissionPct = r.commission_pct != null ? Number(r.commission_pct) : DEFAULT_COMMISSION_PCT;
  // No EUR rate on a version since 064: travelers are priced at the
  // site-wide traveler rate (server/fx.js).
  return out;
}

// Whether migration 061 is applied (the new columns exist).
export async function poolModelAvailable(db = pool) {
  return (await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'catalogue_rate_versions' AND column_name = 'tiers'")).rowCount > 0;
}

// What migration 061 converted (scripts/pool-migration-report.js and the
// rate card screen): each version, its cost lines and the conversion's notes.
export function migrationReportLines(rows) {
  if (!rows.length) return ["No rate versions: nothing was converted."];
  const out = [];
  for (const r of rows) {
    const m = r.source?.migration061;
    const lines = (r.cost_lines || []).map((l) => `${l.name} (${l.basis === "per_group" ? "per group" : "per traveler"}) ${(l.amounts || []).map((a) => a ?? "—").join(" / ")}`);
    out.push(`#${r.catalogue_no} ${r.code} v${r.version} (${r.state}): ${m ? "converted" : "entered after 061"}`);
    out.push(`    cost lines: ${lines.join("; ") || "none"}`);
    if (m) out.push(`    notes: ${(m.notes || []).join("; ")}`);
  }
  const converted = rows.filter((r) => r.source?.migration061).length;
  out.push(`${converted} of ${rows.length} version${rows.length === 1 ? "" : "s"} converted by 061. Operator fee 0% on each; selling prices and the EUR rate are entered in a new version.`);
  return out;
}

// The editor's live table for a version: 2 to 12 travelers and the warnings.
export const rateTableFor = (rate) => poolRateTable(rate);

// The version in force on a date: published, latest effective date on or
// before it, then highest version.
export function rateInForce(versions, day) {
  return versions
    .filter((v) => v.state === "published" && v.effectiveFrom && v.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.version - b.version : a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .pop() || null;
}

export async function ratesFor(db, productId) {
  const r = await db.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 ORDER BY version", [productId]);
  return r.rows.map(mapRate);
}

export async function rateById(db, id) {
  if (id == null) return null;
  const r = await db.query("SELECT * FROM catalogue_rate_versions WHERE id = $1", [id]);
  return r.rows[0] ? mapRate(r.rows[0]) : null;
}

function cleanValues(values = {}) {
  const out = {};
  for (const k of Object.keys(RATE_FIELDS)) {
    if (!(k in values)) continue;
    const v = values[k];
    if (v === null || v === "") { out[k] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new CatalogueError(422, "Rates must be amounts of zero or more.");
    out[k] = Math.round(n * 100) / 100;
  }
  return out;
}

const amount = (v) => (v === null || v === "" || v === undefined ? null : Math.round(Number(v) * 100) / 100);

// The phase 5 fields of a draft, cleaned and checked (poolRateError).
function cleanModel(values = {}, base = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(values, k);
  const model = {
    tiers: has("tiers") ? (values.tiers || []).map((t) => ({
      from: Number(t?.from), to: Number(t?.to), priceEgp: amount(t?.priceEgp), operatorFeePct: amount(t?.operatorFeePct),
    })) : base.tiers,
    costLines: has("costLines") ? (values.costLines || []).map((l) => ({
      name: String(l?.name || "").trim().slice(0, 80), basis: l?.basis, amounts: (l?.amounts || []).map(amount),
    })) : base.costLines,
    commissionPct: has("commissionPct") ? amount(values.commissionPct) : base.commissionPct,
  };
  if (model.tiers?.some((t) => [t.priceEgp, t.operatorFeePct].some((x) => x != null && !Number.isFinite(x)))
    || model.costLines?.some((l) => l.amounts.some((x) => x != null && !Number.isFinite(x)))) {
    throw new CatalogueError(422, "Rates must be numbers.");
  }
  if (model.commissionPct == null) model.commissionPct = DEFAULT_COMMISSION_PCT;
  const err = poolRateError(model);
  if (err) throw new CatalogueError(422, err);
  return model;
}

// A new draft, or the existing one, updated with `values`. A new draft starts
// from the latest version's amounts.
//
// Phase 5 fields (tiers, costLines, commissionPct) are saved with
// migration 061. Phase 2 amounts alone (the spreadsheet import) are converted
// into cost lines, keeping any selling prices, fees and rate already entered.
export async function saveRateDraft(db, productId, values, { by = null, source = null } = {}) {
  await getProduct(db, productId);
  const clean = cleanValues(values);
  const withModel = await poolModelAvailable(db);
  return inTx(db, async (c) => {
    const versions = (await c.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 ORDER BY version FOR UPDATE", [productId])).rows.map(mapRate);
    const draft = versions.find((v) => v.state === "draft");
    const base = draft || versions[versions.length - 1] || {};
    const merged = {};
    for (const k of Object.keys(RATE_FIELDS)) merged[k] = k in clean ? clean[k] : (base[k] ?? null);
    const cols = Object.values(RATE_FIELDS);
    const vals = Object.keys(RATE_FIELDS).map((k) => merged[k]);
    let modelCols = [];
    let modelVals = [];
    if (withModel) {
      const legacyOnly = Object.keys(clean).length > 0 && !["tiers", "costLines", "commissionPct"].some((k) => k in values);
      const start = { tiers: base.tiers || DEFAULT_POOL_TIERS, costLines: base.costLines || [], commissionPct: base.commissionPct ?? DEFAULT_COMMISSION_PCT };
      if (legacyOnly) {
        // The import: its amounts become the cost lines; prices and fees stay.
        const conv = convertLegacyRate(merged);
        const kept = (base.tiers || []).length === conv.tiers.length ? base.tiers : conv.tiers;
        start.tiers = kept.map((t, i) => ({ ...conv.tiers[i], priceEgp: t.priceEgp ?? null, operatorFeePct: base.tiers ? t.operatorFeePct : conv.tiers[i].operatorFeePct }));
        start.costLines = conv.costLines;
      }
      const model = cleanModel(legacyOnly ? {} : values, start);
      modelCols = ["tiers", "cost_lines", "commission_pct"];
      modelVals = [JSON.stringify(model.tiers), JSON.stringify(model.costLines), model.commissionPct];
    }
    const allCols = [...cols, ...modelCols];
    const allVals = [...vals, ...modelVals];
    if (draft) {
      const r = await c.query(
        `UPDATE catalogue_rate_versions SET ${allCols.map((col, i) => `${col} = $${i + 2}`).join(", ")}
           ${source ? `, source = $${allCols.length + 2}` : ""}
         WHERE id = $1 RETURNING *`,
        [draft.id, ...allVals, ...(source ? [JSON.stringify(source)] : [])]);
      return mapRate(r.rows[0]);
    }
    const version = (versions[versions.length - 1]?.version || 0) + 1;
    const r = await c.query(
      `INSERT INTO catalogue_rate_versions (product_id, version, ${allCols.join(", ")}, source, created_by)
       VALUES ($1, $2, ${allCols.map((_, i) => `$${i + 3}`).join(", ")}, $${allCols.length + 3}, $${allCols.length + 4}) RETURNING *`,
      [productId, version, ...allVals, JSON.stringify(source || (versions.length ? { copiedFrom: `version ${versions.length}` } : {})), by]);
    return mapRate(r.rows[0]);
  });
}

// Publishing fixes a version for good. It applies to departures that haven't
// sold a seat yet; a departure that has keeps the version it was locked to.
export async function publishRate({ db = pool, productId, versionId, effectiveFrom, by, now = Date.now() }) {
  await getProduct(db, productId);
  const today = todayIn(now);
  const from = ymd(effectiveFrom) || today;
  if (from < today) throw new CatalogueError(422, "A rate version can't take effect in the past.");
  return inTx(db, async (c) => {
    const r = await c.query("SELECT * FROM catalogue_rate_versions WHERE id = $1 AND product_id = $2 FOR UPDATE", [versionId, productId]);
    if (!r.rows.length) throw new CatalogueError(404, "Rate version not found.");
    const v = mapRate(r.rows[0]);
    if (v.state !== "draft") throw new CatalogueError(409, "That version is already published.");
    // Phase 5: every tier's operator fee and every cost line's amounts (the
    // operator's entitlement needs them). Selling prices are all or none. A
    // version without prices pays the operator; the product keeps its
    // listing price and its pool waits for a version with prices. The EUR
    // prices come from the site-wide traveler rate (064), not the version.
    const priced = (v.tiers || []).filter((t) => t.priceEgp != null).length;
    const missing = [
      ...poolRateGaps(v).filter((g) => !g.startsWith("price ")),
      ...(priced && priced < v.tiers.length ? poolRateGaps(v).filter((g) => g.startsWith("price ")) : []),
    ];
    if (missing.length) throw new CatalogueError(422, `Fill in the rate card before publishing (missing: ${missing.join(", ")}).`);
    const pub = await c.query(
      `UPDATE catalogue_rate_versions SET state = 'published', effective_from = $2, published_by = $3, published_at = now()
        WHERE id = $1 RETURNING *`, [versionId, from, by]);
    return mapRate(pub.rows[0]);
  });
}

// The status job's fallback for departures with seats sold but no locked rate
// (a booking made before any version was published, or a trigger warning).
export async function lockRatesForSoldDepartures(db = pool, now = Date.now()) {
  const today = todayIn(now);
  const r = await db.query(
    `UPDATE catalogue_departures cd SET rate_version_id = rv.id, rate_locked_at = now()
       FROM catalogue_departure_seats s,
            (SELECT DISTINCT ON (product_id) id, product_id FROM catalogue_rate_versions
              WHERE state = 'published' AND effective_from <= $1
              ORDER BY product_id, effective_from DESC, version DESC) rv
      WHERE s.catalogue_departure_id = cd.id AND s.seats_sold > 0 AND cd.rate_version_id IS NULL AND rv.product_id = cd.product_id`,
    [today]);
  return r.rowCount;
}

// ---------------------------------------------------------------- import
// Columns by their header text in the rate card, as the spreadsheet lays them
// out (sheet "Day tours" and sheet "Cruises & multi-day").
const HEADER_FIELDS = [
  [/^per-travell?er amount$/, "perTraveler"],
  [/^land services per travell?er$/, "landPerTraveler"],
  [/^room\/cabin per trip: twin/, "roomTwin"],
  [/^room\/cabin per trip: single/, "roomSingle"],
  [/^departure fee 4.6$/, "fee4_6"],
  [/^departure fee 7.9$/, "fee7_9"],
  [/^departure fee 10.12$/, "fee10_12"],
  [/^agency commission per seat$/, "commissionPerSeat"],
];
const NOT_IMPORTED = [
  [/^retail/, "retail price (pricing is a later phase; not part of the operator rate card)"],
  [/^goahead deadline/, "GoAhead deadline (set per product in Admin → Catalog)"],
  [/^sawa margin|^loss at 4|^cost of single promise/, "calculated check"],
  [/^notes$/, "notes"],
];

// → { rows: [{ catalogueNo, product, sheet, row, values }], skipped: [...], notes: [...] }
export function parseRateCard(buffer) {
  const sheets = readXlsx(buffer);
  const out = { rows: [], skipped: [], notes: [] };
  // Currencies (decided 27 Sep 2026): operator amounts in EGP, agency
  // commission (and retail) in EUR. The workbook states both on its
  // Assumptions sheet; a different statement is reported, never converted.
  const assumptions = sheets.find((s) => /^assumptions$/i.test(s.name));
  const stated = (re) => assumptions?.rows.find((r) => re.test(String(r[0] || "")))?.[1];
  out.currencies = { operator: "EGP", commission: "EUR" };
  const operatorCurrency = stated(/^operator currency/i);
  const travelerCurrency = stated(/^travell?er currency/i);
  if (operatorCurrency && String(operatorCurrency).trim().toUpperCase() !== "EGP") {
    out.notes.push(`The workbook says operator amounts are in ${operatorCurrency}. They are imported as EGP; check them before publishing.`);
  }
  if (travelerCurrency && String(travelerCurrency).trim().toUpperCase() !== "EUR") {
    out.notes.push(`The workbook says agency commission is in ${travelerCurrency}. It is imported as EUR; check it before publishing.`);
  }
  if (!operatorCurrency && !travelerCurrency) {
    out.notes.push("The workbook's Assumptions sheet doesn't state its currencies. Operator amounts are imported as EGP and agency commission as EUR; check them before publishing.");
  }
  if (stated(/^exchange rate/i) != null) {
    out.notes.push("The workbook's exchange rate is not imported: rates are entered by date in Admin → Finance → Exchange rates.");
  }
  for (const sheet of sheets) {
    const headerIdx = sheet.rows.findIndex((r) => String(r[0] || "").trim() === "#" && /product/i.test(String(r[1] || "")));
    if (headerIdx < 0) continue;
    const header = sheet.rows[headerIdx].map((h) => String(h || "").trim().toLowerCase());
    const cols = [];
    const ignored = new Set();
    header.forEach((h, i) => {
      const hit = HEADER_FIELDS.find(([re]) => re.test(h));
      if (hit) cols.push([i, hit[1]]);
      else {
        const skip = NOT_IMPORTED.find(([re]) => re.test(h));
        if (skip) ignored.add(`"${sheet.rows[headerIdx][i]}": ${skip[1]}`);
      }
    });
    if (!cols.length) {
      // e.g. the Roster sheet: a template, not rates.
      out.notes.push(`Sheet "${sheet.name}" has no rate columns and was not imported.`);
      continue;
    }
    for (const note of ignored) out.notes.push(`Sheet "${sheet.name}", column ${note}: not imported.`);
    for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i];
      if (!r || r.every((x) => x == null || x === "")) continue;
      const no = r[0];
      const product = String(r[1] || "");
      if (String(no).trim().toUpperCase() === "EX" || /EXAMPLE/i.test(product)) {
        out.skipped.push({ sheet: sheet.name, row: i + 1, reason: "EXAMPLE row" });
        continue;
      }
      if (!Number.isInteger(Number(no)) || Number(no) <= 0) {
        out.skipped.push({ sheet: sheet.name, row: i + 1, reason: `no catalog number in column # ("${no ?? ""}")` });
        continue;
      }
      const values = {};
      const bad = [];
      for (const [col, key] of cols) {
        const v = r[col];
        if (v == null || v === "") { values[key] = null; continue; }
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) values[key] = v;
        else bad.push(`${key} "${v}"`);
      }
      out.rows.push({ catalogueNo: Number(no), product, sheet: sheet.name, row: i + 1, values, bad });
    }
  }
  return out;
}

// Import a parsed card into draft versions. Rows match products by catalog
// number. Blank amounts are imported as blank and listed, so an admin sees
// what the card still leaves to fill in.
export async function importRateCard({ db = pool, buffer, filename = "sawa-rate-card.xlsx", by = null }) {
  const parsed = parseRateCard(buffer);
  const products = new Map((await db.query("SELECT id, catalogue_no, title, type FROM catalogue_products")).rows
    .map((p) => [Number(p.catalogue_no), p]));
  const imported = [];
  const problems = [];
  for (const row of parsed.rows) {
    const p = products.get(row.catalogueNo);
    if (!p) { problems.push(`${row.sheet} row ${row.row}: no catalog product #${row.catalogueNo}.`); continue; }
    if (row.bad.length) problems.push(`${row.sheet} row ${row.row} (#${row.catalogueNo}): not a number, left blank — ${row.bad.join(", ")}.`);
    const needed = rateFieldsFor(p.type);
    const blank = needed.filter((k) => row.values[k] == null);
    const sheetFits = /cruise|multi/i.test(row.sheet) === ["cruise", "multi_day"].includes(p.type);
    if (!sheetFits) problems.push(`${row.sheet} row ${row.row}: #${row.catalogueNo} is a ${p.type} in the catalog but sits on this sheet; its columns may not fit.`);
    const version = await saveRateDraft(db, Number(p.id), row.values, {
      by, source: { file: filename, sheet: row.sheet, row: row.row, importedAt: new Date().toISOString() },
    });
    imported.push({ catalogueNo: row.catalogueNo, productId: Number(p.id), version: version.version, blank });
  }
  return { imported, skipped: parsed.skipped, notes: parsed.notes, problems };
}
