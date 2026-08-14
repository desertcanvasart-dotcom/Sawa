// 033 — the hotel tier ladder, and the one tier that must NOT be renamed.
//
// The floor on any package is four-star: Sawa sells no three-star package. The
// ladder becomes Four-star / Five-star Standard / Five-star Deluxe.
//
// The trap this file exists for: "Nile Majesty" carries a single tier whose id
// is `standard` and whose name is "Five-star Nile cruiser". Keyed on the id — the
// obvious way to write this migration — that five-star boat would have been
// relabelled "Four-star", one star LOWER than it is, on the only package that
// needed no change at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SQL = read("server/db/schema_033_hotel_tier_names.sql");
const stmts = SQL.replace(/^\s*--.*$/gm, "").trim();

// The rename pairs, read out of the SQL rather than restated here — restating
// them would make this a copy of the migration instead of a check on it.
const renames = [...stmts.matchAll(/WHEN '([^']+)'\s*THEN jsonb_set\(t, '\{name\}', '"([^"]+)"'\)/g)]
  .map((m) => [m[1], m[2]]);

test("the ladder is the one the client asked for", () => {
  assert.equal(renames.length, 4, "three cruise-package tiers plus the lone Standard (3★)");
  const map = Object.fromEntries(renames);
  assert.equal(map["Standard (3★ / 5★ cruise)"], "Four-star");
  assert.equal(map["Superior (4★ / deluxe cruise)"], "Five-star Standard");
  assert.equal(map["Luxury (5★ / luxury cruise)"], "Five-star Deluxe");
  // The single-tier package that also carried a three-star label.
  assert.equal(map["Standard (3★)"], "Four-star");
});

test("no tier is left below four stars", () => {
  for (const [, to] of renames) {
    assert.ok(!/3★|three-star/i.test(to), `"${to}" still reads below four stars`);
  }
});

test("it matches on the NAME, never on the tier id", () => {
  // Keyed on id, "Five-star Nile cruiser" (id: standard) becomes "Four-star".
  assert.ok(!/WHEN t->>'id'/.test(stmts), "keying on the id relabels a five-star cruise as four-star");
  assert.match(stmts, /CASE t->>'name'/);
});

test("the five-star cruise tier is untouched", () => {
  const NILE = "Five-star Nile cruiser";
  assert.ok(!renames.some(([from]) => from === NILE), `${NILE} must not be renamed`);
  assert.ok(!stmts.includes(NILE), "it should not appear in the migration at all");
});

test("the tier ids do not change", () => {
  // pledges.accommodation_tier stores the id a traveller chose. Renaming
  // `superior` would orphan every booking pointing at it.
  assert.ok(!/'\{id\}'/.test(stmts), "the id is a reference, not a label");
  assert.match(stmts, /'\{name\}'/);
});

test("supplements are not repriced", () => {
  // This renames what is on offer. Whether a four-star floor should cost more
  // than the old three-star floor is a separate decision about published_rate.
  assert.ok(!/perPersonSupplement|per_person_supplement|singleSupplement/i.test(stmts),
    "033 must not touch the money");
  assert.ok(!/published_rate|break_price|deposit_percent/.test(stmts));
});

test("it is guarded, so it cannot re-apply or churn every package", () => {
  assert.match(stmts, /LIKE '%Standard \(3★%'/);
  assert.match(stmts, /type = 'package'/);
  assert.match(stmts, /jsonb_typeof\(accommodation_tiers\) = 'array'/);
  // SIMILAR TO would treat these parentheses as grouping.
  assert.ok(!/SIMILAR TO/.test(stmts), "LIKE has no metacharacter here but % and _");
});

test("it never touches pledges", () => {
  assert.ok(!/\bpledges\b/i.test(stmts));
});

test("it is registered", () => {
  assert.match(read("server/db/migrate.js"), /schema_033_hotel_tier_names\.sql/);
});

// ---- the sources that would put a three-star tier back ----------------------

test("a new package created in the admin panel starts at four-star", () => {
  // This seeded `Standard (3★)` and is why a package carried one. Same shape as
  // the 20% deposit default: a stale literal here re-creates what a migration
  // has just cleaned up, one product at a time.
  const src = read("src/AdminDashboard.jsx");
  assert.match(src, /\{ id: "standard", name: "Four-star", perPersonSupplement: 0, singleSupplement: 0 \}/);
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/name: "Standard \(3★\)"/.test(code), "the three-star default is still there");
});

test("the seeded cruise package uses the new ladder", () => {
  const code = read("server/db/add-package.js").replace(/^\s*\/\/.*$/gm, "");
  for (const n of ["Four-star", "Five-star Standard", "Five-star Deluxe"]) {
    assert.ok(code.includes(`name: "${n}"`), `add-package.js is missing "${n}"`);
  }
  assert.ok(!/3★/.test(code), "a reseed would restore a three-star tier");
});

test("no source in the repo still offers three stars", () => {
  // Comments are stripped: this change is explained beside itself in several
  // files, and those explanations quote the name being removed.
  const files = ["src/AdminDashboard.jsx", "server/db/add-package.js",
                 "server/db/add-package-nile-majesty.js", "site/_dev_bootstrap.json"];
  const offenders = files.filter((f) => /3★/.test(read(f).replace(/^\s*\/\/.*$/gm, "")));
  assert.deepEqual(offenders, []);
});
