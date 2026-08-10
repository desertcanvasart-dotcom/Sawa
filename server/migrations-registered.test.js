// Every migration file on disk is in the runner's list.
//
// 027 and 028 were written, reviewed and merged WITHOUT being added to
// `server/db/migrate.js`. `npm run db:migrate` would have skipped both in
// silence — no error, no warning, and the schema simply not there.
//
// `check:applied-schema` could not catch it either: `expectedMigrations()`
// parses that same hand-written list, so an unregistered file is invisible to
// the runner AND to the check that exists to notice unapplied migrations. Both
// would have reported everything applied.
//
// This is the hand-written-catalogue defect DIR-7 removed for duplications,
// still live in the one place where the cost is a schema change that never
// happened. The list stays hand-written — order matters and a filename cannot
// express a dependency — but it can no longer be INCOMPLETE.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedMigrations } from "../scripts/check-applied-schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "server", "db");

const filesOnDisk = () => readdirSync(DB).filter((f) => /^schema_\d+.*\.sql$/.test(f)).sort();
const registered = () => {
  const src = readFileSync(join(DB, "migrate.js"), "utf8");
  return [...src.matchAll(/file:\s*"([^"]+)"/g)].map((m) => m[1]);
};

test("every migration file on disk is registered in the runner", () => {
  const disk = filesOnDisk();
  assert.ok(disk.length > 20, `only ${disk.length} migration files found — refusing to report clean`);
  const known = new Set(registered());
  const unregistered = disk.filter((f) => !known.has(f));
  assert.deepEqual(unregistered, [],
    `these migrations exist and can never run:\n  ${unregistered.join("\n  ")}\n\n`
    + `\`npm run db:migrate\` skips them in silence, and \`check:applied-schema\` `
    + `parses this same list — so both would report everything applied.`);
});

test("and every registered file exists", () => {
  const disk = new Set([...filesOnDisk(), "schema.sql"]);
  const missing = registered().filter((f) => !disk.has(f));
  assert.deepEqual(missing, [], `migrate.js names files that are not there: ${missing.join(", ")}`);
});

test("the checker's expected list agrees with the runner's", () => {
  // expectedMigrations() parses migrate.js by regex. If that parse ever drifts
  // from what the runner actually iterates, the check silently narrows.
  const expected = expectedMigrations();
  assert.equal(expected.length, registered().length,
    "check:applied-schema and the runner disagree about how many migrations exist");
  assert.ok(expected.includes("027_pin_group_minimum"));
  assert.ok(expected.includes("028_payment_window"));
});

test("it fires — an unregistered file is reported by name", () => {
  const known = new Set(["schema_001.sql"]);
  const unregistered = ["schema_001.sql", "schema_999_invented.sql"].filter((f) => !known.has(f));
  assert.deepEqual(unregistered, ["schema_999_invented.sql"]);
});
