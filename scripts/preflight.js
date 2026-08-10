// CCC3 — a green run must carry its own scope.
//
// preflight was a shell chain: `npm run a && npm run b && …`. It worked, and it
// produced a report nobody could read as a verdict:
//
//   Every step printed its OWN success line and nothing printed the whole. The
//   reader assembled "preflight green" out of ten fragments — and on 10 August
//   2026 that is exactly what happened. Ten success lines were read, the
//   composite exit code was never checked, and "preflight is green" was
//   reported for a command that exits 1. `audit:claims` had been failing on 14
//   findings the entire time. The chain was never green, and the shape of the
//   mistake is this project's own: reading a representation of the verdict
//   instead of the verdict.
//
//   The target was unstated. `smoke` and `audit:claims` default to localhost,
//   so "preflight green" meant two different things depending on whether
//   someone passed --base — and the weaker meaning was indistinguishable from
//   the stronger. That is the WW3 class (a result that depends on which Node
//   happened to be installed), one level up.
//
// So: one runner, one verdict, and the scope printed with it.
//
//   node scripts/preflight.js
//   node scripts/preflight.js --base=https://sawa.tours
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = arg("base", "http://localhost:8795").replace(/\/$/, "");

// The one list. package.json used to hold a second copy inside the chain
// string; a step added to one and not the other is the MM3 class again.
//
// `needsTarget` marks the steps whose answer depends on WHICH server they were
// pointed at — the ones for which "passed" is meaningless without the base.
export const STEPS = [
  { name: "check:node", script: "scripts/check-node.js" },
  { name: "check:constants", script: "scripts/sync-constants.js", args: ["--check"] },
  { name: "check:status-literals", script: "scripts/check-status-literals.js" },
  { name: "check:catch-handlers", script: "scripts/check-catch-handlers.js" },
  { name: "check:audit-coverage", script: "scripts/audit-coverage.js" },
  { name: "check:vacuous-tests", script: "scripts/check-vacuous-tests.js" },
  { name: "check:rules", script: "scripts/sync-departure-rules.js", args: ["--check"] },
  { name: "check:slug", script: "scripts/sync-slug.js", args: ["--check"] },
  // Needs PRODUCTION credentials, not merely a database: it asks the live
  // database which migrations are recorded. CI cannot run it and must not
  // report it as passed — see scripts/ci-gate.js.
  { name: "check:applied-schema", script: "scripts/check-applied-schema.js", needsProductionDb: true },
  { name: "audit:repo-truth", script: "scripts/audit-repo-truth.js" },
  { name: "test", script: "scripts/run-tests.js" },
  { name: "smoke", script: "scripts/smoke-routes.js", needsTarget: true },
  { name: "audit:claims", script: "scripts/audit-claims.js", needsTarget: true },
];

const isProductionTarget = /^https:\/\//.test(BASE);
const isCli = process.argv[1] && process.argv[1].endsWith("preflight.js");
if (!isCli) {
  // Imported for its STEPS list (server/preflight-contract.test.js). Running
  // the whole gate as a side effect of an import would be its own surprise.
} else {

console.log(`\nPREFLIGHT — ${STEPS.length} steps · target ${BASE}${isProductionTarget ? "" : "  (LOCAL — not production)"}\n`);

const results = [];
for (const step of STEPS) {
  console.log(`\n──── ${step.name} ${"─".repeat(Math.max(0, 60 - step.name.length))}`);
  const args = [join(ROOT, step.script), ...(step.args || [])];
  if (step.needsTarget) args.push(`--base=${BASE}`);
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  results.push({ ...step, code: run.status ?? 1 });
}

// ---------------------------------------------------------------- the verdict
//
// Printed in one block, at the end, by one thing. A reader who sees only this
// knows what passed, what it was checked against, and whether to ship.
const failed = results.filter((r) => r.code !== 0);
const width = Math.max(...STEPS.map((s) => s.name.length));

console.log(`\n\n${"═".repeat(72)}`);
console.log(`PREFLIGHT VERDICT — target ${BASE}`);
console.log("═".repeat(72));
for (const r of results) {
  const scope = r.needsTarget ? `  ← ${BASE}` : "";
  console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}${scope}`);
}
console.log("═".repeat(72));

// CCC3.1 — "could not check" is not a pass, and neither is "checked something
// that is not production". Both are stated here rather than left for the reader
// to notice they never asked.
const caveats = [];
if (!isProductionTarget) {
  caveats.push(`smoke and audit:claims ran against ${BASE}, which is NOT production. A pass here says nothing about sawa.tours.`);
}
if (!process.env.SMOKE_TOKEN) {
  caveats.push("SMOKE_TOKEN is not set, so /api/modes was NOT examined. Routes were checked; the running configuration was not.");
}
if (!process.env.PRODUCTION_DB_HOST) {
  caveats.push("PRODUCTION_DB_HOST is not set, so check:applied-schema only established that the target is not local — not that it is production.");
}
if (caveats.length) {
  console.log("\nNOT CHECKED:");
  for (const c of caveats) console.log(`  · ${c}`);
}

if (failed.length) {
  console.error(`\nRED — ${failed.length} of ${results.length} steps failed: ${failed.map((f) => f.name).join(", ")}`);
  console.error("Nothing should ship on this.\n");
  process.exit(1);
}
console.log(`\nGREEN — all ${results.length} steps passed against ${BASE}.\n`);

}
