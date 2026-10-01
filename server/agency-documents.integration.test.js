// 068 on a real Postgres: an agency sends its papers and bank details, an admin
// reviews them, an operator is activated by exception with the reason kept, the
// ETAA link, the agency preferred for direct bookings, and 068's one-time data
// changes (Capital Travel Service relisted and preferred; ETAA numbers moved to
// the license field). Skips without TEST_DATABASE_URL (see test-db.js).
//
// The tests share one database and run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { shiftDate } from "../shared/catalogue.js";
import { DOCUMENT_KINDS } from "../shared/operators.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_agency_documents";
const USERS = {
  admin: { id: "00000000-0000-4000-8000-000000000081", email: "admin@sawa.test", role: "super_admin", agency: null },
  owner: { id: "00000000-0000-4000-8000-000000000082", email: "owner@nile.test", role: "agency_owner", agency: "ag_nile" },
  agent: { id: "00000000-0000-4000-8000-000000000083", email: "agent@nile.test", role: "agency_agent", agency: "ag_nile" },
  other: { id: "00000000-0000-4000-8000-000000000084", email: "owner@other.test", role: "agency_owner", agency: "ag_other" },
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
let db, dbUrl, fakeAuth, proc, base, out = "", ops, domain;
const migrate = () => execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")],
  { env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });

before(async () => {
  if (skip) return;
  fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    if (!u) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));
  dbUrl = await freshDatabase(DB_NAME);
  migrate();
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_nile', 'Nile Star Travel'), ('ag_other', 'Other Travel')");
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency]);
  }
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  ops = await import("./operators.js");
  domain = await import("./domain.js");

  const port = 22000 + Math.floor(Math.random() * 900);
  proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  base = `http://127.0.0.1:${port}`;
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;   // not listening yet — reported below if it never is
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start (${lastError}):\n${out}`);
});

after(async () => {
  if (skip) return;
  if (process.env.SHOW_SERVER_LOG) console.log(out);
  proc?.kill();
  fakeAuth?.close();
  await db?.end();
  await dropDatabase(DB_NAME);
});

const call = async (token, method, path, body) => {
  const r = await fetch(`${base}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const inAYear = () => shiftDate(today(), 365);

test("an agency with no operator record sees its list; its first bank details create one, pending, for an admin", { skip }, async () => {
  const first = await call("owner", "GET", "/agency/documents");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.operator, null);
  assert.deepEqual(first.body.documentGaps.map((g) => g.kind), DOCUMENT_KINDS);
  assert.ok(!DOCUMENT_KINDS.includes("etaa_membership"), "no ETAA paper is asked for");

  const bank = { holderName: "Nile Star Travel", bankName: "CIB", iban: "EG380019000500000000263180002" };
  assert.equal((await call("agent", "POST", "/agency/bank", bank)).status, 403, "only the owner");
  const sent = await call("owner", "POST", "/agency/bank", bank);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.match(sent.body.account.iban, /^•••• /, "the agency gets it back masked");
  const op = (await db.query("SELECT * FROM operators WHERE agency_id = 'ag_nile'")).rows[0];
  assert.equal(op.legal_name, "Nile Star Travel");
  assert.equal(op.status, "pending");
  assert.equal((await call("agent", "GET", "/agency/bank")).body.accounts[0].state, "pending");
  const listed = (await call("admin", "GET", "/admin/operators")).body.operators.find((o) => o.agencyId === "ag_nile");
  assert.equal(listed.toReview, 1, "the bank change waits for an admin");
  // Another agency sees nothing of it.
  const other = await call("other", "GET", "/agency/documents");
  assert.equal(other.body.operator, null);
  assert.deepEqual((await call("other", "GET", "/agency/bank")).body.accounts, []);
});

