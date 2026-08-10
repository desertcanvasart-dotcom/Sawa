// UUU1 — the gate that does not depend on anyone remembering.
//
// Every check in this repository already existed. What did not exist was
// anything that RAN them. Twice now that produced a wrong verdict: "preflight is
// green" reported from ten success lines without reading the composite exit
// code, and #99 merged with `audit:repo-truth` red because the checks judged
// relevant were run instead of the whole gate — three days after the rule meant
// to prevent exactly that was written down.
//
// "Run preflight before every commit" is a promise. This project's whole method
// is replacing promises with mechanisms.
//
// The pre-commit hook cannot close it: `smoke` and `audit:claims` need a live
// target, which is why they are not in it. So this runs on the pull request.
//
// ---------------------------------------------------------------------------
// THE STEP LIST IS DERIVED, NOT COPIED
//
// It comes from scripts/preflight.js. A second list in YAML would be one more
// thing to keep in step, and a check added to preflight but not to CI would be
// invisible in exactly the situation CI exists for — the MM3 class, which this
// repository has already paid for more than once.
//
// ---------------------------------------------------------------------------
// UUU1.2 — WHAT CANNOT RUN IS UNVERIFIED, NEVER ABSENT AND NEVER GREEN
//
// `check:applied-schema` asks production which migrations are recorded.
// `smoke` and `audit:claims` need a running site. CI has neither, and a green
// badge that quietly omits three checks is the "preflight is green" mistake with
// a nicer picture on it.
//
//   node scripts/ci-gate.js
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STEPS } from "./preflight.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const canRun = (s) => !s.needsTarget && !s.needsProductionDb;
const runnable = STEPS.filter(canRun);
const skipped = STEPS.filter((s) => !canRun(s));

console.log(`\nCI GATE — ${runnable.length} of ${STEPS.length} steps can run without credentials\n`);

const results = [];
for (const step of runnable) {
  console.log(`\n──── ${step.name} ${"─".repeat(Math.max(0, 56 - step.name.length))}`);
  const run = spawnSync(process.execPath, [join(ROOT, step.script), ...(step.args || [])], {
    cwd: ROOT,
    stdio: "inherit",
    // A dummy connection string, so modules that build a pool at import time
    // load. Nothing connects: the pool is lazy, and every test that needs real
    // data supplies its own. Verified — 390/390 with no .env present.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://ci:ci@127.0.0.1:1/none" },
  });
  results.push({ ...step, code: run.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);
const width = Math.max(...STEPS.map((s) => s.name.length));
const row = (verdict, name, note = "") => `  ${verdict.padEnd(10)} ${name.padEnd(width)}${note}`;

const lines = [
  "═".repeat(72),
  "CI GATE VERDICT — pull request, no production credentials",
  "═".repeat(72),
  ...results.map((r) => row(r.code === 0 ? "PASS" : "FAIL", r.name)),
  ...skipped.map((s) => row("UNVERIFIED", s.name,
    s.needsProductionDb ? "  ← needs the production database" : "  ← needs a running site")),
  "═".repeat(72),
  "",
  `UNVERIFIED means NOT CHECKED. ${skipped.length} of ${STEPS.length} steps did not run here.`,
  "A green CI result says nothing about them; run `npm run preflight -- --base=https://sawa.tours`.",
];
console.log("\n\n" + lines.join("\n"));

// The badge carries its own scope, for anyone reading the PR rather than the log.
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## CI gate\n\n| | Step | |\n|---|---|---|\n`
    + results.map((r) => `| ${r.code === 0 ? "✅ PASS" : "❌ FAIL"} | \`${r.name}\` | |\n`).join("")
    + skipped.map((s) => `| ⚠️ UNVERIFIED | \`${s.name}\` | ${s.needsProductionDb ? "needs the production database" : "needs a running site"} |\n`).join("")
    + `\n**${skipped.length} of ${STEPS.length} steps did not run here.** UNVERIFIED means not checked — a green result says nothing about them.\n`
    + `\nRun the whole gate: \`npm run preflight -- --base=https://sawa.tours\`\n`);
}

if (failed.length) {
  console.error(`\nRED — ${failed.length} of ${results.length} runnable steps failed: ${failed.map((f) => f.name).join(", ")}\n`);
  process.exit(1);
}
console.log(`\nGREEN — all ${results.length} runnable steps passed. ${skipped.length} remain unverified.\n`);
