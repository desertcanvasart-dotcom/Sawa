// X1 — the connection the audit tooling uses. It cannot write.
//
// Why this exists: `scripts/audit-claims.js` renders every email template to
// check the copy in them. A name pattern matched `sendEmail`, so the audit
// CALLED it — and wrote a row to the production `email_log`. The row was
// deleted and the pattern replaced with an explicit ALLOW-list.
//
// That fixed the instance. This closes the class: an auditor must have no side
// effects, and the way to guarantee that is not to keep reviewing what the
// auditor does. It is to hand it a connection on which a write is impossible.
//
// `default_transaction_read_only=on` is set per SESSION, so it applies to every
// statement including implicit single-statement transactions. An INSERT through
// this pool raises 25006 — read-only SQL transaction — regardless of what the
// credentials would otherwise permit.
//
// That last clause is the point. This works TODAY, against the existing
// write-capable credentials, without waiting for anyone to provision a role.
// A genuine least-privilege role is still the right end state and the SQL for
// it is in docs/RUNBOOK.md — but the guarantee should not be waiting on it.
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

// A dedicated read-only URL wins if one is set. Otherwise the ordinary one is
// used and the session restriction does the work — belt first, braces when
// somebody provisions them.
export function readOnlyUrl(env = process.env) {
  return env.DATABASE_URL_READONLY || env.DATABASE_URL;
}

export function readOnlyPool(env = process.env) {
  const connectionString = readOnlyUrl(env);
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  return new Pool({
    connectionString,
    ssl: env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    // Auditors are not latency-sensitive and should not compete with the app.
    max: 2,
    idleTimeoutMillis: 10_000,
    // The guarantee.
    options: "-c default_transaction_read_only=on",
  });
}

// Postgres' own error for "you tried to write on a read-only transaction".
export const READ_ONLY_SQLSTATE = "25006";
