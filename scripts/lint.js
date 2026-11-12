// The lint step of the gate: ESLint over the code that runs (scripts/eslint.config.js).
// Fails on errors only. Warnings are counted and shown per rule, so the number
// is visible in every run without burying the verdict under 100 lines.
//
//   node scripts/lint.js            the gate's view
//   node scripts/lint.js --all      every warning, with its file and line
import { ESLint } from "eslint";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The config lives beside this script, not at the repo root: every JavaScript
// file must sit inside a checker's roots (server/invariant-doors.test.js).
const CONFIG = join(ROOT, "scripts", "eslint.config.js");
const engine = () => new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG });
export const LINT_ROOTS = ["server", "src", "shared", "scripts"];

// One source text under the project's own config, as if it were the file at
// `filePath` (relative to the repo). What the test of this check plants its
// defects with.
export async function lintSource(code, filePath) {
  const [result] = await engine().lintText(code, { filePath: join(ROOT, filePath) });
  return result ? result.messages : [];
}

// The verdict from ESLint's results. Pure, so it is tested without a run.
export function verdict(results, { root = ROOT } = {}) {
  // A run that looked at nothing must not read as a pass.
  if (!results.length) return { pass: false, files: 0, errors: [], warnings: [], line: "lint: no files were linted. Refusing to report a pass." };
  const errors = [];
  const warnings = [];
  for (const file of results) {
    for (const m of file.messages) {
      const item = { where: `${relative(root, file.filePath)}:${m.line}:${m.column}`, rule: m.ruleId || "parse", message: m.message };
      (m.severity === 2 ? errors : warnings).push(item);
    }
  }
  return { pass: errors.length === 0, files: results.length, errors, warnings,
    line: `lint: ${results.length} files, ${errors.length} error(s), ${warnings.length} warning(s)` };
}

const isCli = process.argv[1] && process.argv[1].endsWith("lint.js");
if (isCli) {
  const showAll = process.argv.includes("--all");
  const v = verdict(await engine().lintFiles(LINT_ROOTS));
  for (const e of v.errors) console.error(`ERROR ${e.where}  ${e.rule}  ${e.message}`);
  if (showAll) for (const w of v.warnings) console.log(`warn  ${w.where}  ${w.rule}  ${w.message}`);
  console.log(v.line);
  const byRule = new Map();
  for (const w of v.warnings) byRule.set(w.rule, (byRule.get(w.rule) || 0) + 1);
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${rule}`);
  if (v.warnings.length && !showAll) console.log("  (npm run lint -- --all lists them)");
  process.exit(v.pass ? 0 : 1);
}
