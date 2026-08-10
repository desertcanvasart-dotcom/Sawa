// AAA1.1 — `.catch(() => {})` is never correct.
//
// Not a judgement call, which is why it is a check rather than a review note:
//
//   If the function does not throw by contract, the handler is redundant.
//   If it can throw, the handler is a bug.
//
// There is no version of that expression that is right. Thirteen of them
// defended against `sendEmail`, whose throwing behaviour nobody had established
// — a contract that existed only in the callers' imagination.
//
// The same argument covers an empty `catch {}` block.
//
// What is NOT banned: a handler that substitutes a value and says why, e.g.
// `.catch(() => ({ ok: false }))` or `.catch(() => ({ posts: [] }))`. Those are
// decisions with an observable result. The ban is on handlers that produce
// nothing — where a failure and a success leave the program in the same state
// and the log identical.
//
// AAA1.3 — A COMMENT IS NOT AN OBSERVABLE EFFECT.
//
// `catch { /* DB optional */ }` is banned on exactly the same argument as
// `catch {}`. It reads as a decision, and it is one, but it is a decision taken
// at write time and never reported at run time: the sitemap that silently drops
// all 38 tour URLs during a database outage looks, to everything downstream,
// like a sitemap of six static pages. That is the mirror's shape with a comment
// on it. Eight of this check's first twenty-eight hits were of this form and all
// eight are now recorded failures instead.
//
// Run:   node scripts/check-catch-handlers.js
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["server", "src", "scripts", "shared"];

// Empty arrow rejection handlers: .catch(() => {}), .catch(e => {}),
// .catch(function () {}) — and the empty block form, catch {} / catch (e) {}.
//
// Run against the whole file rather than line by line, so the two-line form
//
//   } catch (e) {
//   }
//
// is caught as well. The first version scanned lines and could not see it.
export const BANNED = [
  { name: "empty rejection handler", re: /\.catch\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/g },
  { name: "empty rejection handler (function)", re: /\.catch\(\s*function\s*\**\s*[\w$]*\s*\([^)]*\)\s*\{\s*\}\s*\)/g },
  // The negative lookbehind is load-bearing: without it `.catch(function (e) {})`
  // also matches this pattern — `\([^)]*\)` happily spans `(function (e)` — and
  // the same handler is reported twice under two different names. A check that
  // double-counts is a check whose numbers cannot be compared between runs.
  { name: "empty catch block", re: /(?<![.\w$])catch\s*(?:\([^)]*\)\s*)?\{\s*\}/g },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// AAA1.1 — everything that is not code becomes spaces, IN PLACE.
//
// Three separate defects in the first version, all of them from the same
// shortcut — `src.replace(/comment/g, "")`:
//
//   1. Deleting a block comment deletes its newlines, so every line number
//      after the first `/* … */` in a file was wrong. The check reported
//      `src/main.jsx:2188`, which is a loading skeleton. The real handler is at
//      2306. A check that points at the wrong line is worse than no check: the
//      reader looks, sees nothing, and learns to distrust the tool.
//
//   2. Deleting a comment INSIDE a handler manufactures a hit —
//      `catch { /* DB optional */ }` became `catch {  }`. Those turned out to
//      be real findings (see AAA1.3 above), but they were real by accident.
//      The check was reporting them for the wrong reason.
//
//   3. No string handling at all, so the `EMBED_SCRIPT` template literal in
//      src/AgencyDashboard.jsx — a quoted `catch(e){}` inside injected widget
//      source, not code this project runs — was reported as a violation.
//
// Blanking to spaces keeps every character position, so a match index still
// maps to the true line. Strings, template literals and regex literals go too,
// because all three can contain the banned expression as text.
//
// The interior of a `${…}` interpolation is blanked along with its template.
// That can only HIDE a violation, never invent one, and there are none in this
// repo — stated because an unstated limit in a checker is how you get a green
// run that checked nothing.
// `/` after a value divides; after an operator, a bracket, or one of these
// keywords it opens a pattern.
const REGEX_ALLOWED_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "throw", "case", "do", "else", "yield", "await",
]);

