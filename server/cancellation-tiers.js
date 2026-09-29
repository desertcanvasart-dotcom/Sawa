// The cancellation tiers (model phase 4): versions in the database, edited in
// Admin → Finance, and the version each booking was made under. The rules
// themselves are in shared/cancellation-tiers.js.
//
//   A draft is copied from the version in force, edited, then published with
//   an effective date (today or later: a published version never changes, and
//   never applies to the past). A booking stores the version in force when it
//   was made:
//     direct        when the traveler accepts the Terms at booking
//     agency        when the agency makes the booking (Agency Reseller
//                   Agreement 4.2: the agency shows its client the terms
//                   first); the traveler's link later asks the traveler to
//                   accept that same version, never the current one.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { rateInForce, mapRate } from "./rates.js";
import { PRODUCT_TYPES, TYPE_LABELS } from "../shared/catalogue.js";
import {
  versionInForce, tierRowsError, describeTiers, lossCheck, owedPerSeatEgp, pointLabel,
} from "../shared/cancellation-tiers.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

// Undefined table: migration 051 has not been applied to this database yet.
export const isMissingTierTables = (err) => err?.code === "42P01"
  && /cancellation_tier|payment_requests|payment_refunds|payment_tasks|departure_waitlist/.test(err?.message || "");

export const mapTierVersion = (r) => ({
  id: Number(r.id), version: r.version, state: r.state, effectiveFrom: ymd(r.effective_from), note: r.note || null,
  createdBy: r.created_by, createdAt: r.created_at, publishedBy: r.published_by, publishedAt: r.published_at,
});
export const mapTierRow = (r) => ({
  productType: r.product_type, minBeforeHours: Number(r.min_before_hours), unit: r.unit, retainedPct: Number(r.retained_pct),
});

export async function tierRowsOf(db, versionId) {
  const r = await db.query(
    "SELECT * FROM cancellation_tiers WHERE version_id = $1 ORDER BY product_type, min_before_hours DESC", [versionId]);
  return r.rows.map(mapTierRow);
}

export async function tierVersionById(db, id) {
  if (id == null) return null;
  const r = (await db.query("SELECT * FROM cancellation_tier_versions WHERE id = $1", [id])).rows[0];
  return r ? { ...mapTierVersion(r), rows: await tierRowsOf(db, r.id) } : null;
}

export async function listTierVersions(db = pool) {
  const r = await db.query("SELECT * FROM cancellation_tier_versions ORDER BY version DESC");
  const out = [];
  for (const v of r.rows) out.push({ ...mapTierVersion(v), rows: await tierRowsOf(db, v.id) });
  return out;
}

// The version in force now (tour timezone), or null before any is published.
export async function tierVersionInForce(db, now = Date.now()) {
  const r = await db.query("SELECT * FROM cancellation_tier_versions WHERE state = 'published'");
  const v = versionInForce(r.rows.map(mapTierVersion), todayIn(now));
  return v ? { ...v, rows: await tierRowsOf(db, v.id) } : null;
}

// A booking's terms are fixed at booking. Called in the booking's own
// transaction, on catalog departures with the flag on.
export async function fixBookingTerms(c, { pledgeId, by, now = Date.now() }) {
  if (!["traveller", "agency"].includes(by)) throw new Error(`fixBookingTerms: unknown party ${by}`);
  const v = await tierVersionInForce(c, now);
  if (!v) throw Object.assign(new CatalogueError(503, "No cancellation terms are published yet. Publish them in Admin → Finance → Cancellation tiers."), { expose: true });
  await c.query(
    `UPDATE pledges SET payment_mode = 'pay_at_goahead', cancellation_tier_version_id = $2, terms_fixed_at = $3, terms_fixed_by = $4,
            traveller_terms_accepted_at = CASE WHEN $4 = 'traveller' THEN $3 ELSE traveller_terms_accepted_at END
      WHERE id = $1`, [pledgeId, v.id, new Date(now), by]);
  // Migration 052: the catalog Terms version, fixed at the same moment.
  const { recordTermsVersion } = await import("./terms-versions.js");
  await recordTermsVersion(c, { pledgeId, scope: "catalogue", now });
  return v;
}

