// The rate card (066, catalogue_v2): ONE per product, saved in place, and a
// frozen copy on every departure that has sold a seat.
//
//   the card      tiers (from, to, the EUR price travelers pay, the operator
//                 fee), cost lines in EGP (per group or per traveler, one
//                 amount per tier, an optional note), the collecting agent's
//                 commission. Saving updates it at once; every change is in the
//                 audit log (the routes write before and after). Deleting it
//                 makes the tour unbookable until a new one is saved.
//   the snapshot  catalogue_departures.rate_snapshot: the card as it was when
//                 the departure sold its first seat (migration 066's trigger).
//                 Payment requests, statements, the pool and settlement read
//                 it; later edits and deletes never touch it. A departure with
//                 no seat sold uses the card as it is now (rateForDeparture).
//
// The money model is shared/pool-model.js. The spreadsheet parser below is kept
// for reading the old workbook; importing it is retired (it wrote drafts).
import { pool, withTransaction } from "./db/index.js";
import { readXlsx } from "./xlsx.js";
import { getProduct, CatalogueError } from "./catalogue.js";
import {
  poolRateError, DEFAULT_COMMISSION_PCT, poolRateTable, tierPriced, rateCardError, rateCardWarnings,
} from "../shared/pool-model.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const num = (v) => (v == null || v === "" ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const amount = (v) => (v === null || v === "" || v === undefined ? null : Math.round(Number(v) * 100) / 100);

// ---------------------------------------------------------------- shape
// A tier priced in EUR carries priceEur (priceEgp null); one from before the
// EUR prices (phase 7) carries priceEgp.
const mapTiers = (tiers) => (tiers || []).map((t) => ({
  from: Number(t.from), to: Number(t.to), ...(t.priceEur != null ? { priceEur: num(t.priceEur) } : {}),
  priceEgp: num(t.priceEgp), operatorFeePct: num(t.operatorFeePct),
}));
const mapLines = (lines) => (lines || []).map((l) => ({
  name: l.name, basis: l.basis, amounts: (l.amounts || []).map(num), ...(l.note ? { note: String(l.note) } : {}),
}));

export function mapRateCard(r) {
  if (!r) return null;
  return {
    productId: Number(r.product_id), currency: r.currency || "EGP",
    tiers: mapTiers(r.tiers), costLines: mapLines(r.cost_lines),
    commissionPct: r.commission_pct != null ? Number(r.commission_pct) : DEFAULT_COMMISSION_PCT,
    source: r.source || {}, createdBy: r.created_by, createdAt: iso(r.created_at), updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
  };
}

// A departure's snapshot, in the same shape as a card (what pool-model reads).
export function mapSnapshot(s) {
  if (!s || !Array.isArray(s.tiers)) return null;
  return {
    snapshot: true, currency: s.currency || "EGP",
    tiers: mapTiers(s.tiers), costLines: mapLines(s.costLines),
    commissionPct: s.commissionPct != null ? Number(s.commissionPct) : DEFAULT_COMMISSION_PCT,
    takenAt: s.takenAt || null, from: s.from || null,
  };
}

export const snapshotOf = (card) => card && ({
  tiers: card.tiers, costLines: card.costLines, commissionPct: card.commissionPct, currency: card.currency,
  takenAt: new Date().toISOString(), cardUpdatedAt: card.updatedAt, cardUpdatedBy: card.updatedBy,
});

