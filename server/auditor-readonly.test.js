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
// Two assertions here, because the guarantee has two halves: the pool must be
// configured to refuse writes, and no auditor may reach past it to the writable
// one. The first is proved against a real database in
// docs/audit/readonly-credentials.md; a session setting cannot be observed
// without a server, so what is checked here is that it is asked for.
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
