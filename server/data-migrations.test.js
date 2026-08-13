// The migrations in this repo that change DATA rather than shape.
//
// Every other schema_*.sql creates a table or adds a column, and re-running it is
// a no-op by construction. These run UPDATE statements against live rows carrying
// money, in a runner that re-executes every file on every invocation. Both of
// those facts have to hold for each of them, and neither is visible by reading a
// file casually — so they are asserted here.
//
//   031  every package moves from a 20% deposit to 25%
//   032  one product was published as a package and is a day tour
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_DEPOSIT_PCT, DAY_TOUR_DEPOSIT_PCT } from "../shared/booking-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "server", "db", "schema_031_package_deposit_25.sql"), "utf8");
// Statements only — the reasoning above them names `pledges` and `20` freely,
// and a check that read the comments would pass or fail on prose.
// `^\\s*--` and not `^--`: these files carry comments INSIDE the SET clause,
// indented. Stripping only column-zero comments left that prose in the string
// every assertion below reads, so "it never touches pledges" would have been
// answered by a sentence about pledges rather than by a statement.
const strip = (sql) => sql.replace(/^\s*--.*$/gm, "").trim();
const statements = strip(SQL);

test("it moves packages to the rate the code now returns", () => {
  assert.equal(PACKAGE_DEPOSIT_PCT, 25);
  assert.match(statements, new RegExp(String.raw`SET deposit_percent = ${PACKAGE_DEPOSIT_PCT}\b`),
    "the migration and shared/booking-policy.js must agree on the new rate");
});

test("it never touches pledges", () => {
  // `pledges.deposit_percent` is write-time capture (023): the figure a named
  // traveller was quoted, shown, emailed and agreed to. Updating it would
  // retroactively change what someone already owes, and leave no record of the
  // number they were actually given.
  assert.ok(!/\bpledges\b/i.test(statements),
    "this migration must not rewrite a quote a traveller has already been given");
  assert.ok(/\btour_products\b/.test(statements) && /\bdepartures\b/.test(statements),
    "it must move both of the tables that hold the DEFAULT rate");
});

test("every UPDATE is guarded on the superseded value", () => {
  // server/db/migrate.js re-runs EVERY file on every invocation. `WHERE type =
  // 'package'` alone would re-stomp the rate to 25 on each future run, so an
  // operator who later set one package to 30% would find it silently reverted by
  // an unrelated migration, with nothing in the logs to say why.
  const updates = statements.match(/UPDATE[\s\S]*?;/g) || [];
  assert.ok(updates.length >= 2, `expected the UPDATEs, found ${updates.length}`);
  for (const u of updates) {
    assert.match(u, /deposit_percent = 20/,
      `an UPDATE without the old-value guard re-applies forever:\n${u}`);
  }
});

test("it is idempotent — a second run changes nothing", () => {
  // Matching on the old value makes the statement expire by itself: once no 20%
  // package remains, every UPDATE matches zero rows. This is the property that
  // makes it safe in a runner that cannot skip it.
  const updates = statements.match(/UPDATE[\s\S]*?;/g) || [];
  // DIR-14 — a loop is a claim about every UPDATE and says nothing about whether
  // there are any. A regex that matched none would report this migration safe
  // while it re-stomped the rate on every run.
  assert.equal(updates.length, 3);
  for (const u of updates) {
    const sets = (u.match(/SET deposit_percent = (\d+)/) || [])[1];
    const guards = (u.match(/deposit_percent = (\d+)/g) || []).map((m) => m.split("= ")[1]);
    assert.ok(guards.includes("20"), "no guard on the old rate");
    assert.notEqual(sets, "20", "an UPDATE that sets what it matches would loop");
  }
});

// W3 — the three assertions above all pass by reading one file that is already
// correct, which is also exactly what they would do if they matched nothing.
// These run the same rules over the two mistakes they exist to catch.
const unguarded = (sql) => (sql.match(/UPDATE[\s\S]*?;/g) || [])
  .filter((u) => !/deposit_percent = 20/.test(u));

test("it fires — an UPDATE with no old-value guard", () => {
  const bad = "UPDATE departures SET deposit_percent = 25 WHERE type = 'package';";
  assert.equal(unguarded(bad).length, 1, "an unguarded UPDATE went undetected");
  assert.equal(unguarded(statements).length, 0, "the real migration should be clean");
});

test("it fires — a migration that reaches into pledges", () => {
  const bad = "UPDATE pledges SET deposit_percent = 25 WHERE deposit_percent = 20;";
  assert.ok(/\bpledges\b/i.test(bad), "the pledges rule went undetected");
  assert.ok(!/\bpledges\b/i.test(statements));
});

test("it is registered, or it can never run", () => {
  const runner = readFileSync(join(ROOT, "server", "db", "migrate.js"), "utf8");
  assert.match(runner, /schema_031_package_deposit_25\.sql/,
    "an unregistered migration is skipped in silence and reported as applied");
});

