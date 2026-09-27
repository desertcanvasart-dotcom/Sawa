// The operator rate card (model phase 2): versions per product, in EGP, the
// import from sawa-rate-card.xlsx, and locking at first seat. Display only in
// this phase: nothing is paid from these numbers yet.
import { pool, withTransaction } from "./db/index.js";
import { readXlsx } from "./xlsx.js";
import { rateFieldsFor } from "../shared/operators.js";
import { todayIn, getProduct, CatalogueError } from "./catalogue.js";

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
    effectiveFrom: ymd(r.effective_from), currency: r.currency, source: r.source || {},
    createdBy: r.created_by, createdAt: r.created_at, publishedBy: r.published_by, publishedAt: r.published_at,
  };
  for (const [k, col] of Object.entries(RATE_FIELDS)) out[k] = num(r[col]);
  return out;
}

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

// A new draft, or the existing one, updated with `values`. A new draft starts
// from the latest version's amounts.
export async function saveRateDraft(db, productId, values, { by = null, source = null } = {}) {
  await getProduct(db, productId);
  const clean = cleanValues(values);
  return inTx(db, async (c) => {
    const versions = (await c.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 ORDER BY version FOR UPDATE", [productId])).rows.map(mapRate);
    const draft = versions.find((v) => v.state === "draft");
    const base = draft || versions[versions.length - 1] || {};
    const merged = {};
    for (const k of Object.keys(RATE_FIELDS)) merged[k] = k in clean ? clean[k] : (base[k] ?? null);
    const cols = Object.values(RATE_FIELDS);
    const vals = Object.keys(RATE_FIELDS).map((k) => merged[k]);
    if (draft) {
      const r = await c.query(
        `UPDATE catalogue_rate_versions SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(", ")}
           ${source ? `, source = $${cols.length + 2}` : ""}
         WHERE id = $1 RETURNING *`,
        [draft.id, ...vals, ...(source ? [JSON.stringify(source)] : [])]);
      return mapRate(r.rows[0]);
    }
    const version = (versions[versions.length - 1]?.version || 0) + 1;
    const r = await c.query(
      `INSERT INTO catalogue_rate_versions (product_id, version, ${cols.join(", ")}, source, created_by)
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, $${cols.length + 3}, $${cols.length + 4}) RETURNING *`,
      [productId, version, ...vals, JSON.stringify(source || (versions.length ? { copiedFrom: `version ${versions.length}` } : {})), by]);
    return mapRate(r.rows[0]);
  });
}

// Publishing fixes a version for good. It applies to departures that haven't
// sold a seat yet; a departure that has keeps the version it was locked to.
export async function publishRate({ db = pool, productId, versionId, effectiveFrom, by, now = Date.now() }) {
  const product = await getProduct(db, productId);
  const today = todayIn(now);
  const from = ymd(effectiveFrom) || today;
  if (from < today) throw new CatalogueError(422, "A rate version can't take effect in the past.");
  return inTx(db, async (c) => {
    const r = await c.query("SELECT * FROM catalogue_rate_versions WHERE id = $1 AND product_id = $2 FOR UPDATE", [versionId, productId]);
    if (!r.rows.length) throw new CatalogueError(404, "Rate version not found.");
    const v = mapRate(r.rows[0]);
    if (v.state !== "draft") throw new CatalogueError(409, "That version is already published.");
    const missing = rateFieldsFor(product.type).filter((k) => v[k] == null);
    if (missing.length) throw new CatalogueError(422, `Fill in every rate this product type needs before publishing (missing: ${missing.join(", ")}).`);
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
];

// → { rows: [{ catalogueNo, product, sheet, row, values }], skipped: [...], notes: [...] }
export function parseRateCard(buffer) {
  const sheets = readXlsx(buffer);
  const out = { rows: [], skipped: [], notes: [] };
  const assumptions = sheets.find((s) => /^assumptions$/i.test(s.name));
  const currency = assumptions?.rows.find((r) => /^currency$/i.test(String(r[0] || "")))?.[1];
  if (currency && String(currency).toUpperCase() !== "EGP") {
    out.notes.push(`The workbook's Assumptions sheet says the currency is ${currency}. Amounts are imported as EGP, as decided on 27 Sep 2026; check them before publishing.`);
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
