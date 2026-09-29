// Phase 7: rate cards priced in EUR. Every existing version is converted into
// a NEW DRAFT for review, never published:
//
//   EUR price = EGP price ÷ the site-wide exchange rate AT CONVERSION TIME,
//               rounded up to the whole euro (never the old per-version rates:
//               values like 43 and 97 were typed in error)
//   several tiers → one price, as phase 6 meant it (singlePriceFrom): the
//               FIRST tier, from the GoAhead minimum to the maximum group,
//               every cost line kept
//
// A draft a person has edited is never overwritten: it is listed instead, with
// what the conversion would have made. A draft made by migration 063 and left
// as it was is replaced (it is the migration's, not anyone's work).
//
// Run by scripts/phase7-convert.js: a dry run by default, `--apply` to write.
import { pool, withTransaction } from "./db/index.js";
import { mapCatalogueProduct } from "./catalogue.js";
import { mapRate } from "./rates.js";
import { currentTravellerRate, rateSettings } from "./fx.js";
import { singlePriceFrom, eurTiersFrom, tierPriced, isEurPriced } from "../shared/pool-model.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tiersShape = (tiers) => (tiers || []).map((t) => ({ from: Number(t.from), to: Number(t.to), priceEgp: t.priceEgp ?? null, operatorFeePct: t.operatorFeePct ?? null }));
const linesShape = (lines) => (lines || []).map((l) => ({ name: l.name, basis: l.basis, amounts: (l.amounts || []).map((a) => a ?? null) }));

// What migration 063 made from a version: a fixed 4–8 as first written, or
// the product's own range since the phase 7 fix.
function as063(v, from = 4, to = 8) {
  const t0 = v.tiers?.[0] || {};
  return {
    tiers: [{ from, to, priceEgp: t0.priceEgp ?? null, operatorFeePct: t0.operatorFeePct ?? null }],
    costLines: linesShape((v.costLines || []).map((l) => ({ ...l, amounts: [l.amounts?.[0] ?? null] }))),
  };
}

// Where a draft came from, and whether a person has changed it.
//   migration063_untouched  063's draft, exactly as 063 made it from a published version
//   migration063_edited     063's draft, changed since (or reduced in place: can't tell)
//   converted               already made by this conversion
//   editor                  made in the rate card editor (or the import)
export function draftOrigin(draft, versions, product = null) {
  if (draft.source?.phase7) return { origin: "converted" };
  const m = draft.source?.migration063;
  if (m) {
    const n = /version (\d+) \((\w+)\)/.exec(m.from || "");
    const src = n && n[2] === "published" ? versions.find((v) => v.version === Number(n[1])) : null;
    if (!src) return { origin: "migration063_edited", source: null };
    const ranges = [[4, 8], ...(product ? [[product.goaheadMin, product.maxGroup]] : [])];
    const untouched = ranges.some(([a, b]) => {
      const expect = as063(src, a, b);
      return same(tiersShape(draft.tiers), expect.tiers) && same(linesShape(draft.costLines), expect.costLines);
    }) && Number(draft.commissionPct) === Number(src.commissionPct);
    return { origin: untouched ? "migration063_untouched" : "migration063_edited", source: src };
  }
  return { origin: "editor" };
}

// A draft that looks like the tier-removal bug (phase 7 report): one tier
// that doesn't cover the tour's group sizes (e.g. 10–12 on a tour of 4 to 8),
// or cost lines lost relative to the version it came from.
export function draftProblems(draft, product, base) {
  const out = [];
  const t = draft.tiers || [];
  if (t.length && (Number(t[0].from) > product.goaheadMin || Number(t[t.length - 1].to) < product.maxGroup)) {
    out.push(`tiers ${t.map((x) => `${x.from}–${x.to}`).join(", ")} don't cover ${product.goaheadMin}–${product.maxGroup}`);
  }
  if (base && (base.costLines || []).length > (draft.costLines || []).length) {
    out.push(`${base.costLines.length - (draft.costLines || []).length} of ${base.costLines.length} cost lines missing compared with v${base.version}`);
  }
  return out;
}

// The new EUR draft for one product (pure).
export function eurDraftFor(base, product, eurRate) {
  // One price for the tour's whole range, from the first tier (one tier or several).
  const model = (base.tiers || []).length ? singlePriceFrom(base, product) : { tiers: [], costLines: base.costLines, commissionPct: base.commissionPct };
  const tiers = eurTiersFrom(model.tiers, eurRate);
  const notes = [];
  if ((base.tiers || []).length > 1) notes.push(`one price from the first tier (${base.tiers[0].from}–${base.tiers[0].to}) of ${base.tiers.length}`);
  const t0 = base.tiers?.[0];
  if (t0 && t0.priceEgp != null && t0.priceEur == null) notes.push(`EGP ${t0.priceEgp} ÷ ${eurRate} = ${(t0.priceEgp / eurRate).toFixed(2)}, rounded up to €${tiers[0].priceEur}`);
  if (!tiers.some(tierPriced)) notes.push("no selling price to convert: enter one");
  if (tiers.some((t) => t.operatorFeePct == null)) notes.push("operator fee not set (required before publishing)");
  return { tiers, costLines: model.costLines, commissionPct: model.commissionPct ?? base.commissionPct, notes };
}