// ---------------------------------------------------------------- editing
async function draftFor(c, versionId) {
  const r = (await c.query("SELECT * FROM cancellation_tier_versions WHERE id = $1 FOR UPDATE", [versionId])).rows[0];
  if (!r) throw new CatalogueError(404, "Tier version not found.");
  if (r.state !== "draft") throw new CatalogueError(409, "This version is published and can't be changed. Start a new draft.");
  return r;
}

// The existing draft, or a new one copied from the version in force.
export async function createTierDraft(db, { by, now = Date.now() }) {
  return inTx(db, async (c) => {
    const existing = (await c.query("SELECT * FROM cancellation_tier_versions WHERE state = 'draft'")).rows[0];
    if (existing) return tierVersionById(c, existing.id);
    const from = await tierVersionInForce(c, now);
    const next = Number((await c.query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM cancellation_tier_versions")).rows[0].n);
    const ins = (await c.query(
      "INSERT INTO cancellation_tier_versions (version, created_by, note) VALUES ($1, $2, $3) RETURNING *",
      [next, by, from ? `Copied from version ${from.version}.` : null])).rows[0];
    for (const t of from?.rows || []) {
      await c.query(
        "INSERT INTO cancellation_tiers (version_id, product_type, min_before_hours, unit, retained_pct) VALUES ($1, $2, $3, $4, $5)",
        [ins.id, t.productType, t.minBeforeHours, t.unit, t.retainedPct]);
    }
    return tierVersionById(c, ins.id);
  });
}

// Replace a draft's rows. Rows arrive as { productType, amount, unit,
// retainedPct } (amount in the unit) or with minBeforeHours.
export function cleanTierRows(raw) {
  if (!Array.isArray(raw)) throw new CatalogueError(422, "Send the tiers as a list.");
  return raw.map((t) => {
    const unit = t?.unit === "days" ? "days" : "hours";
    const hours = t?.minBeforeHours != null ? Number(t.minBeforeHours) : Number(t?.amount) * (unit === "days" ? 24 : 1);
    return { productType: String(t?.productType || ""), minBeforeHours: hours, unit, retainedPct: Number(t?.retainedPct) };
  });
}

export async function saveTierDraft(db, { versionId, rows, note, by }) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    const clean = cleanTierRows(rows);
    const unknown = clean.find((t) => !PRODUCT_TYPES.includes(t.productType));
    if (unknown) throw new CatalogueError(422, `Unknown product type "${unknown.productType}".`);
    const err = tierRowsError(clean);
    if (err) throw new CatalogueError(422, err);
    await c.query("DELETE FROM cancellation_tiers WHERE version_id = $1", [versionId]);
    for (const t of clean) {
      await c.query(
        "INSERT INTO cancellation_tiers (version_id, product_type, min_before_hours, unit, retained_pct) VALUES ($1, $2, $3, $4, $5)",
        [versionId, t.productType, t.minBeforeHours, t.unit, t.retainedPct]);
    }
    if (note !== undefined) await c.query("UPDATE cancellation_tier_versions SET note = $2 WHERE id = $1", [versionId, note ? String(note).slice(0, 500) : null]);
    return tierVersionById(c, versionId);
  });
}

export async function publishTierDraft(db, { versionId, effectiveFrom, by, now = Date.now() }) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom || ""))) throw new CatalogueError(422, "Choose the date the tiers take effect.");
    if (effectiveFrom < todayIn(now)) {
      throw new CatalogueError(422, "Tiers can't take effect in the past: bookings already made keep the version they were made under.");
    }
    const err = tierRowsError(await tierRowsOf(c, versionId));
    if (err) throw new CatalogueError(422, err);
    await c.query(
      `UPDATE cancellation_tier_versions SET state = 'published', effective_from = $2, published_by = $3, published_at = now() WHERE id = $1`,
      [versionId, effectiveFrom, by]);
    return tierVersionById(c, versionId);
  });
}

export async function discardTierDraft(db, versionId) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    await c.query("DELETE FROM cancellation_tiers WHERE version_id = $1", [versionId]);
    await c.query("DELETE FROM cancellation_tier_versions WHERE id = $1", [versionId]);
    return { discarded: versionId };
  });
}

// ---------------------------------------------------------------- loss check
// The exchange rate the check compares at: the latest one finance entered.
export async function latestFxRate(db) {
  const r = (await db.query("SELECT day, egp_per_eur FROM fx_rates WHERE status = 'approved' ORDER BY day DESC LIMIT 1")).rows[0];
  return r ? { day: ymd(r.day), egpPerEur: Number(r.egp_per_eur) } : null;
}