test("a paper the agency sends waits for review; it counts only once approved; a rejection needs a reason", { skip }, async () => {
  const opId = Number((await db.query("SELECT id FROM operators WHERE agency_id = 'ag_nile'")).rows[0].id);
  const first = await ops.submitAgencyDocument(db, opId, { kind: "tax_card", number: "T-1", expiresOn: inAYear(), fileRef: "operator/x/tax_card/1.pdf" }, { by: "owner@nile.test" });
  assert.equal(first.reviewState, "pending");
  assert.equal(first.submittedVia, "agency");
  assert.deepEqual((await ops.currentDocuments(db, opId)).map((d) => d.kind), [], "a waiting paper doesn't count");
  // A second upload of the same kind replaces the one still waiting.
  const second = await ops.submitAgencyDocument(db, opId, { kind: "tax_card", number: "T-2", expiresOn: inAYear(), fileRef: "operator/x/tax_card/2.pdf" }, { by: "owner@nile.test" });
  const waiting = (await db.query("SELECT id FROM operator_documents WHERE operator_id = $1 AND review_state = 'pending' AND superseded_at IS NULL", [opId])).rows;
  assert.deepEqual(waiting.map((r) => Number(r.id)), [second.id]);
  await assert.rejects(ops.submitAgencyDocument(db, opId, { kind: "tax_card", expiresOn: inAYear(), fileRef: null }, { by: "o" }), /Attach the document/);

  await assert.rejects(ops.reviewDocument(db, opId, second.id, { approve: false, by: "admin" }), /Say why/);
  const rejected = await ops.reviewDocument(db, opId, second.id, { approve: false, note: "The scan is unreadable.", by: "admin" });
  assert.equal(rejected.document.reviewState, "rejected");
  await assert.rejects(ops.reviewDocument(db, opId, second.id, { approve: true, by: "admin" }), /waiting for review/);

  // The agency sees the reason, not who reviewed it.
  const seen = (await call("owner", "GET", "/agency/documents")).body;
  const tax = seen.documents.find((d) => d.id === second.id);
  assert.equal(tax.reviewState, "rejected");
  assert.equal(tax.reviewNote, "The scan is unreadable.");
  assert.equal(tax.reviewedBy, undefined);

  const third = await ops.submitAgencyDocument(db, opId, { kind: "tax_card", number: "T-3", expiresOn: inAYear(), fileRef: "operator/x/tax_card/3.pdf" }, { by: "owner@nile.test" });
  const approved = await call("admin", "POST", `/admin/operators/${opId}/documents/${third.id}/review`, { approve: true });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual((await ops.currentDocuments(db, opId)).map((d) => d.number), ["T-3"]);
  // An admin upload of the same kind supersedes it, as before.
  await ops.addDocument(db, opId, { kind: "tax_card", number: "T-4", expiresOn: inAYear() }, { by: "admin" });
  assert.deepEqual((await ops.currentDocuments(db, opId)).map((d) => d.number), ["T-4"]);
  // Its own file reaches storage (not configured in this test); another agency's is not found.
  const own = await call("owner", "GET", `/agency/documents/${third.id}/file`);
  assert.equal(own.status, 500, "found, and refused only for want of storage");
  assert.equal((await call("other", "GET", `/agency/documents/${third.id}/file`)).status, 404);
  const audit = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'operator.document.%' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(audit, ["operator.document.approve"]);
});

test("activation by exception: refused without a reason, recorded with it, ended by any other status", { skip }, async () => {
  const opId = Number((await db.query("SELECT id FROM operators WHERE agency_id = 'ag_nile'")).rows[0].id);
  await ops.addDocument(db, opId, { kind: "tourism_license", number: "L-1", expiresOn: inAYear() }, { by: "admin" });
  // Liability insurance on file but expired: a gap like the missing ones.
  await ops.addDocument(db, opId, { kind: "liability_insurance", number: "P-1", expiresOn: shiftDate(today(), -2) }, { by: "admin" });

  const plain = await call("admin", "POST", `/admin/operators/${opId}/status`, { status: "active" });
  assert.equal(plain.status, 422);
  assert.match(plain.body.error, /activate by exception/);
  assert.equal((await call("admin", "POST", `/admin/operators/${opId}/status`, { status: "active", exceptionReason: "soon" })).status, 422, "a real reason");

  const why = "Renewals filed with the Ministry; certificates expected next week.";
  const ok = await call("admin", "POST", `/admin/operators/${opId}/status`, { status: "active", exceptionReason: why });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const op = ok.body.operator;
  assert.equal(op.status, "active");
  assert.equal(op.activationException, why);
  assert.deepEqual(op.activationExceptionKinds.sort(), ["commercial_registration", "liability_insurance", "vehicle_insurance"]);
  assert.equal(op.activationExceptionBy, "admin@sawa.test");
  assert.match(op.statusReason, /^Activated by exception: /);

  // The daily check doesn't suspend it for a paper the exception covers.
  const job = await ops.runDocumentJob({ db });
  assert.equal(job.suspended, 0);
  assert.equal((await ops.getOperator(db, opId)).status, "active");

  const suspended = await ops.setOperatorStatus(db, opId, "suspended", { by: "admin", reason: "review" });
  assert.equal(suspended.activationException, null, "any other status ends the exception");
  assert.deepEqual(suspended.activationExceptionKinds, []);
});