// Every product: what the conversion does (dry run) or did (apply).
export async function planEurConversion(db = pool, { replace = [] } = {}) {
  const current = await currentTravellerRate(db);
  if (!current) return { error: "There is no site-wide exchange rate yet. Approve a fetched rate or set a manual one, then run this again.", items: [] };
  const { mode } = await rateSettings(db);
  const eurRate = current.egpPerEur;
  const products = (await db.query("SELECT * FROM catalogue_products ORDER BY catalogue_no")).rows.map(mapCatalogueProduct);
  const items = [];
  for (const product of products) {
    const versions = (await db.query("SELECT * FROM catalogue_rate_versions WHERE product_id = $1 ORDER BY version", [product.id])).rows.map(mapRate);
    const label = `#${product.catalogueNo} ${product.title}`;
    const draft = versions.find((v) => v.state === "draft") || null;
    const published = versions.filter((v) => v.state === "published").pop() || null;
    const origin = draft ? draftOrigin(draft, versions, product) : null;
    const problems = draft ? draftProblems(draft, product, origin?.source || published) : [];
    const item = { productId: product.id, code: product.code, label, draft: draft && { version: draft.version, createdBy: draft.createdBy, ...origin, source: undefined }, problems };
    if (origin?.origin === "converted") { items.push({ ...item, action: "skip", why: "already converted (phase 7)" }); continue; }
    const base = origin?.origin === "migration063_untouched" ? origin.source : published;
    if (!base) { items.push({ ...item, action: "skip", why: draft ? "only a draft, never published: edit it in EUR" : "no rate card" }); continue; }
    if (isEurPriced(base) && !draft) { items.push({ ...item, action: "skip", why: "already priced in EUR" }); continue; }
    const next = eurDraftFor(base, product, eurRate);
    const planned = { from: `version ${base.version} (${base.state})`, ...next };
    if (draft && origin.origin !== "migration063_untouched" && !replace.includes(product.code)) {
      items.push({ ...item, action: "list", why: "a draft you have edited is in the way: not overwritten", wouldBe: planned });
      continue;
    }
    items.push({ ...item, action: draft ? "replace" : "create", replaces: draft ? `v${draft.version} (${origin.origin})` : null, wouldBe: planned });
  }
  return { eurRate, mode, items };
}

export async function applyEurConversion(db = pool, { by = "phase 7 conversion", replace = [], now = Date.now() } = {}) {
  return inTx(db, async (c) => {
    const plan = await planEurConversion(c, { replace });
    if (plan.error) return plan;
    for (const it of plan.items.filter((i) => i.action === "create" || i.action === "replace")) {
      const w = it.wouldBe;
      const source = { phase7: { needsReview: true, from: w.from, eurRate: plan.eurRate, mode: plan.mode, at: new Date(now).toISOString(), notes: w.notes, ...(it.replaces ? { replaced: it.replaces } : {}) } };
      const vals = [JSON.stringify(w.tiers), JSON.stringify(w.costLines), w.commissionPct, JSON.stringify(source)];
      if (it.action === "replace") {
        const r = await c.query(
          `UPDATE catalogue_rate_versions SET tiers = $2, cost_lines = $3, commission_pct = $4, source = $5, created_by = $6
            WHERE product_id = $1 AND state = 'draft' RETURNING version`, [it.productId, ...vals, by]);
        it.version = r.rows[0].version;
      } else {
        const r = await c.query(
          `INSERT INTO catalogue_rate_versions (product_id, version, state, currency, tiers, cost_lines, commission_pct, source, created_by)
           VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM catalogue_rate_versions WHERE product_id = $1), 'draft', 'EGP', $2, $3, $4, $5, $6)
           RETURNING version`, [it.productId, ...vals, by]);
        it.version = r.rows[0].version;
      }
    }
    return plan;
  });
}

// The report, as lines (scripts/phase7-convert.js and docs/phase7/REPORT.md).
export function conversionLines(plan) {
  if (plan.error) return [plan.error];
  const out = [`Exchange rate used: ${plan.eurRate} EGP per 1 EUR (${plan.mode}).`];
  for (const it of plan.items) {
    out.push(`${it.label}: ${it.action}${it.version ? ` → draft v${it.version}` : ""}${it.why ? ` — ${it.why}` : ""}${it.replaces ? ` (replaces ${it.replaces})` : ""}`);
    if (it.draft) out.push(`    existing draft v${it.draft.version}: ${it.draft.origin}, created by ${it.draft.createdBy || "—"}`);
    for (const p of it.problems) out.push(`    ⚠ ${p}`);
    const w = it.wouldBe;
    if (w) {
      out.push(`    ${it.action === "list" ? "would be" : "new"}: ${w.tiers.map((t) => `${t.from}–${t.to} €${t.priceEur ?? "—"} (fee ${t.operatorFeePct ?? "—"}%)`).join("; ")} from ${w.from}`);
      out.push(`    cost lines: ${w.costLines.map((l) => `${l.name} ${l.amounts.map((a) => a ?? "—").join("/")} EGP`).join("; ") || "none"}`);
      for (const n of w.notes) out.push(`    · ${n}`);
    }
  }
  return out;
}