// For the tier editor: every active catalog product, with the tiers of
// `versionId` checked against the rate in force today and the product's
// published price. Only the windows after the cut-off (or GoAhead deadline)
// are checked; a warning wherever a cancellation there loses money.
export async function tierLossReport(db, { versionId, now = Date.now() }) {
  const version = await tierVersionById(db, versionId);
  if (!version) throw new CatalogueError(404, "Tier version not found.");
  const fx = await latestFxRate(db);
  const products = (await db.query(
    `SELECT c.id, c.code, c.title, c.type, c.cutoff_hours, c.goahead_deadline_days, t.published_rate
       FROM catalogue_products c LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE c.status = 'active' ORDER BY c.catalogue_no`)).rows;
  const today = todayIn(now);
  const out = [];
  for (const p of products) {
    const rates = (await db.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1", [p.id])).rows.map(mapRate);
    const rate = rateInForce(rates, today);
    const retail = p.published_rate == null ? null : Number(p.published_rate);
    const windows = lossCheck({
      rows: version.rows, productType: p.type, cutoffHours: p.cutoff_hours, goaheadDeadlineDays: p.goahead_deadline_days,
      retailEur: retail, owedEgp: owedPerSeatEgp(p.type, rate), egpPerEur: fx?.egpPerEur,
    });
    out.push({
      product: { id: Number(p.id), code: p.code, title: p.title, type: p.type, typeLabel: TYPE_LABELS[p.type] },
      point: pointLabel(p.type), retailEur: retail, rateVersion: rate?.version ?? null, windows,
      losesMoney: windows.some((w) => w.losesMoney),
    });
  }
  return { version: { id: version.id, version: version.version, state: version.state }, fx, products: out,
    warnings: out.filter((p) => p.losesMoney).length };
}

// For the margin report: one departure, under its locked rate version, for
// each tier version its live bookings were made under (the version in force
// if none carries one yet). Windows where a cancellation would lose money.
export async function departureLossWarnings(db, { departureId, fx }) {
  const d = (await db.query(
    `SELECT cd.id, cd.rate_version_id, cd.legacy_departure_id, c.type, c.cutoff_hours, c.goahead_deadline_days, dep.published_rate
       FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN departures dep ON dep.id = cd.legacy_departure_id WHERE cd.id = $1`, [departureId])).rows[0];
  if (!d) return [];
  const rate = d.rate_version_id == null ? null
    : mapRate((await db.query("SELECT * FROM catalogue_rate_versions WHERE id = $1", [d.rate_version_id])).rows[0]);
  let versionIds = (await db.query(
    `SELECT DISTINCT cancellation_tier_version_id AS id FROM pledges
      WHERE departure_id = $1 AND status <> 'cancelled' AND cancellation_tier_version_id IS NOT NULL`, [d.legacy_departure_id])).rows.map((r) => Number(r.id));
  if (!versionIds.length) {
    const inForce = await tierVersionInForce(db);
    versionIds = inForce ? [inForce.id] : [];
  }
  const out = [];
  for (const vid of versionIds) {
    const v = await tierVersionById(db, vid);
    for (const w of lossCheck({
      rows: v.rows, productType: d.type, cutoffHours: d.cutoff_hours, goaheadDeadlineDays: d.goahead_deadline_days,
      retailEur: d.published_rate == null ? null : Number(d.published_rate), owedEgp: owedPerSeatEgp(d.type, rate), egpPerEur: fx?.egpPerEur,
    })) {
      if (w.losesMoney) out.push({ tierVersion: v.version, window: w.window, retainedEur: w.retainedEur, owedEur: w.owedEur, lossEur: w.lossEur });
    }
  }
  return out;
}

// The tiers a booking was made under, for its product type, in words.
export async function bookingTerms(db, { versionId, productType }) {
  const v = await tierVersionById(db, versionId);
  if (!v) return null;
  return {
    versionId: v.id, version: v.version, effectiveFrom: v.effectiveFrom,
    tiers: describeTiers(v.rows, productType).map((t) => ({ window: t.window, retainedPct: t.retainedPct })),
  };
}
