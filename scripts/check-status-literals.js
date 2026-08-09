// LL1.2 — every status literal in the code must be a status the database
// permits.
//
// The bug this closes: the database's CHECK constraints spell it 'cancelled'.
// Six places in the front end compared against 'canceled'. The comparison never
// matched, so a cancelled booking was counted as a traveller holding a seat on
// every public board, and /goahead presented a date as confirmed and running on
// the strength of four cancelled bookings.
//
// Nobody noticed because both spellings are correct English and neither throws.
// A string that is never equal to anything fails silently, forever.
//
// So this does not check for that one word. It builds the vocabulary from the
// schema — the only authority on what a status may be — and rejects any status
// literal in the codebase that is not in it. The next status value nobody has
// thought of yet is covered by construction.
//
// Same shape as check:constants, which injects GOAHEAD_MIN/GROUP_MAX from
// domain.js rather than trusting twenty pages to agree.
//
// Run: npm run check:status-literals
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- vocabulary

// Every value inside a `CHECK (<col> IN ('a','b'))` in the schema, plus the
// column it constrains. One flat set is enough: the question asked here is "is
// this string a status the database has ever heard of", and a value that is
// valid for one table and used against another is a different bug from this one.
export function schemaStatusVocabulary(dir = join(ROOT, "server", "db")) {
  const values = new Set();
  const sources = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8");
    // Two shapes. `CHECK (col IN (...))` for a required value, and
    // `CHECK (col IS NULL OR col IN (...))` for a nullable one — 023 uses the
    // second, and the first draft of this parser did not see it, so five
    // permitted values were invisible to the vocabulary.
    const re = /CHECK\s*\(\s*(?:\w+\s+IS\s+NULL\s+OR\s+)?(\w+)\s+IN\s*\(([^)]*)\)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const column = m[1].toLowerCase();
      // Only status-ish columns. `type IN ('day_tour','package')` and
      // `role IN (...)` are enums too, and both are picked up — the vocabulary
      // is deliberately a superset so this can never fail a legitimate literal.
      for (const raw of m[2].split(",")) {
        const v = raw.trim().replace(/^'|'$/g, "");
        if (!v) continue;
        values.add(v);
        if (!sources.has(v)) sources.set(v, `${file} (${column})`);
      }
    }
  }
  return { values, sources };
}

// Statuses that exist only in the application, with no column to constrain them.
// Each needs a reason, because an unexplained entry here is how a real mismatch
// gets waved through.
const APPLICATION_ONLY = new Map([
  ["logged", "email_log.status — written by email.js in log mode; the column has no CHECK"],
  ["sent", "email_log.status — written by email.js on a successful Resend send"],
  ["failed", "email_log.status — written by email.js when a send is rejected"],
  ["system", "audit_log.actor_role for machine-written entries; the column has no CHECK"],
  ["public", "pledges.source, not a status — free text marking a traveller booking"],
  // 'published' and 'draft' USED to live here, because blog_posts.status had no
  // CHECK. Migration 023 added one, so the schema is now the authority for them
  // and the exception is gone. That is what the exception list is for: every
  // entry is a place the schema is not the authority, and the list should
  // shrink.
]);

// ---------------------------------------------------------------- the scan

// Comparisons and assignments against something named `status`. Deliberately
// narrow: this is looking for `x.status === "..."`, not for every string in the
// codebase that happens to be a word.
// A MEMBER access only — `row.status === "x"`, `p?.status !== 'x'`, and the
// reversed form. Not a bare `status === "x"`, which is a destructured local, and
// not `{ status: "x" }`, which in this codebase is only ever a React fetch-state
// machine. A database row's status is never assigned from a JS object literal;
// it is written by SQL, where a bad value is a constraint violation the database
// itself rejects. The silent failure this exists to catch is the comparison.
const PATTERNS = [
  /[\w\])]\s*\??\.\s*status\s*[=!]==?\s*["']([a-z_]+)["']/gi,
  /["']([a-z_]+)["']\s*[=!]==?\s*[\w\])]\s*\??\.\s*status\b/gi,
];

// React fetch-state machines share the word. `state.status === "loading"` is a
// component's own idea of loading, not a row's. Rather than guess from the
// receiver's name, the receivers bound by useState in each file are collected
// and skipped — so a genuine row variable can never be excluded by accident.
function reactStateReceivers(text) {
  const names = new Set();
  const re = /const\s*\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*useState\s*\(/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

// Files whose status strings ARE the authority, or are talking about something
// else entirely.
const SKIP = [
  "node_modules", "dist", ".git", "server/db/", "docs/",
  "scripts/check-status-literals.js",
];

export function walk(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    if (SKIP.some((s) => rel.startsWith(s) || rel.includes(`/${s}`))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".js", ".jsx", ".html"].includes(extname(entry))) out.push(full);
  }
  return out;
}

export function scanStatusLiterals(files, vocabulary) {
  const problems = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const localState = reactStateReceivers(text);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      // An explicit, per-line opt-out. Deliberately NOT a blanket exemption for
      // test files: a test that compares against the wrong status is the same
      // bug as production code doing it. Only a line that says out loud it is
      // holding a deliberately-invalid fixture is skipped.
      if (line.includes("status-literal-fixture")) return;
      // `state.status === "loading"` where `state` came from useState.
      if ([...localState].some((n) => new RegExp(`\\b${n}\\s*\\??\\.\\s*status\\b`).test(line))) return;
      // SQL in the server speaks to the database directly and is checked by the
      // database itself; a typo there is a constraint violation at runtime, not
      // a silent mismatch. It is the JS comparison that fails quietly.
      if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line) && /status\s*(<>|=)\s*'/.test(line)) return;
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const value = m[1];
          if (vocabulary.values.has(value) || APPLICATION_ONLY.has(value)) continue;
          problems.push({
            file: relative(ROOT, file).replace(/\\/g, "/"),
            line: i + 1,
            value,
            text: line.trim().slice(0, 120),
          });
        }
      }
    });
  }
  // The same literal can match more than one pattern on one line.
  const seen = new Set();
  return problems.filter((p) => {
    const key = `${p.file}:${p.line}:${p.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- cli

const isCli = process.argv[1] && process.argv[1].endsWith("check-status-literals.js");
if (isCli) {
  const vocabulary = schemaStatusVocabulary();
  const files = walk(ROOT);
  const problems = scanStatusLiterals(files, vocabulary);

  if (!problems.length) {
    console.log(
      `Every status literal matches the schema (${vocabulary.values.size} permitted values, ${files.length} files scanned).`
    );
    process.exit(0);
  }

  console.error(`\n${problems.length} status literal(s) the database will never produce:\n`);
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}`);
    console.error(`    "${p.value}" is not a permitted status`);
    console.error(`    ${p.text}`);
    const near = [...vocabulary.values].filter(
      (v) => v.replace(/l/g, "") === p.value.replace(/l/g, "") || v.startsWith(p.value.slice(0, 5))
    );
    if (near.length) console.error(`    did you mean: ${near.map((n) => `"${n}"`).join(", ")}`);
    console.error("");
  }
  console.error("A comparison against a value the database cannot hold never matches.");
  console.error("It does not throw, and it does not log. It silently answers 'no' forever.\n");
  process.exit(1);
}
