// O01 — the email outbox against a REAL Postgres. Runs only when
// TEST_DATABASE_URL points at a disposable database (it creates and drops
// email_log there); otherwise every test is skipped, so the normal suite needs
// no database.
//
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
const URL = process.env.TEST_DATABASE_URL;
if (URL) process.env.DATABASE_URL = URL;
process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/none";
process.env.RESEND_API_KEY = "test-key-a-stub-answers";
process.env.EMAIL_FROM = "Sawa Tours <test@example.com>";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skip = !URL && "set TEST_DATABASE_URL to a disposable Postgres to run";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = (f) => readFileSync(join(ROOT, "server", "db", f), "utf8");
let pool, email;

before(async () => {
  if (skip) return;
  ({ pool } = await import("./db/index.js"));
  email = await import("./email.js");
  await pool.query("DROP TABLE IF EXISTS email_log");
  // The table as production has it (003), then the migration under test (042).
  await pool.query(sql("schema_003_ops.sql").split("CREATE TABLE IF NOT EXISTS audit_log")[0]);
  await pool.query(sql("schema_042_email_outbox.sql"));
});
after(async () => { if (!skip) { await pool.query("DROP TABLE IF EXISTS email_log"); await pool.end(); } });

const realFetch = globalThis.fetch;
const stub = (impl) => { globalThis.fetch = impl; };
const restore = () => { globalThis.fetch = realFetch; };
const row = async (id) => (await pool.query("SELECT * FROM email_log WHERE id=$1", [id])).rows[0];
const lastId = async () => (await pool.query("SELECT max(id) AS id FROM email_log")).rows[0].id;

test("a failed send is kept, with its content, and scheduled for retry", { skip }, async () => {
  stub(async () => { throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }); });
  try {
    const r = await email.sendEmail({ to: "t@example.com", subject: "Your booking", html: "<p>hi</p>", text: "hi", kind: "booking" });
    assert.deepEqual(r, { ok: false, mode: "live" });
  } finally { restore(); }
  const e = await row(await lastId());
  assert.equal(e.status, "failed");
  assert.equal(e.attempts, 1);
  assert.equal(e.html, "<p>hi</p>");
  const gap = new Date(e.next_attempt_at) - new Date(e.updated_at);
  assert.ok(Math.abs(gap - email.RETRY_GAPS_MS[0]) < 5000, `first retry ~5 min out, was ${gap} ms`);
});

test("the retry job re-sends it under the same idempotency key, and marks it sent", { skip }, async () => {
  const id = await lastId();
  await pool.query("UPDATE email_log SET next_attempt_at = now() - interval '1 second' WHERE id=$1", [id]);
  const keys = [];
  const res = await email.retryPendingEmails({ fetchImpl: async (_u, init) => { keys.push(init.headers["Idempotency-Key"]); return { ok: true, text: async () => "" }; } });
  assert.deepEqual(res, { claimed: 1, sent: 1, failed: 0 });
  assert.deepEqual(keys, [`sawa-email-${id}`]);
  const e = await row(id);
  assert.equal(e.status, "sent");
  assert.equal(e.attempts, 2);
  assert.equal(e.next_attempt_at, null);
});

test("a send a restart left 'pending' is picked up; a fresh one is not", { skip }, async () => {
  await pool.query(`INSERT INTO email_log (recipient, subject, kind, status, html, attempts, updated_at)
                    VALUES ('a@x.com','stale','k','pending','<p>s</p>',1, now() - interval '20 minutes'),
                           ('b@x.com','fresh','k','pending','<p>f</p>',1, now())`);
  const sentTo = [];
  const res = await email.retryPendingEmails({ fetchImpl: async (_u, init) => { sentTo.push(JSON.parse(init.body).to); return { ok: true, text: async () => "" }; } });
  assert.deepEqual(sentTo, ["a@x.com"], "the fresh one may still be in flight in this process");
  assert.equal(res.claimed, 1);
});

test("it stops after MAX_ATTEMPTS, and backs off between attempts", { skip }, async () => {
  const { rows: [{ id }] } = await pool.query(
    `INSERT INTO email_log (recipient, subject, kind, status, html, attempts, next_attempt_at, updated_at)
     VALUES ('c@x.com','x','k','failed','<p>x</p>', $1 - 1, now() - interval '1 second', now()) RETURNING id`, [email.MAX_ATTEMPTS]);
  const fail = async () => ({ ok: false, text: async () => "upstream 503" });
  await email.retryPendingEmails({ fetchImpl: fail });
  const e = await row(id);
  assert.equal(e.attempts, email.MAX_ATTEMPTS);
  assert.equal(e.status, "failed");
  assert.equal(e.next_attempt_at, null, "no further attempt is scheduled");
  const again = await email.retryPendingEmails({ fetchImpl: fail });
  assert.equal(again.claimed, 0);
});

test("two workers never take the same row", { skip }, async () => {
  await pool.query("DELETE FROM email_log");
  await pool.query(`INSERT INTO email_log (recipient, subject, kind, status, html, attempts, next_attempt_at, updated_at)
                    SELECT 'd'||g||'@x.com','x','k','failed','<p>x</p>',1, now() - interval '1 second', now() FROM generate_series(1,10) g`);
  const seen = [];
  const slowOk = async (_u, init) => { seen.push(JSON.parse(init.body).to); await new Promise((r) => setTimeout(r, 20)); return { ok: true, text: async () => "" }; };
  const [a, b] = await Promise.all([
    email.retryPendingEmails({ fetchImpl: slowOk, limit: 10 }),
    email.retryPendingEmails({ fetchImpl: slowOk, limit: 10 }),
  ]);
  assert.equal(a.claimed + b.claimed, 10);
  assert.equal(new Set(seen).size, seen.length, "an email was sent twice");
});

test("before migration 042: sends still go out once, and the job stands down", { skip }, async () => {
  await pool.query("DROP TABLE email_log");
  await pool.query(sql("schema_003_ops.sql").split("CREATE TABLE IF NOT EXISTS audit_log")[0]);
  stub(async () => ({ ok: true, text: async () => "" }));
  try {
    const r = await email.sendEmail({ to: "e@example.com", subject: "s", text: "t", kind: "k" });
    assert.deepEqual(r, { ok: true, mode: "live" });
  } finally { restore(); }
  const { rows } = await pool.query("SELECT status FROM email_log");
  assert.deepEqual(rows.map((r) => r.status), ["sent"], "the old log-only row is written");
  assert.deepEqual(await email.retryPendingEmails({ fetchImpl: async () => { throw new Error("must not send"); } }), { skipped: "migration 042 not applied" });
});
