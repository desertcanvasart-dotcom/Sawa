// 031 — the one migration in this repo that changes DATA rather than shape.
//
// Every other schema_*.sql creates a table or adds a column, and re-running it
// is a no-op by construction. This one runs UPDATE statements against live rows
// carrying money, in a runner that re-executes every file on every invocation.
// Both of those facts have to hold, and neither is visible by reading the file
// casually — so they are asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_DEPOSIT_PCT } from "../shared/booking-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "server", "db", "schema_031_package_deposit_25.sql"), "utf8");
// Statements only — the reasoning above them names `pledges` and `20` freely,
// and a check that read the comments would pass or fail on prose.
const statements = SQL.replace(/^--.*$/gm, "").trim();

test("it moves packages to the rate the code now returns", () => {
  assert.equal(PACKAGE_DEPOSIT_PCT, 25);
  assert.match(statements, new RegExp(`SET deposit_percent = ${PACKAGE_DEPOSIT_PCT}`),
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
