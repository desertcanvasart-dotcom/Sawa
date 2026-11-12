// Migrations on deploy (12 Nov 2026): `migrate.js --pending` runs before the
// server starts, on every deploy, against production.
//
// Each test here is a way that could go wrong on a real deploy: a migration
// run twice, a half-applied set, two deploys racing, a failure that still lets
// the new code start. Run against a throwaway database (server/test-db.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip as skip } from "./test-db.js";
import { MIGRATIONS, migratePending, withoutOwnTransaction } from "./db/migrate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_migrate_on_deploy";
let dbUrl;
const quiet = () => {};

const connect = async () => {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  return c;
};
const recorded = async (c) => (await c.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
const cli = (args) => spawnSync(process.execPath, [join(ROOT, "server", "db", "migrate.js"), ...args], {
  env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, encoding: "utf8",
});

before(async () => {
  if (skip) return;
  dbUrl = await freshDatabase(DB_NAME);
});
after(async () => { if (!skip) await dropDatabase(DB_NAME); });

test("an empty database: every migration is applied once and recorded, in one go", { skip }, async () => {
  const c = await connect();
  try {
    const applied = await migratePending({ client: c, log: quiet });
    assert.equal(applied.length, MIGRATIONS.length);
    assert.deepEqual(applied, MIGRATIONS.map((m) => m.name), "applied out of order");
    assert.deepEqual(await recorded(c), MIGRATIONS.map((m) => m.name).sort());
    // 050 wraps itself in BEGIN/COMMIT; it ran inside the deploy's transaction.
    assert.ok((await c.query("SELECT to_regclass('operator_bank_accounts') IS NOT NULL AS ok")).rows[0].ok,
      "050's tables are missing");
  } finally { await c.end(); }
});

test("a deploy with nothing pending changes nothing", { skip }, async () => {
  const c = await connect();
  try {
    const before = await c.query("SELECT name, applied_at FROM schema_migrations ORDER BY name");
    assert.deepEqual(await migratePending({ client: c, log: quiet }), []);
    const afterRows = await c.query("SELECT name, applied_at FROM schema_migrations ORDER BY name");
    assert.deepEqual(afterRows.rows, before.rows);
  } finally { await c.end(); }
});

test("only what is missing runs — the 042 case", { skip }, async () => {
  const c = await connect();
  try {
    await c.query("DELETE FROM schema_migrations WHERE name = '042_email_outbox'");
    const lines = [];
    assert.deepEqual(await migratePending({ client: c, log: (l) => lines.push(l) }), ["042_email_outbox"]);
    assert.ok(lines.includes("Applied: 042_email_outbox"));
    assert.ok((await recorded(c)).includes("042_email_outbox"));
  } finally { await c.end(); }
});

test("a failing migration applies nothing: the ones before it in the same deploy roll back too", { skip }, async () => {
  const c = await connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS zz_canary (id int)");
    const fake = [
      ...MIGRATIONS,
      { name: "998_fine", file: "fine" },
      { name: "999_broken", file: "broken" },
    ];
    const read = async (f) => (f === "fine" ? "ALTER TABLE zz_canary ADD COLUMN added_by_998 int" : "ALTER TABLE no_such_table ADD COLUMN x int");
    await assert.rejects(migratePending({ client: c, migrations: fake, read, log: quiet }), (e) => e.migration === "999_broken");
    const names = await recorded(c);
    assert.ok(!names.includes("998_fine") && !names.includes("999_broken"), "a migration from the failed deploy was recorded");
    const col = await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'zz_canary' AND column_name = 'added_by_998'");
    assert.equal(col.rowCount, 0, "998 changed the schema although the deploy failed");
    // The connection is usable afterwards: the transaction was closed.
    assert.equal((await c.query("SELECT 1 AS one")).rows[0].one, 1);
  } finally { await c.end(); }
});

test("two deploys at once: the migration runs once", { skip }, async () => {
  const [a, b] = [await connect(), await connect()];
  try {
    await a.query("CREATE TABLE IF NOT EXISTS zz_race (n int)");
    const fake = [...MIGRATIONS, { name: "997_race", file: "race" }];
    // Slow enough that the second deploy arrives while the first holds the lock.
    const read = async () => "SELECT pg_sleep(0.3); INSERT INTO zz_race VALUES (1)";
    const [ra, rb] = await Promise.all([
      migratePending({ client: a, migrations: fake, read, log: quiet }),
      migratePending({ client: b, migrations: fake, read, log: quiet }),
    ]);
    assert.deepEqual([...ra, ...rb], ["997_race"], "both deploys applied it, or neither did");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM zz_race")).rows[0].n, 1);
  } finally { await a.end(); await b.end(); }
});

test("from the command line: a failure exits non-zero, so the server never starts", { skip }, async () => {
  const ok = cli(["--pending"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /No pending migrations\./);

  // Break the database under it: schema_migrations says 042 is missing, and
  // the table 042 alters is gone, so 042 cannot apply.
  const c = await connect();
  try {
    await c.query("DELETE FROM schema_migrations WHERE name = '042_email_outbox'");
    await c.query("DROP TABLE email_log CASCADE");
  } finally { await c.end(); }
  const bad = cli(["--pending"]);
  assert.notEqual(bad.status, 0, "a failed migration must stop `npm start` before app.js");
  assert.match(bad.stderr, /Migration failed in 042_email_outbox/);
  assert.match(bad.stderr, /Nothing was applied/);
});

test("the start command runs the pending migrations before anything else", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const steps = pkg.scripts.start.split("&&").map((s) => s.trim());
  assert.equal(steps[0], "node server/db/migrate.js --pending");
  assert.equal(steps.at(-1), "node server/app.js");
});

test("every migration can run inside the deploy's transaction", () => {
  // CREATE INDEX CONCURRENTLY, VACUUM and friends refuse to run in a
  // transaction block. One of them in a migration would fail every deploy.
  const files = MIGRATIONS.map((m) => m.file);
  assert.ok(files.length >= 70);
  const refused = files.filter((f) => /\b(CONCURRENTLY|VACUUM|ALTER\s+SYSTEM|CREATE\s+DATABASE)\b/i
    .test(readFileSync(join(ROOT, "server", "db", f), "utf8").replace(/--[^\n]*/g, "")));
  assert.deepEqual(refused, [], "these cannot run inside a transaction");
  // And a file that opens its own transaction is unwrapped, not nested.
  const own = "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n";
  assert.doesNotMatch(withoutOwnTransaction(own), /^(BEGIN|COMMIT);/m);
  assert.match(withoutOwnTransaction(own), /CREATE TABLE t/);
});

test("every schema file in server/db is in the runner's list", () => {
  const listed = new Set(MIGRATIONS.map((m) => m.file));
  const onDisk = readdirSync(join(ROOT, "server", "db")).filter((f) => /^schema(_\d{3}_.+)?\.sql$/.test(f));
  assert.ok(onDisk.length >= 70);
  assert.deepEqual(onDisk.filter((f) => !listed.has(f)), [], "a migration that deploys would never apply");
});
