// EEEE3.1 / LLL5.1 — the four claims the seed ends, and a check that notices.
//
// ============================================================================
// WHY THIS IS A CHECK AND NOT A NOTE
// ============================================================================
//
// `pledges` has never held a row. Four separate claims rest on that sentence,
// and **one INSERT ends all four simultaneously** — silently, with no error and
// nothing failing. The register's own entry (E-2) already says *"when the seed
// happens, all four need revisiting in the same commit"*, which is a promise
// kept by memory. This project's whole method is replacing those.
//
// So: the day `pledges` stops being empty, this goes red until the four have
// been restated as HISTORICAL and bounded by the date the seed landed.
//
// ============================================================================
// THREE STATES, NOT TWO
// ============================================================================
//
//   not-checked   no production credentials. NEVER a pass — `check:applied-
//                 schema` learned this the hard way, reporting `applied` for a
//                 run that never opened a connection.
//   still-true    `pledges` is empty. The four claims stand as written.
//   ENDED         `pledges` holds rows. The four must carry a restatement, or
//                 the build is asserting something that stopped being true.
//
//   node scripts/check-seed-expiry.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Derived from E-2's own list, not a second copy of it: each entry names the
// file, the sentence that expires, and the marker that proves it was restated.
export const RESTS_ON_E2 = [
  {
    id: "volume-rule",
    file: "scripts/audit-claims.js",
    claim: "the `volume` rule's premise — \"pledges has never held a row; no traveller has been carried\"",
    stale: /pledges has never held a row; no traveller has been carried/,
  },
  {
    id: "exposure-scope",
    file: "docs/audit/evidence-expiry.md",
    claim: "EEE3 — \"no traveller personal data was exposed\" during the Data API window",
    stale: /\*\*Status\*\* \| \*\*LIVE\*\* — and the most load-bearing sentence/,
  },
  {
    id: "legal-q3",
    file: "docs/audit/legal-register.md",
    claim: "Q3, consumer rating display — premised on there being no travellers",
    stale: /pledges` has never held a row|no reviews table exists/,
  },
  {
    id: "cancel-rehearsal",
    file: "docs/audit/cancel-job-rehearsal.md",
    claim: "the rehearsal's scope — run on an ephemeral database so E-2 would survive",
    stale: /so this sentence would survive/,
  },
];

// The marker a restatement must carry. A date, so "restated" cannot be claimed
// by editing a word — and the same date across all four, because one INSERT
// ended all four at the same instant.
export const RESTATED = /E-2 ENDED (\d{4}-\d{2}-\d{2})/;

export function auditRestatements(read = (f) => readFileSync(join(ROOT, f), "utf8")) {
  return RESTS_ON_E2.map((e) => {
    let text = "";
    try { text = read(e.file); } catch { return { ...e, state: "unreadable" }; }
    const m = text.match(RESTATED);
    return { ...e, state: m ? "restated" : "stale", on: m ? m[1] : null };
  });
}

export function verdict({ pledgeCount, restatements }) {
  if (pledgeCount == null) {
    return { state: "not-checked", pass: true,
      line: "SEED EXPIRY: not checked — no production credentials. This is NOT a pass for the four claims; it is silence about them." };
  }
  if (pledgeCount === 0) {
    const early = restatements.filter((r) => r.state === "restated");
    if (early.length) {
      return { state: "premature", pass: false,
        line: `SEED EXPIRY: ${early.length} claim(s) are marked E-2 ENDED, but \`pledges\` is still empty. `
          + `A claim restated before the thing that ends it is a different kind of wrong.` };
    }
    return { state: "still-true", pass: true,
      line: "SEED EXPIRY: `pledges` is empty — the four claims resting on E-2 stand as written." };
  }
  const stale = restatements.filter((r) => r.state !== "restated");
  if (!stale.length) {
    const dates = [...new Set(restatements.map((r) => r.on))];
    return { state: "restated", pass: dates.length === 1,
      line: dates.length === 1
        ? `SEED EXPIRY: \`pledges\` holds ${pledgeCount} row(s); all four claims restated, bounded ${dates[0]}.`
        : `SEED EXPIRY: the four claims carry ${dates.length} different dates (${dates.join(", ")}). One INSERT ended all four at the same instant.` };
  }
  return { state: "ENDED", pass: false,
    line: `SEED EXPIRY: \`pledges\` holds ${pledgeCount} row(s) — E-2 has ENDED, and ${stale.length} of ${restatements.length} claim(s) still assert otherwise:\n`
      + stale.map((s) => `    ${s.file}\n        ${s.claim}`).join("\n")
      + `\n\n  Restate each as historical and bounded by the seed date, and mark it \`E-2 ENDED <YYYY-MM-DD>\`.` };
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-seed-expiry.js");
if (isCli) {
  // Load .env the way every other script does. Without this the check read a
  // bare process.env, found nothing, and reported `not-checked` on a machine
  // that could in fact have asked — silence dressed as an honest third state,
  // which is worse than the two-state collapse it exists to avoid.
  await import("dotenv/config");
  let pledgeCount = null;
  if (process.env.DATABASE_URL) {
    try {
      const { pool } = await import("../server/db/index.js");
      pledgeCount = (await pool.query("SELECT count(*)::int n FROM pledges")).rows[0].n;
      await pool.end();
    } catch (e) {
      // Unable to ask is not "empty". Third state, same argument throughout.
      console.error(`SEED EXPIRY: could not read \`pledges\` — ${e.message.split("\n")[0]}`);
      console.error("Unable to ask is not the same as nothing there. Nothing was checked.");
      process.exit(1);
    }
  }
  const v = verdict({ pledgeCount, restatements: auditRestatements() });
  console.log(v.line);
  process.exit(v.pass ? 0 : 1);
}