test("it says it does not run on deploy", () => {
  // check:applied-schema's own header: "Migrations do not run on deploy (B5).
  // Merging a migration ships a FILE." Nobody should read this file and assume
  // the rate has moved in production because the PR merged.
  const check = readFileSync(join(ROOT, "scripts", "check-applied-schema.js"), "utf8");
  assert.match(check, /Migrations do not run on deploy/,
    "if this stops being true, 031's rollout note is wrong");
});

// ---- 032 — a product typed as the wrong thing --------------------------------

const SQL_032 = readFileSync(
  join(ROOT, "server", "db", "schema_032_minya_is_a_day_tour.sql"), "utf8");
const stmts032 = strip(SQL_032);
const MINYA = "pkg_full_day_minya_archaeological_to_msm1lioi";

test("032 corrects the type, which is the field the system acts on", () => {
  assert.match(stmts032, /SET type = 'day_tour'/);
  assert.match(stmts032, new RegExp(`WHERE id = '${MINYA}'`),
    "it must name the one row, not every mistyped product");
});

test("032 returns the deposit to the day-tour rate", () => {
  // 031 raised this row to 25 while it was still typed as a package. Left at 25
  // it would serve a package's deposit beside a day tour's cancellation
  // schedule — the contradiction #147 closed everywhere else.
  // String.raw, because `\b` inside a plain template literal is the BACKSPACE
  // character rather than a word boundary — the first draft of these two built
  // /deposit_percent = 10\x08/, which cannot match anything, and the negative
  // assertion below passed for the same empty reason.
  assert.match(stmts032, new RegExp(String.raw`deposit_percent = ${DAY_TOUR_DEPOSIT_PCT}\b`));
  assert.ok(!new RegExp(String.raw`deposit_percent = ${PACKAGE_DEPOSIT_PCT}\b`).test(stmts032),
    "032 must not leave the package rate on a day tour");
});

test("032 writes the house duration format for a tour over eight hours", () => {
  // Day tours read "Full day · about N hours" up to eight and "Extended day ·
  // about N hours" beyond it. This one is fifteen. Its old value, "1 day · 15
  // hours", was a package-shaped string and matched neither.
  const duration = (stmts032.match(/duration = '([^']+)'/) || [])[1];
  assert.ok(duration, "no duration is set");
  assert.match(duration, /^Extended day · about \d+(\.\d+)? hours$/,
    `"${duration}" is not the house format for a day tour over eight hours`);
  assert.ok(!/^Full day/.test(duration), "fifteen hours is not a full day");
});

test("032 clears the package machinery it leaves behind", () => {
  // Inert either way — `isPackage` gates both in the app — but a record still
  // claiming a hotel tier is how someone later "restores" the package type
  // believing it was right.
  assert.match(stmts032, /nights = NULL/);
  assert.match(stmts032, /accommodation_tiers = NULL/);
});

test("032 is guarded on the wrong value, so it cannot re-apply", () => {
  const updates = stmts032.match(/UPDATE[\s\S]*?;/g) || [];
  assert.equal(updates.length, 2, "product row and any inherited departures");
  for (const u of updates) {
    assert.match(u, /type = 'package'/,
      `an UPDATE without the old-value guard re-applies on every migrate run:\n${u}`);
  }
});

test("032 never touches pledges either", () => {
  assert.ok(!/\bpledges\b/i.test(stmts032));
});

test("032 keeps the id, which is a reference and not a label", () => {
  // The `pkg_` prefix is now misleading and stays anyway: departures.tour_product_id
  // and every audit_log row naming this product point at it.
  // Scoped to each SET clause. The first draft used /SET[\s\S]*id = /, which ran
  // greedily past the SET and matched the `WHERE id = ...` it was meant to allow.
  const setClauses = (stmts032.match(/SET[\s\S]*?WHERE/g) || []).map((c) => c.slice(0, -5));
  assert.ok(setClauses.length, "no SET clause found — the parser is wrong, not the SQL");
  for (const c of setClauses) {
    assert.ok(!/\bid\s*=/.test(c), `renaming the id would break its references:\n${c}`);
  }
});

test("032 is registered", () => {
  const runner = readFileSync(join(ROOT, "server", "db", "migrate.js"), "utf8");
  assert.match(runner, /schema_032_minya_is_a_day_tour\.sql/);
});

test("it fires — a 032-shaped UPDATE with no type guard", () => {
  const bad = `UPDATE tour_products SET type = 'day_tour' WHERE id = '${MINYA}';`;
  assert.ok(!/type = 'package'/.test(bad), "the guard rule went undetected");
  assert.ok((stmts032.match(/UPDATE[\s\S]*?;/g) || []).every((u) => /type = 'package'/.test(u)));
});
