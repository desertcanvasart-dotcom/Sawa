// Phase 7: rate cards to EUR prices, as new drafts for review. Also the report
// on the single-price drafts phase 6 left (where each came from, and whether it
// lost its cost lines or its range).
//
//   DATABASE_URL=<production> node scripts/phase7-convert.js            dry run, read-only
//   DATABASE_URL=<production> node scripts/phase7-convert.js --apply    write the drafts
//   … --apply --replace=GIZA,LUXOR   also replace these products' edited drafts
//
// Needs a site-wide exchange rate (an approved fetched rate, or a manual one).
// Nothing is published. See docs/phase7/REPORT.md.
import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const replace = (process.argv.find((a) => a.startsWith("--replace=")) || "").slice("--replace=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const conv = await import("../server/eur-conversion.js");
  let db;
  if (apply) db = (await import("../server/db/index.js")).pool;
  else db = (await import("../server/db/readonly.js")).readOnlyPool();
  try {
    const plan = apply
      ? await conv.applyEurConversion(db, { replace })
      : await conv.planEurConversion(db, { replace });
    console.log(apply ? "== Converted (drafts only; nothing published) ==" : "== Dry run: nothing written. Add --apply to write the drafts ==");
    for (const l of conv.conversionLines(plan)) console.log(l);
    if (plan.error) process.exitCode = 1;
  } finally {
    await db.end();
  }
}
