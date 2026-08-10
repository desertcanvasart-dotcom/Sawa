// DIR-7 — a catalogue that cannot be incomplete.
//
// The duplication catalogue was maintained by hand and was wrong: it listed
// five, and six existed. A hand-written list of copies has the same defect as
// the copies — somebody has to remember, and the one nobody remembers is
// precisely the one that drifts.
//
// So the list is DERIVED. The authorities are whatever `shared/` exports; a
// duplication is any file outside `shared/` that DECLARES one of those names
// instead of importing it. Add an export to `shared/`, and every hand-written
// copy of it becomes visible the same day — without anyone updating a document.
//
// ---------------------------------------------------------------------------
// WHAT IT CATCHES, AND WHY BOTH MATTER
//
//   a redeclaration   a second implementation that will drift. Six of these
//                     have been found and closed: seatsTotal, goAheadFor,
//                     isForming/isGoAhead, tourSlug, and the group-size numbers.
//
//   a name collision  a DIFFERENT function wearing an authority's name.
//                     `src/main.jsx` declares its own `statusFor` returning
//                     "3 seats needed" while `shared/departure-state.js`
//                     returns "open" / "minimum_reached". Not a copy — but a
//                     reader grepping `statusFor` finds both, and this one
//                     nearly went into the DIR-5 register as a duplicated rule.
//                     A collision costs a reader the same time a copy does.
//
// ---------------------------------------------------------------------------
//   node scripts/check-duplication.js
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = join(ROOT, "shared");
const SEARCH = ["server", "src", "scripts", "site"];

// Generated from `shared/` by design, and guarded by their own parity checks.
// A generated file MUST contain these declarations — that is what it is for.
export const GENERATED = new Set(["site/assets/rules.js", "site/assets/slug.js"]);

// Deliberate, each with a reason. A per-name opt-out rather than a blanket one.
export const ALLOWED = {};

export function authorities(dir = SHARED) {
  const names = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/^export\s+(?:const|function|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      names.set(m[1], `shared/${f}`);
    }
  }
  return names;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(e)) out.push(full);
  }
  return out;
}

export function duplications(files = SEARCH.flatMap((r) => walk(join(ROOT, r))), owned = authorities()) {
  // EEEE1.1 — a check operating over a collection must assert its subject set is
  // non-empty BEFORE interpreting the outcome. Zero subjects is the absence of a
  // question, not an answer to it, and which verdict that produces depends only
  // on the shape of the check: green from a scan, red from an UPDATE that
  // matched nothing. Neither is information.
  //
  // The CLI already refused. The exported function did not — and the exported
  // function is what a TEST calls, so a test could hand it an empty list and
  // read the empty result as clean.
  if (!files.length) throw new Error("check-duplication: no files to scan — refusing to report clean");
  if (!owned.size) throw new Error("check-duplication: shared/ exports nothing — refusing to report clean; a catalogue derived from an empty list is not a clean repository");
  const out = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (GENERATED.has(rel)) continue;
    const src = readFileSync(file, "utf8")
      // Comments quote these names constantly — every fix in this repository is
      // explained beside the thing it fixed. Same lesson as the catch-handler
      // checker, which had to learn not to match its own header.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

    for (const [name, home] of owned) {
      if (name in ALLOWED) continue;
      // A declaration, not a reference. `import { x }` and `x(…)` are correct
      // usage; `function x` and `const x =` are a second implementation.
      const declared = new RegExp(
        `(?:^|\\n)\\s*(?:export\\s+)?(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=(?!\\s*${name}\\b))`
      ).test(src);
      if (!declared) continue;

      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*shared/`).test(src);
      out.push({ file: rel, name, home, kind: imported ? "shadows the import" : "second implementation" });
    }
  }
  return out;
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-duplication.js");
if (isCli) {
  const owned = authorities();
  if (!owned.size) {
    console.error("shared/ exports nothing. A catalogue derived from an empty list is not a clean repository.");
    process.exit(1);
  }
  const found = duplications(undefined, owned);
  console.log(`${owned.size} authorities in shared/: ${[...owned.keys()].join(", ")}`);
  if (!found.length) {
    console.log("\nNothing outside shared/ declares one of them.");
    process.exit(0);
  }
  console.error(`\n${found.length} declaration(s) of a name shared/ owns:\n`);
  for (const d of found) console.error(`  ${d.file}\n      ${d.name} — ${d.kind}; the authority is ${d.home}`);
  console.error(
    "\nImport it, or rename yours if it is a different thing. A second implementation\n"
    + "drifts; a name collision costs every future reader the time it just cost you.\n"
  );
  process.exit(1);
}
