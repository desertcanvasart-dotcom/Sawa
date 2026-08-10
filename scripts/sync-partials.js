// Writes the shared partials in site/_partials into every page in /site.
//
// The 20 static pages are standalone documents on purpose — they are served
// straight off disk by express.static, and each one has to keep working as a
// plain file. That rules out an include at request time, so the duplication
// stays, but it stops being duplication anyone has to maintain by hand: the
// partial is the source, this script writes it out, and server/partials.test.js
// fails the suite the moment a page drifts from it.
//
//   node scripts/sync-partials.js           write the partials into every page
//   node scripts/sync-partials.js --check   report drift, write nothing (exit 1)
//
// Before this, the footer lived in 20 copies and its stylesheet in 9. Moving
// three legal links into it took one edit and twenty-one files, and the reveal
// observer had to be fixed in nine places twice.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(root, "site");

// DIR-14 — the one guard, at the source, rather than in twelve tests.
//
// Nine tests loop over this to assert something about every page. If it ever
// returned an empty list — a moved directory, a changed extension, a glob that
// stops matching — every one of them would pass having asserted nothing, and a
// vacuous pass renders identically to a real one.
//
// This repository has already paid for that exact shape: a check used
// `fs.globSync`, which does not exist on Node 20, found zero files and exited 0.
// scripts/run-tests.js refuses an empty run for the same reason.
//
// Guarding here rather than in each caller means a tenth test written next month
// inherits it without anyone remembering to add a line.
export function pages() {
  const top = readdirSync(siteDir).filter((f) => f.endsWith(".html")).map((f) => join(siteDir, f));
  const dest = readdirSync(join(siteDir, "destinations"))
    .filter((f) => f.endsWith(".html")).map((f) => join(siteDir, "destinations", f));
  const all = [...top, ...dest].sort();
  if (!all.length) {
    throw new Error("sync-partials: no pages found under site/. Refusing to report a pass on an empty set.");
  }
  return all;
}

// The partial carries a note explaining that it is the source. That belongs in
// the partial, not in twenty copies of the output.
export function partial(name) {
  const raw = readFileSync(join(siteDir, "_partials", `${name}.html`), "utf8");
  return raw.replace(/^<!--[\s\S]*?-->\s*/, "").trimEnd();
}

// <footer> is its own marker — no comment fences to keep in sync, and a page
// that somehow lost its footer is reported rather than silently skipped.
export function applyFooter(html, footer) {
  const open = html.indexOf("<footer");
  const close = html.indexOf("</footer>");
  if (open === -1 || close === -1) return null;
  return html.slice(0, open) + footer + html.slice(close + "</footer>".length);
}

export function checkPage(html, footer) {
  const applied = applyFooter(html, footer);
  return { ok: applied === html, applied };
}

function main() {
  const check = process.argv.includes("--check");
  const footer = partial("footer");
  const drifted = [];
  let written = 0;

  for (const file of pages()) {
    const html = readFileSync(file, "utf8");
    const { ok, applied } = checkPage(html, footer);
    const name = relative(root, file);
    if (applied === null) { drifted.push(`${name} — no <footer> found`); continue; }
    if (ok) continue;
    drifted.push(name);
    if (!check) { writeFileSync(file, applied); written++; }
  }

  if (check) {
    if (!drifted.length) return console.log(`partials in sync across ${pages().length} pages`);
    console.error(`${drifted.length} page(s) differ from site/_partials:\n  ${drifted.join("\n  ")}`);
    console.error("\nRun: node scripts/sync-partials.js");
    process.exit(1);
  }
  console.log(`${pages().length} pages checked, ${written} updated`);
}

if (process.argv[1] && process.argv[1].endsWith("sync-partials.js")) main();
