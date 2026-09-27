// The Terms, versioned like the cancellation tiers (migration 052). Two
// series: `catalogue` for catalog bookings (pay at GoAhead) and `legacy` for
// every other booking. Each booking records the version it accepted:
//
//   legacy     at booking, the legacy version in force
//   catalogue  a direct booking, when the traveler accepts the Terms; an
//              agency booking, when the agency books (Agency Reseller
//              Agreement 4.2), the same moment its tier version is fixed
//
// A published version never changes; a change is a new version, published by
// a super admin from today or later. Before migration 052 nothing is recorded
// and nothing fails.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { versionInForce } from "../shared/cancellation-tiers.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
export const TERMS_SCOPES = ["catalogue", "legacy"];

export const mapTermsVersion = (r) => ({
  id: Number(r.id), scope: r.scope, version: r.version, state: r.state, effectiveFrom: ymd(r.effective_from),
  title: r.title, documentUrl: r.document_url, body: r.body || null, note: r.note || null,
  createdBy: r.created_by, createdAt: r.created_at, publishedBy: r.published_by, publishedAt: r.published_at,
});

async function hasTermsTable(c) {
  return (await c.query("SELECT to_regclass('public.terms_versions') AS t")).rows[0].t != null;
}

export async function listTermsVersions(db = pool) {
  return (await db.query("SELECT * FROM terms_versions ORDER BY scope, version DESC")).rows.map(mapTermsVersion);
}

export async function termsVersionInForce(db, scope, now = Date.now()) {
  const rows = (await db.query("SELECT * FROM terms_versions WHERE scope = $1 AND state = 'published'", [scope])).rows.map(mapTermsVersion);
  return versionInForce(rows, todayIn(now));
}

export async function termsVersionById(db, id) {
  if (id == null) return null;
  const r = (await db.query("SELECT * FROM terms_versions WHERE id = $1", [id])).rows[0];
  return r ? mapTermsVersion(r) : null;
}

// Record the version in force on a booking. In the booking's transaction.
export async function recordTermsVersion(c, { pledgeId, scope, now = Date.now() }) {
  if (!(await hasTermsTable(c))) return null;
  const v = await termsVersionInForce(c, scope, now);
  if (!v) return null;
  await c.query("UPDATE pledges SET terms_version_id = $2 WHERE id = $1", [pledgeId, v.id]);
  return v;
}

// ---------------------------------------------------------------- editing
async function draftFor(c, versionId) {
  const r = (await c.query("SELECT * FROM terms_versions WHERE id = $1 FOR UPDATE", [versionId])).rows[0];
  if (!r) throw new CatalogueError(404, "Terms version not found.");
  if (r.state !== "draft") throw new CatalogueError(409, "This version is published and can't be changed. Start a new draft.");
  return r;
}

export async function createTermsDraft(db, { scope, by, now = Date.now() }) {
  if (!TERMS_SCOPES.includes(scope)) throw new CatalogueError(422, "Terms are for catalog bookings or legacy bookings.");
  return inTx(db, async (c) => {
    const existing = (await c.query("SELECT * FROM terms_versions WHERE scope = $1 AND state = 'draft'", [scope])).rows[0];
    if (existing) return mapTermsVersion(existing);
    const from = await termsVersionInForce(c, scope, now);
    const next = Number((await c.query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM terms_versions WHERE scope = $1", [scope])).rows[0].n);
    const r = (await c.query(
      `INSERT INTO terms_versions (scope, version, title, document_url, body, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [scope, next, from?.title || "Terms and Conditions", from?.documentUrl || "/terms", from?.body || null,
        from ? `Copied from version ${from.version}.` : null, by])).rows[0];
    return mapTermsVersion(r);
  });
}

export async function saveTermsDraft(db, { versionId, title, documentUrl, body, note }) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    const t = String(title || "").trim();
    const url = String(documentUrl || "").trim();
    if (!t) throw new CatalogueError(422, "Give the Terms a title.");
    if (!/^(\/[\w\-./]*|https:\/\/\S+)$/.test(url)) throw new CatalogueError(422, "The document is a path on the site (/terms) or an https:// link.");
    const r = (await c.query(
      "UPDATE terms_versions SET title = $2, document_url = $3, body = $4, note = $5 WHERE id = $1 RETURNING *",
      [versionId, t.slice(0, 200), url.slice(0, 500), body ? String(body).slice(0, 200000) : null, note ? String(note).slice(0, 500) : null])).rows[0];
    return mapTermsVersion(r);
  });
}

export async function publishTermsDraft(db, { versionId, effectiveFrom, by, now = Date.now() }) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFrom || ""))) throw new CatalogueError(422, "Choose the date the Terms take effect.");
    if (effectiveFrom < todayIn(now)) throw new CatalogueError(422, "Terms can't take effect in the past: bookings already made keep the version they accepted.");
    const r = (await c.query(
      "UPDATE terms_versions SET state = 'published', effective_from = $2, published_by = $3, published_at = now() WHERE id = $1 RETURNING *",
      [versionId, effectiveFrom, by])).rows[0];
    return mapTermsVersion(r);
  });
}

export async function discardTermsDraft(db, versionId) {
  return inTx(db, async (c) => {
    await draftFor(c, versionId);
    await c.query("DELETE FROM terms_versions WHERE id = $1", [versionId]);
    return { discarded: versionId };
  });
}
