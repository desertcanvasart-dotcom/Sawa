// LL1.3 — the status-literal check, and proof that it fires.
//
// The defect it exists for: the database CHECK constraint permits 'cancelled'.
// Six places compared against 'canceled'. The comparison never matched, so every
// public board counted cancelled bookings as travellers holding seats, and
// /goahead showed a date as confirmed and running on four cancelled bookings.
//
// A wrong string does not throw and does not log. It answers "no" forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaStatusVocabulary, scanStatusLiterals, walk } from "../scripts/check-status-literals.js";

const vocabulary = schemaStatusVocabulary();

// Deliberately-invalid sources. Each line carries the marker that opts it out of
// the repository scan below — a per-line opt-out, not a blanket exemption for
// test files, because a test comparing against the wrong status is the same bug
// as production code doing it.
const BAD_SPA = `const live = pledges.filter((p) => p.status !== "canceled");`;  // status-literal-fixture
const BAD_STATIC = `<script>return x&&x.status==='canceled'?s:s+1;</script>`;  // status-literal-fixture
const BAD_INVENTED = `if (departure.status === "awaiting_supplier") return null;`;  // status-literal-fixture

function fileWith(source, ext = ".js") {
  const dir = mkdtempSync(join(tmpdir(), "status-lit-"));
  const path = join(dir, `sample${ext}`);
  writeFileSync(path, source, "utf8");
  return path;
}

test("the vocabulary comes from the schema, not from a list someone typed", () => {
  // If this ever reads empty the scan below passes on everything, silently.
  assert.ok(vocabulary.values.size >= 15, `only ${vocabulary.values.size} values parsed from the schema`);
  for (const expected of ["cancelled", "open", "minimum_reached", "supplier_confirmed", "confirmed", "pending_review"]) {
    assert.ok(vocabulary.values.has(expected), `the schema's "${expected}" was not collected`);
  }
  assert.ok(!vocabulary.values.has("canceled"), "the misspelling must never be in the vocabulary");
});

test("it fires on the exact defect it was built for", () => {
  const found = scanStatusLiterals(
    [fileWith(BAD_SPA)],
    vocabulary
  );
  assert.equal(found.length, 1, "the misspelling was not caught");
  assert.equal(found[0].value, "canceled");
});

test("it fires on the same defect written in the static pages' style", () => {
  // The three static boards are minified single-quote JS inside <script>. The
  // first draft of the pattern only matched the SPA's spacing.
  const found = scanStatusLiterals(
    [fileWith(BAD_STATIC, ".html")],
    vocabulary
  );
  assert.equal(found.length, 1, "the minified single-quoted form was not caught");
});

test("it fires on a status nobody has thought of yet", () => {
  // The point of building the vocabulary from the schema rather than hunting
  // for one word: a value invented in the front end is caught the same way.
  const found = scanStatusLiterals(
    [fileWith(BAD_INVENTED)],
    vocabulary
  );
  assert.deepEqual(found.map((f) => f.value), ["awaiting_supplier"]);
});

test("it does not fire on a React fetch-state machine", () => {
  // `state.status === "loading"` is a component's own idea of loading, not a
  // row's. Without this the check reports 24 false positives and gets ignored,
  // which is the same as not having it.
  const found = scanStatusLiterals(
    [fileWith(`const [state, setState] = useState({ status: "idle" });\nif (state.status === "loading") return null;\n`)],
    vocabulary
  );
  assert.deepEqual(found, []);
});

test("it does not fire on a value the schema permits", () => {
  const found = scanStatusLiterals(
    [fileWith(`if (d.status === "supplier_confirmed" || p.status !== "cancelled") return true;\n`)],
    vocabulary
  );
  assert.deepEqual(found, []);
});

test("the repository is clean", () => {
  // The assertion that matters day to day. Everything above proves this one is
  // not passing because the scan is broken.
  const problems = scanStatusLiterals(walk(), vocabulary);
  assert.deepEqual(
    problems.map((p) => `${p.file}:${p.line} "${p.value}"`),
    [],
    "a status literal the database can never produce"
  );
});
