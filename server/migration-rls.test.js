// 026 / 024 — a table created after 024 is not covered by 024.
//
// 024 enabled row-level security on every table that EXISTED when it ran. It
// cannot reach one created afterwards. Its REVOKE carries forward through
// ALTER DEFAULT PRIVILEGES; **RLS does not.**
//
// So the next migration that creates a table reopens exactly the hole 024
// closed, silently, and the most likely candidate is the newest table — which
// is usually the one holding the newest kind of personal data. `route_alerts`
// is a list of email addresses belonging to people who have not booked
// anything.
//
// This is the guard that generalises. Written as a test rather than a note
// because a note is a promise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "server", "db");

// Migrations predating 024 are covered by 024's own dynamic sweep, which runs
// over every table in `public` at the time it is applied.
const COVERED_BY_024 = (file) => {
  const n = Number((file.match(/^schema_(\d+)_/) || [])[1] ?? 1);
  return n <= 24;
};

const sqlFiles = readdirSync(DB).filter((f) => f.endsWith(".sql")).sort();
const strip = (s) => s.replace(/--[^\n]*/g, "");

test("there are migrations to check, or this asserts nothing", () => {
  assert.ok(sqlFiles.length >= 20, `only ${sqlFiles.length} migration files found`);
});

test("every table created after 024 enables RLS in the same migration", () => {
  const missing = [];
  for (const f of sqlFiles) {
    if (COVERED_BY_024(f)) continue;
    const sql = strip(readFileSync(join(DB, f), "utf8"));
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)) {
      const table = m[1];
      const enables = new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`, "i").test(sql);
      if (!enables) missing.push(`${f}: ${table}`);
    }
  }
  assert.deepEqual(missing, [],
    "a table created after 024 without RLS reopens the Data API exposure 024 closed");
});

test("it fires — a table without the ALTER is caught", () => {
  // NNN1. The check above passes today; this is what says it can fail.
  const sql = "CREATE TABLE IF NOT EXISTS widgets (id BIGSERIAL PRIMARY KEY);";
  assert.ok(!/ALTER TABLE widgets\s+ENABLE ROW LEVEL SECURITY/i.test(sql));
});

test("026 — consent is nullable with no default", () => {
  const sql = readFileSync(join(DB, "schema_026_route_alerts.sql"), "utf8");
  const line = sql.split("\n").find((l) => /^\s*consent\s+BOOLEAN/.test(l));
  assert.ok(line, "no consent column");
  assert.ok(!/DEFAULT/i.test(line),
    "false would be a refusal nobody made — a different claim from having no record");
  assert.match(sql, /consent_text/, "proving consent means proving what was agreed to");
});

test("026 — a month is a month, and one person asks once", () => {
  const sql = readFileSync(join(DB, "schema_026_route_alerts.sql"), "utf8");
  assert.match(sql, /preferred_month ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_route_alerts_email_product[\s\S]{0,120}lower\(email\)/,
    "the same person asking twice is not two people");
});

test("026 — nothing writes to it yet", () => {
  // The columns may exist; the INSERT may not, until DIR-12 publishes the
  // processing. These are email addresses collected to send marketing later,
  // which is consent territory rather than the transparency-only basis that
  // covers attribution.
  for (const f of ["server/app.js", "server/db/mappers.js", "server/email.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.ok(!/route_alerts/.test(src), `${f} already touches route_alerts — that is a separate change`);
  }
});

test("the button still points where it can be answered", () => {
  // Until the capture exists AND the notice publishes, /contact remains the
  // honest destination. A form that captured an address and told nobody would
  // be the same fabrication in a politer shape.
  const idx = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  assert.match(idx, /Tell me when a group forms/);
  assert.match(idx, /href="\/contact"[^>]*>Tell me when a group forms/);
});
