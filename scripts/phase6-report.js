// What migration 063 (phase 6) did, for review. Read-only: runs on the audit
// tooling's read-only connection.
//
//   DATABASE_URL=<production> node scripts/phase6-report.js
//
// 1. Every product that had several tiers and now has a NEW DRAFT from its first
//    tier (price, cost amounts, operator fee). Nothing is published: each one
//    waits for review in the rate card.
// 2. The maximum group of every product (8, or the override of a cruise or
//    multi-day product).
// 3. Departures numbered above 1 (opened because the ones before were full).
import { fileURLToPath } from "node:url";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function draftLines(rows) {
  if (!rows.length) return ["No rate version was converted: no product had several tiers."];
  const out = [];
  for (const r of rows) {
    const t = (r.tiers || [])[0] || {};
    out.push(`#${r.catalogue_no} ${r.code}: new draft v${r.version} from ${r.source?.migration063?.from || "an earlier version"}`);
    out.push(`    price ${fmt(t.priceEgp)} EGP for 4–8 · operator fee ${t.operatorFeePct == null ? "NOT SET (required before it can be published)" : `${t.operatorFeePct}%`}`);
    out.push(`    cost lines: ${(r.cost_lines || []).map((l) => `${l.name} (${l.basis === "per_group" ? "per departure" : "per traveler"}) ${fmt(l.amounts?.[0])}`).join("; ") || "none"}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { readOnlyPool } = await import("../server/db/readonly.js");
  const pool = readOnlyPool();
  try {
    const drafts = (await pool.query(
      `SELECT c.catalogue_no, c.code, v.version, v.state, v.tiers, v.cost_lines, v.source
         FROM catalogue_rate_versions v JOIN catalogue_products c ON c.id = v.product_id
        WHERE v.source ? 'migration063' ORDER BY c.catalogue_no`)).rows;
    console.log("== Rate versions reduced to one price (for your review; none is published) ==");
    for (const l of draftLines(drafts)) console.log(l);
    const groups = (await pool.query("SELECT catalogue_no, code, type, max_group FROM catalogue_products ORDER BY catalogue_no")).rows;
    console.log("\n== Maximum group per product ==");
    for (const g of groups) console.log(`#${g.catalogue_no} ${g.code} (${g.type}): ${g.max_group}`);
    const extra = (await pool.query(
      `SELECT c.code, cd.date, cd.departure_no FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
        WHERE cd.departure_no > 1 ORDER BY cd.date, c.code, cd.departure_no`)).rows;
    console.log(`\n== Further numbered departures: ${extra.length} ==`);
    for (const e of extra) console.log(`${e.code} ${String(e.date).slice(0, 10)} departure ${e.departure_no}`);
  } finally {
    await pool.end();
  }
}