test("the ETAA link: an https link on ETAA's site, set on purpose; clearing it clears the old number", { skip }, async () => {
  const bad = await call("admin", "PATCH", "/admin/agencies/ag_nile", { relationship: "operator", tourismLicenseNo: "1234", etaaUrl: "https://example.com/x" });
  assert.equal(bad.status, 422);
  const url = "https://www.etaa-egypt.org/SitePages/CompanyDetails.aspx?licc=1234";
  const set = await call("admin", "PATCH", "/admin/agencies/ag_nile", { relationship: "operator", tourismLicenseNo: "1234", etaaUrl: url });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.agency.etaaUrl, url);
  assert.equal(domain.publicOperator(set.body.agency).etaaUrl, url);
  // A save that doesn't send it leaves it alone.
  const kept = await call("admin", "PATCH", "/admin/agencies/ag_nile", { relationship: "operator", tourismLicenseNo: "1234" });
  assert.equal(kept.body.agency.etaaUrl, url);
  await db.query("UPDATE agencies SET etaa_registration_no = '1234' WHERE id = 'ag_nile'");
  const cleared = await call("admin", "PATCH", "/admin/agencies/ag_nile", { relationship: "operator", tourismLicenseNo: "1234", etaaUrl: null });
  assert.equal(cleared.body.agency.etaaUrl, null);
  assert.equal(cleared.body.agency.etaaRegistrationNo, null);
  assert.equal(domain.publicOperator(cleared.body.agency).etaaUrl, null, "no link, and no licence number, on the site");
});

test("preferred for direct bookings: one agency at a time, never an inactive one, and it is who direct bookings count for", { skip }, async () => {
  const a = await call("admin", "POST", "/admin/agencies/ag_nile/direct-bookings", { preferred: true });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.agency.directBookingsPreferred, true);
  const b = await call("admin", "POST", "/admin/agencies/ag_other/direct-bookings", { preferred: true });
  assert.equal(b.status, 200);
  const rows = (await db.query("SELECT id FROM agencies WHERE direct_bookings_preferred")).rows.map((r) => r.id);
  assert.deepEqual(rows, ["ag_other"], "choosing another moves it");
  const all = (await db.query("SELECT * FROM agencies")).rows;
  assert.equal(domain.directOperatorId(all, ""), "ag_other");
  assert.equal(domain.directOperatorId(all, "Nile Star Travel"), "ag_other", "the flag wins over the old setting");

  await call("admin", "POST", "/admin/agencies/ag_other/status", { status: "inactive" });
  assert.equal(domain.directOperatorId((await db.query("SELECT * FROM agencies")).rows, "Nile Star Travel"), "ag_nile",
    "a deactivated agency isn't it; the old setting applies again");
  assert.equal((await call("admin", "POST", "/admin/agencies/ag_other/direct-bookings", { preferred: true })).status, 409);
  await call("admin", "POST", "/admin/agencies/ag_other/status", { status: "active" });
  assert.equal((await call("owner", "POST", "/admin/agencies/ag_nile/direct-bookings", { preferred: true })).status, 403);
});

test("068's one-time data: CTS relisted, preferred and unblocked; ETAA numbers become the license and the link; a later migrate changes nothing", { skip }, async () => {
  await db.query("UPDATE agencies SET direct_bookings_preferred = false");
  await db.query(`INSERT INTO agencies (id, name, public_listed, etaa_registration_no) VALUES ('ag_cts', 'Capital Travel Service', false, '2179')`);
  await db.query(`INSERT INTO operators (agency_id, legal_name, etaa_no, activation_blocked)
                  VALUES ('ag_cts', 'Capital Travel Service', '2179', 'Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). This record must stay pending and must not be activated.')`);
  await db.query("DELETE FROM schema_migrations WHERE name = '068_agency_documents'");
  migrate();
  const cts = (await db.query("SELECT * FROM agencies WHERE id = 'ag_cts'")).rows[0];
  assert.equal(cts.public_listed, true, "back on /partners");
  assert.equal(cts.direct_bookings_preferred, true);
  assert.equal(cts.tourism_license_no, "2179");
  assert.equal(cts.etaa_url, "https://www.etaa-egypt.org/SitePages/CompanyDetails.aspx?licc=2179", "the link the site showed, kept");
  const op = (await db.query("SELECT * FROM operators WHERE agency_id = 'ag_cts'")).rows[0];
  assert.equal(op.activation_blocked, null);
  assert.equal(op.tourism_license_no, "2179");

  // An admin's later choices survive the next db:migrate.
  await db.query("UPDATE agencies SET public_listed = false, direct_bookings_preferred = false WHERE id = 'ag_cts'");
  migrate();
  const again = (await db.query("SELECT public_listed, direct_bookings_preferred FROM agencies WHERE id = 'ag_cts'")).rows[0];
  assert.deepEqual(again, { public_listed: false, direct_bookings_preferred: false });
  assert.equal((await db.query("SELECT activation_blocked FROM operators WHERE agency_id = 'ag_cts'")).rows[0].activation_blocked, null, "053 doesn't re-block it");
});