export function blankNonCode(src) {
  let out = "";
  let i = 0;

  // The last significant character of emitted code, and the identifier it ends,
  // both maintained as we go.
  //
  // The first version re-derived these from the whole of `out` on every `/` —
  // `out.replace(/\s+$/, "")` against a growing string, once per slash. On
  // src/main.jsx that did not finish. The check ran clean on its own tests,
  // where the inputs are three lines long, and hung on the repository: a cost
  // that only appears at real size is invisible in a fixture.
  let prev = "";
  let word = "";
  let space = true;

  const emit = (c) => {
    out += c;
    if (/\s/.test(c)) { space = true; return; }
    if (/[\w$]/.test(c)) word = (space || !/[\w$]/.test(prev)) ? c : word + c;
    else word = "";
    prev = c;
    space = false;
  };
  // A comment is transparent — `a /* c */ / 2` still divides. A string or a
  // pattern is a VALUE, so what follows it divides: `"x".length / 2`.
  const blank = (c) => { out += c === "\n" ? "\n" : " "; space = true; };
  const blankedValue = () => { prev = "0"; word = ""; space = false; };

  const opensRegex = () => {
    if (!prev) return true;
    if (!/[\w$)\]]/.test(prev)) return true;
    return REGEX_ALLOWED_AFTER_WORD.has(word);
  };

  while (i < src.length) {
    const c = src[i], d = src[i + 1];

    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") blank(src[i++]);
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) blank(src[i++]);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      blank(src[i++]);
      while (i < src.length) {
        if (src[i] === "\\") { blank(src[i++]); if (i < src.length) blank(src[i++]); continue; }
        if (src[i] === c) { blank(src[i++]); break; }
        blank(src[i++]);
      }
      blankedValue();
      continue;
    }
    if (c === "/" && opensRegex()) {
      blank(src[i++]);
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") { blank(src[i++]); if (i < src.length) blank(src[i++]); continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { blank(src[i++]); break; }
        blank(src[i++]);
      }
      blankedValue();
      continue;
    }

    emit(c);
    i += 1;
  }

  // A scanner that loses its place produces a file that is mostly spaces and a
  // run that finds nothing — which reads exactly like a clean repo. This
  // invariant is cheap and it is the difference between the two.
  if (out.length !== src.length) {
    throw new Error(`blankNonCode changed length: ${src.length} in, ${out.length} out`);
  }
  return out;
}

export function scanCatchHandlers(files = ROOTS.flatMap((r) => walk(join(ROOT, r)))) {
  // Same lesson as scripts/run-tests.js: a check that examines nothing must say
  // so rather than exit 0.
  if (!files.length) throw new Error("check-catch-handlers: no files to scan");

  const problems = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const code = blankNonCode(raw);
    const rawLines = raw.split("\n");
    for (const { name, re } of BANNED) {
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        const line = code.slice(0, m.index).split("\n").length;
        problems.push({
          file: relative(ROOT, file).replace(/\\/g, "/"),
          line,
          name,
          // The RAW line, so the reader sees what they wrote, comment included.
          text: (rawLines[line - 1] || "").trim().slice(0, 110),
        });
      }
    }
  }
  return problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const isCli = process.argv[1] && process.argv[1].endsWith("check-catch-handlers.js");
if (isCli) {
  const problems = scanCatchHandlers();
  if (!problems.length) {
    console.log("No empty catch handlers.");
    process.exit(0);
  }
  console.error(`\n${problems.length} handler(s) that discard a failure:\n`);
  for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.name}\n      ${p.text}`);
  console.error(
    "\nAn empty handler is redundant if the function does not throw, and a bug if it does.\n"
    + "A comment explaining the silence is not an effect — record the failure (see\n"
    + "server/effect-log.js) or substitute a value and say why.\n"
    + "A ReferenceError absorbed by one of these ran the Autoura mirror for years without\n"
    + "it ever transmitting anything.\n"
  );
  process.exit(1);
}