// Whether 066 is applied (the pool model needs the rate cards).
export async function rateCardsAvailable(db = pool) {
  return (await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'catalogue_rate_cards'")).rowCount > 0;
}
export const poolModelAvailable = rateCardsAvailable;

export async function getRateCard(db, productId) {
  return mapRateCard((await db.query("SELECT * FROM catalogue_rate_cards WHERE product_id = $1", [productId])).rows[0]);
}

export async function listRateCards(db = pool) {
  return (await db.query("SELECT * FROM catalogue_rate_cards")).rows.map(mapRateCard);
}

// The rate a departure is priced under: its snapshot once it has sold a seat,
// the product's card as it is now before that. Null without either.
export async function departureRate(db, dep) {
  const snap = mapSnapshot(dep.rate_snapshot);
  if (snap) return snap;
  return getRateCard(db, Number(dep.product_id));
}

// The editor's live table for a card.
export const rateTableFor = (rate, opts) => poolRateTable(rate, opts);

// ---------------------------------------------------------------- save
// The card as sent by the editor, cleaned (numbers rounded, a note per line).
function cleanCard(values = {}) {
  const tiers = (values.tiers || []).map((t) => (t && "priceEur" in t
    ? { from: Number(t.from), to: Number(t.to), priceEur: amount(t.priceEur), priceEgp: null, operatorFeePct: amount(t.operatorFeePct) }
    : { from: Number(t?.from), to: Number(t?.to), priceEgp: amount(t?.priceEgp), operatorFeePct: amount(t?.operatorFeePct) }));
  const costLines = (values.costLines || []).map((l) => {
    const note = String(l?.note || "").trim().slice(0, 160);
    return { name: String(l?.name || "").trim().slice(0, 80), basis: l?.basis, amounts: (l?.amounts || []).map(amount), ...(note ? { note } : {}) };
  });
  const commissionPct = values.commissionPct == null || values.commissionPct === "" ? DEFAULT_COMMISSION_PCT : amount(values.commissionPct);
  if (tiers.some((t) => [t.priceEur, t.priceEgp, t.operatorFeePct].some((x) => x != null && !Number.isFinite(x)))
    || costLines.some((l) => l.amounts.some((x) => x != null && !Number.isFinite(x))) || !Number.isFinite(commissionPct)) {
    throw new CatalogueError(422, "Rates must be numbers.");
  }
  return { tiers, costLines, commissionPct };
}

// Save the product's card, in place. Checked by rateCardError (the tiers
// cover the GoAhead minimum to the maximum group, fees required, …); a EUR
// price that looks like an EGP amount is a warning, returned, not a refusal.
// A card saves without an exchange rate: the tour just isn't bookable until
// the site-wide rate is set. Returns { card, before, warnings }.
export async function saveRateCard(db, productId, values, { by = null } = {}) {
  const product = await getProduct(db, productId);
  const model = cleanCard(values);
  const err = rateCardError(model, product);
  if (err) throw new CatalogueError(422, err);
  return inTx(db, async (c) => {
    const before = mapRateCard((await c.query("SELECT * FROM catalogue_rate_cards WHERE product_id = $1 FOR UPDATE", [productId])).rows[0]);
    const r = await c.query(
      `INSERT INTO catalogue_rate_cards (product_id, tiers, cost_lines, commission_pct, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (product_id) DO UPDATE SET tiers = EXCLUDED.tiers, cost_lines = EXCLUDED.cost_lines,
         commission_pct = EXCLUDED.commission_pct, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [productId, JSON.stringify(model.tiers), JSON.stringify(model.costLines), model.commissionPct, by]);
    return { card: mapRateCard(r.rows[0]), before, warnings: rateCardWarnings(model, product) };
  });
}

// Delete the product's card: the tour can't be booked until a new one is
// saved. Departures that sold seats keep their snapshots.
export async function deleteRateCard(db, productId) {
  await getProduct(db, productId);
  const r = await db.query("DELETE FROM catalogue_rate_cards WHERE product_id = $1 RETURNING *", [productId]);
  if (!r.rowCount) throw new CatalogueError(404, "This tour has no rate card.");
  return mapRateCard(r.rows[0]);
}

// A tour can be booked while it has a rate card and the site-wide exchange
// rate is set (the snapshot is taken at the first seat). A card saved without
// selling prices books at the listing's price, as before 066, and its pool
// waits for prices.
export function rateCardBookable(card, eurRate) {
  if (!card?.tiers?.length) return { ok: false, reason: "no_rate_card" };
  if (!(Number(eurRate) > 0)) return { ok: false, reason: "no_exchange_rate" };
  return { ok: true };
}

// The status job's fallback: a departure with seats sold and no snapshot (a
// booking before its product had a card, or a trigger warning) takes one now.
export async function lockRatesForSoldDepartures(db = pool) {
  if (!(await rateCardsAvailable(db))) return 0;
  const r = await db.query(
    `UPDATE catalogue_departures cd
        SET rate_snapshot = jsonb_build_object(
              'tiers', rc.tiers, 'costLines', rc.cost_lines, 'commissionPct', rc.commission_pct, 'currency', rc.currency,
              'takenAt', now(), 'cardUpdatedAt', rc.updated_at, 'cardUpdatedBy', rc.updated_by),
            rate_locked_at = now()
       FROM catalogue_departure_seats s, catalogue_rate_cards rc
      WHERE s.catalogue_departure_id = cd.id AND s.seats_sold > 0 AND cd.rate_snapshot IS NULL AND rc.product_id = cd.product_id`);
  return r.rowCount;
}

// What 066 did, for review (scripts/rate-card-migration-report.js).
export function migrationReportLines(rows) {
  if (!rows.length) return ["Migration 066 recorded nothing: there were no rate versions."];
  const out = [];
  const label = (r) => `#${r.catalogue_no} ${r.title}`;
  for (const r of rows) {
    const d = r.detail || {};
    if (r.kind === "card") out.push(`${label(r)}: rate card from published v${d.fromVersion} (${(d.tiers || []).map((t) => `${t.from}–${t.to}`).join(", ")}; ${d.costLines} cost lines)`);
    if (r.kind === "clamped") out.push(`${label(r)}: tier ${d.was} → ${d.now} (v${d.fromVersion})`);
    if (r.kind === "dropped_tier") out.push(`${label(r)}: tier ${d.tier} dropped (above the maximum group of ${d.maxGroup})`);
    if (r.kind === "newer_draft") out.push(`${label(r)}: newer draft v${d.draftVersion} (by ${d.createdBy || "—"}) NOT used; the published v${d.keptVersion} was kept. Draft tiers: ${(d.tiers || []).map((t) => `${t.from}–${t.to} ${t.priceEur != null ? `€${t.priceEur}` : `EGP ${t.priceEgp ?? "—"}`}`).join(", ")}`);
    if (r.kind === "no_published") out.push(`${label(r)}: only a draft (v${d.draftVersion}); no rate card was made. Enter one in Admin → Rate card.`);
    if (r.kind === "snapshot") out.push(`${label(r)}: departure ${String(d.date).slice(0, 10)} keeps v${d.version} as its snapshot`);
  }
  return out;
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

// The booking gate (066): a catalogue departure can be booked only while its
// product has a rate card and the site-wide exchange rate is set. Throws a
// 409 saying which. Nothing before 066.
export const NOT_BOOKABLE = {
  no_rate_card: "This tour can't be booked right now: it has no rate card. Please try again later.",
  no_exchange_rate: "This tour can't be booked right now: the exchange rate isn't set. Please try again later.",
};
export async function assertRateCardBookable(db, catalogueDepartureId) {
  if (!(await rateCardsAvailable(db))) return;
  const row = (await db.query("SELECT product_id FROM catalogue_departures WHERE id = $1", [catalogueDepartureId])).rows[0];
  if (!row) return;
  const { currentTravellerRate } = await import("./fx.js");
  const [card, rate] = await Promise.all([getRateCard(db, Number(row.product_id)), currentTravellerRate(db)]);
  const check = rateCardBookable(card, rate?.egpPerEur);
  if (!check.ok) throw Object.assign(new CatalogueError(409, NOT_BOOKABLE[check.reason]), { reason: check.reason, expose: true });
}
