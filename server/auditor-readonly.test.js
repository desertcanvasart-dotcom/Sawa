// X1 — audit the auditors.
//
// The incident: `scripts/audit-claims.js` renders every email template to check
// the copy in them. A name pattern matched `sendEmail`, so the audit CALLED it,
// and a row appeared in the production `email_log`. The row was deleted and the
// pattern became an explicit ALLOW-list.
//
// That fixed the instance. An auditor that reviews a claim and changes the
// system while doing so is not an auditor, and the way to guarantee it does not
// is NOT to keep reviewing what it does — it is to hand it a connection on which
// a write is impossible.
//
// UU1 — the layering, stated the right way round.
//
// It was found session-first, which made the session setting look like the
// primary guarantee. It is not. A SESSION SETTING CAN BE TALKED OUT OF: one
// `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE` and it is gone. A
// role without write grants cannot be talked out of anything.
//
// So the session setting is the CONVENIENT layer — it works today, with the
// credentials that already exist, without waiting for anyone. The role is the
// UNCONDITIONAL one, and it is still outstanding. Nothing in this file makes
// the guarantee unconditional; see docs/audit/readonly-credentials.md.
//
// The checks below are a POINTER, not a verdict. A dynamically-built statement
// string defeats every one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlyPool, readOnlyUrl, READ_ONLY_SQLSTATE } from "./db/readonly.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

// Auditors: they read the system and report. Nothing here may change it.
const AUDITORS = readdirSync(SCRIPTS).filter((f) => /^audit-.*\.js$/.test(f));

test("there are auditors to check — this test is not vacuous", () => {
  assert.ok(AUDITORS.length >= 2, `only ${AUDITORS.length} auditor(s) found in scripts/`);
});

test("no auditor imports the writable pool", () => {
  // The one that matters. server/db/index.js is the app's pool: full rights,
  // and every write in the codebase goes through it. An auditor reaching it
  // gets exactly the access that wrote to email_log.
  const offenders = AUDITORS.filter((f) =>
    /["']\.\.\/server\/db\/index\.js["']/.test(readFileSync(join(SCRIPTS, f), "utf8")));
  assert.deepEqual(offenders, [], `these auditors can write: ${offenders.join(", ")}`);
});

test("every auditor that touches the database uses the read-only pool", () => {
  // The complement of the test above: not importing the writable pool is not
  // enough if an auditor opens its own Pool from the raw connection string.
  const problems = [];
  for (const f of AUDITORS) {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    const touchesDb = /readOnlyPool|db\/index\.js|new Pool|pg\b/.test(src);
    if (!touchesDb) continue;
    if (!/readOnlyPool/.test(src)) problems.push(`${f} reaches the database without readOnlyPool`);
    if (/new Pool\s*\(/.test(src)) problems.push(`${f} constructs its own Pool, bypassing the guarantee`);
  }
  assert.deepEqual(problems, [], problems.join("\n  "));
});

test("the read-only pool asks the session to refuse writes", () => {
  // `default_transaction_read_only=on` applies per SESSION, so it covers
  // implicit single-statement transactions too — an unwrapped INSERT is
  // rejected, not just one inside BEGIN/COMMIT.
  const pool = readOnlyPool({ DATABASE_URL: "postgres://unused@127.0.0.1:1/never-connected" });
  assert.match(
    String(pool.options.options || ""),
    /default_transaction_read_only\s*=\s*on/,
    "the session is not restricted — a write would succeed"
  );
  // Never connected: a pg Pool opens no socket until a query runs.
  return pool.end();
});

test("a dedicated read-only URL wins when one is provisioned", () => {
  // The session restriction works today against the app's own credentials, so
  // the guarantee does not wait on anyone. A real least-privilege role is still
  // the end state, and this is how it gets picked up without a code change.
  assert.equal(
    readOnlyUrl({ DATABASE_URL: "postgres://app", DATABASE_URL_READONLY: "postgres://reader" }),
    "postgres://reader"
  );
  assert.equal(readOnlyUrl({ DATABASE_URL: "postgres://app" }), "postgres://app");
});

test("the SQLSTATE a caller should expect is named, not guessed", () => {
  assert.equal(READ_ONLY_SQLSTATE, "25006");
});

// UU1.1 — an auditor talking the session out of being read-only.
//
// Cheap, and it catches the plausible case: someone hits a permissions error
// while writing an audit and reaches for the obvious unblock.
//
// A POINTER, deliberately labelled: `client.query("SET SESSION " + mode)` walks
// straight past it. Only the least-privilege role closes this, which is why
// that role stays on the client list rather than being marked done.
const TAMPERING = [
  /SET\s+SESSION\s+CHARACTERISTICS/i,
  /SET\s+(?:SESSION\s+|LOCAL\s+)?default_transaction_read_only/i,
  /BEGIN\s+(?:TRANSACTION\s+)?READ\s+WRITE/i,
  /START\s+TRANSACTION\s+READ\s+WRITE/i,
  /SET\s+TRANSACTION\s+READ\s+WRITE/i,
];

test("no auditor talks its session out of being read-only", () => {
  const problems = [];
  for (const f of AUDITORS) {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    for (const re of TAMPERING) {
      const hit = src.match(re);
      if (hit) problems.push(`${f}: ${hit[0]}`);
    }
  }
  assert.deepEqual(problems, [], `an auditor re-enables writes:\n  ${problems.join("\n  ")}`);
});

test("the tampering patterns actually match the statements they name — W3", () => {
  // Without this, a typo in a pattern makes the test above pass on everything.
  const shouldMatch = [
    'await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE")',
    "pool.query('SET default_transaction_read_only = off')",
    'client.query("BEGIN READ WRITE")',
    'client.query("START TRANSACTION READ WRITE")',
    'client.query("SET TRANSACTION READ WRITE")',
  ];
  for (const line of shouldMatch) {
    assert.ok(TAMPERING.some((re) => re.test(line)), `not caught: ${line}`);
  }
  // And it must not fire on the setting the pool legitimately asks for.
  assert.ok(
    !TAMPERING.some((re) => re.test('options: "-c default_transaction_read_only=on"')),
    "the pool's own configuration is flagged as tampering"
  );
});
