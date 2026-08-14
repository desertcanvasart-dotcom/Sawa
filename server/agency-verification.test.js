// OOO3.1 / VVV3 — the record must hold what /verify says is checked.
//
// MMM1: `agencies` had five columns and /verify asks an operator to produce four
// documents. There was nowhere to put the answer to any of them, which is why
// /verification-standard is blocked on the schema and not only on the client's
// list of checks.
//
// This asserts the migration against the PAGE's promises. The page and the
// record must not describe different things — if /verify asks for it, the table
// holds it, or one of them is lying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "server", "db", "schema_025_agency_verification.sql"), "utf8");
const MIGRATE = readFileSync(join(ROOT, "server", "db", "migrate.js"), "utf8");

test("it is registered, or it is a file nobody runs", () => {
  assert.match(MIGRATE, /025_agency_verification/);
});

test("every document /verify asks for has somewhere to go", () => {
  // "a current Ministry of Tourism license, ETAA registration, valid insurance,
  // and a track record we can check."
  for (const [thing, column] of [
    ["Ministry of Tourism licence", "tourism_license_no"],
    ["ETAA registration", "etaa_registration_no"],
    ["insurance", "insurance_policy_no"],
    ["track record", "track_record"],
  ]) {
    assert.match(SQL, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), `${thing} has nowhere to go`);
  }
});

test("expiry is a column, because \"we confirm it's active\" is present tense", () => {
  // A confirmation dated eighteen months ago against a licence that has lapsed
  // since is not evidence for a present-tense claim.
  assert.match(SQL, /tourism_license_expires\s+DATE/);
  assert.match(SQL, /insurance_expires\s+DATE/);
});

test("the write-time fields exist — the part that cannot be reconstructed", () => {
  // The 023 argument. A verification performed and unrecorded is unrecoverable
  // the moment it is done.
  assert.match(SQL, /verified_at\s+TIMESTAMPTZ/, "a timestamp, not a boolean");
  assert.match(SQL, /verified_by\s+UUID/, "by whom");
  assert.match(SQL, /verification_evidence/, "against what");
});

test("verification_state has no default, so no row is assessed by accident", () => {
  const line = SQL.split("\n").find((l) => l.includes("verification_state TEXT"));
  assert.ok(line && !/DEFAULT/i.test(line),
    "a DEFAULT would turn every existing row into an assessment nobody made");
  assert.match(SQL, /verification_state IS NULL\s*\n?\s*OR verification_state IN \('verified', 'rejected', 'lapsed'\)/);
});

test("the payout account is deliberately absent, with the reason stated", () => {
  // The fourth thing /verify asks for. Same argument that kept payment schema
  // out of 023: it encodes a model in which Sawa holds and disburses funds, and
  // legal question 1 is open. An omission with no reason recorded reads as an
  // oversight and gets "fixed".
  assert.ok(!/payout|iban|bank_account|sort_code/i.test(SQL.replace(/--[^\n]*/g, "")),
    "payout columns must not be added while legal question 1 is open");

  // The reason wraps across comment lines, so the comment markers and line
  // breaks are collapsed before matching. Matching raw text would have failed
  // on formatting rather than on substance — a check that fails while the code
  // is correct is the NNN1 failure, and it gets "fixed" by deletion.
  const prose = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
  assert.match(prose, /payout account[\s\S]{0,400}legal question 1/, "the omission must carry its reason");
});

test("the migration itself still writes no data", () => {
  // VVV3.3. Adding a column and adding the code that fills it are separate
  // changes; shipping them together is a schema change and a behaviour change
  // reviewed as one piece. THE MIGRATION half of that rule is permanent.
  const code = SQL.replace(/--[^\n]*/g, "");
  assert.ok(!/\bINSERT\s+INTO\b|\bUPDATE\s+agencies\s+SET\b/i.test(code), "the migration writes data");
});

test("the write path arrived as its own change, and is admin-only", () => {
  // This test used to assert that server/app.js did NOT touch these columns —
  // the "separate change" half of VVV3.3, holding the line until the client
  // decided. That decision came on 14 August 2026: operator records are being
  // filled in, starting with the first operator to join.
  //
  // So the assertion inverts rather than being deleted. What it guards now is
  // the thing that actually matters once a write path exists: WHO may write.
  const app = readFileSync(join(ROOT, "server/app.js"), "utf8");
  const route = /app\.patch\("\/api\/admin\/agencies\/:id"[^\n]*/.exec(app);
  assert.ok(route, "the operator record has no write path");
  assert.match(route[0], /requireAuth/, "the operator record is writable without a session");
  assert.match(route[0], /requireAdmin\(\)/, "an agency could edit its own verification");
  assert.match(route[0], /writeLimiter/);
});

test("a verification date is set by the server, never accepted from the caller", () => {
  // A verification date is evidence about when somebody looked. A caller that
  // could choose it could date a check that never happened.
  const app = readFileSync(join(ROOT, "server/app.js"), "utf8");
  const schema = /const operatorRecordSchema = z\.object\(\{[\s\S]*?\}\);/.exec(app);
  assert.ok(schema, "the operator record schema is gone");
  assert.ok(!/verifiedAt|verified_at/.test(schema[0]),
    "verifiedAt is accepted from the request body");
  assert.match(app, /verifiedAt = nowVerified/, "the server must stamp it");
});

test("the licence number never reaches the audit log", () => {
  // /verify promises it is not shared outside Sawa, and an audit row is read by
  // more people than the form that set it.
  const app = readFileSync(join(ROOT, "server/app.js"), "utf8");
  const audit = /action: "agency\.verification"[\s\S]{0,400}?\}\);/.exec(app);
  assert.ok(audit, "the verification write is not audited at all");
  assert.ok(!/tourismLicenseNo|tourism_license_no/.test(audit[0]),
    "the licence number is written into the audit detail");
});
