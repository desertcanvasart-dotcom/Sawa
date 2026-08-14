// Every INSERT must supply exactly as many values as it names columns.
//
// ============================================================================
// WHY THIS FILE EXISTS
// ============================================================================
//
// 037 added `request_min_lead_days` and `request_max_horizon_days` to the
// tour_products upsert. Both were added to the column list and both were added
// to the parameter array — and the `VALUES` list was left at $39.
//
//   41 columns, 39 placeholders, 41 parameters.
//
// Postgres refuses the whole statement with "INSERT has more target columns
// than expressions", which reaches the route as an unhandled error and the
// operator as a bare 500. Every tour save was broken from the merge until it
// was found, by hand, three days later.
//
// ============================================================================
// WHY THE EXISTING TESTS DID NOT CATCH IT
// ============================================================================
//
// The route's tests drive a fake pool that records the query and returns rows.
// A fake accepts any SQL, so arity is exactly the class of defect that passes a
// green suite and fails on the first real connection. The build was green, the
// deploy was healthy, and the feature was unreachable.
//
// So this reads the SQL as text and counts. It needs no database, which is the
// point: the check has to run in the same suite that was passing.
//
// ============================================================================
// COUNTING EXPRESSIONS, NOT PLACEHOLDERS
// ============================================================================
//
// Not every value is a `$n`. blog_posts writes a CASE for published_at and
// `now()` for updated_at; seed.js wraps its last parameter in COALESCE. Those
// are correct, and counting `$` tokens would fail all three.
//
// What must match is the number of TOP-LEVEL comma-separated expressions, so
// the split is bracket-aware and string-aware. A naive split reported both of
// those as broken while finding the real one, which is how a check earns a
// reputation for crying wolf and stops being read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".nixpacks"]);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

// Reads from the opening bracket at `open` to its match, respecting nested
// brackets and single-quoted SQL strings. Returns the inner text, or null when
// the brackets never balance — which means the regex found something that is
// not the statement we think it is, and guessing would be worse than skipping.
function balanced(src, open) {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === "'") quoted = src[i + 1] === "'" ? (i++, true) : false;
      continue;
    }
    if (ch === "'") { quoted = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

function topLevelParts(list) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = list[i + 1] === "'" ? (current += list[++i], true) : false;
      continue;
    }
    if (ch === "'") { quoted = true; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  // `-- comment` lines live inside these lists in several places; strip them
  // before counting, or a commented-out column reads as a real one.
  return parts
    .map((p) => p.replace(/--[^\n]*/g, "").trim())
    .filter(Boolean);
}

function insertsIn(src) {
  const found = [];
  const re = /INSERT\s+INTO\s+([A-Za-z_][\w.]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const columns = balanced(src, re.lastIndex - 1);
    if (columns == null) continue;

    const after = src.slice(re.lastIndex - 1 + columns.length + 2);
    // `INSERT ... SELECT` has no VALUES list to count against, and a statement
    // built by interpolation is not fully visible here. Both are skipped rather
    // than guessed at.
    const values = after.match(/^\s*VALUES\s*\(/i);
    if (!values) continue;
    if (columns.includes("${")) continue;

    const open = after.indexOf("(", values[0].length - 1);
    const exprs = balanced(after, open);
    if (exprs == null) continue;

    found.push({
      table: m[1],
      columns: topLevelParts(columns),
      values: topLevelParts(exprs),
    });
  }
  return found;
}

// This file is excluded from its own sweep — and only this file. The fixtures
// below deliberately contain a short statement, so policing it would report the
// proof as the defect. Every other test file stays in scope: a fixture that has
// drifted out of arity is worth knowing about too.
const SELF = new URL(import.meta.url).pathname;

const statements = sourceFiles(ROOT)
  .filter((file) => file !== SELF)
  .flatMap((file) =>
    insertsIn(readFileSync(file, "utf8")).map((s) => ({ ...s, file: file.replace(ROOT, "") }))
  );

test("the sweep actually found the INSERTs it is meant to police", () => {
  // DIR-14. A parser that silently matches nothing is a green check that
  // proves nothing, which is the failure this whole file is a response to.
  assert.ok(
    statements.length >= 20,
    `expected the repo's INSERT statements to be found, got ${statements.length}`
  );
  assert.ok(
    statements.some((s) => s.table === "tour_products"),
    "the tour_products upsert — the statement that broke — was not matched"
  );
});

test("every INSERT supplies one value per column", () => {
  const broken = statements
    .filter((s) => s.columns.length !== s.values.length)
    .map((s) => {
      const extra = s.columns.slice(Math.min(s.columns.length, s.values.length));
      return `${s.file} — ${s.table}: ${s.columns.length} columns, ${s.values.length} values`
        + (extra.length ? ` (unmatched: ${extra.join(", ")})` : "");
    });

  assert.deepEqual(broken, [], `INSERT arity mismatch:\n  ${broken.join("\n  ")}`);
});

test("the check fails on a statement with a missing value", () => {
  // Proved against a tampered copy rather than trusted. A counter that cannot
  // be shown to go red is not evidence, and two of this project's checks passed
  // for months while matching nothing at all.
  const tampered = `
    await c.query(\`INSERT INTO widgets (a, b, c) VALUES ($1,$2)\`, [x, y, z]);
  `;
  const [stmt] = insertsIn(tampered);
  assert.equal(stmt.columns.length, 3);
  assert.equal(stmt.values.length, 2);
});

test("expressions are counted, not placeholders", () => {
  // The three shapes already in the repo that a `$n` count would misread:
  // a CASE, a bare now(), and a COALESCE wrapping the last parameter.
  const real = `
    INSERT INTO blog_posts (id, published_at, updated_at)
    VALUES ($1, CASE WHEN $2='published' THEN COALESCE($3::timestamptz, now()) ELSE $3::timestamptz END, now())
  `;
  const [stmt] = insertsIn(real);
  assert.equal(stmt.columns.length, 3);
  assert.equal(stmt.values.length, 3, "a bracketed expression must count as one value");
});

test("a comma inside a quoted string does not split a value", () => {
  const quoted = `INSERT INTO notes (id, body) VALUES ($1, 'a, b')`;
  const [stmt] = insertsIn(quoted);
  assert.equal(stmt.columns.length, 2);
  assert.equal(stmt.values.length, 2);
});
