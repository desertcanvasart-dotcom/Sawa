// Agencies: "Linked" (what still points at an agency), Unassign, Deactivate,
// and "Not assigned" on a tour actually clearing its operating company.
// Runs the real server against a real Postgres. Skips without TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_agency_links";
const USERS = {
  admin: { id: "00000000-0000-4000-8000-000000000071", email: "admin@sawa.test", role: "super_admin", agency: null },
  owner: { id: "00000000-0000-4000-8000-000000000072", email: "owner@linked.test", role: "agency_owner", agency: "ag_linked" },
};
let db, dbUrl, fakeAuth, proc, base, out = "";

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
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_linked', 'Linked Travel'), ('ag_empty', 'Empty Travel')");
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency]);
  }
  const listing = (id, title, agencyId) => db.query(
    `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                booking_cutoff_hours, included, not_included, agency_id)
     VALUES ($1,'day_tour',$2,'Cairo','08:00',4,8,43,37,'approved',true,24,'["Guide"]','["Tips"]',$3)`, [id, title, agencyId]);
  await listing("tour_linked_a", "Giza with Linked", "ag_linked");
  await listing("tour_linked_b", "Saqqara with Linked", "ag_linked");
  await listing("tour_linked_c", "Memphis with Linked", "ag_linked");
  await db.query(`INSERT INTO departures (id, tour_product_id, route, date, city, published_rate) VALUES (9101, 'tour_linked_a', 'Giza with Linked', '2026-11-13', 'Cairo', 43)`);
  await db.query(`INSERT INTO pledges (id, departure_id, agency_id, agency, seats, booking_code, status) VALUES ('pl_linked_1', 9101, 'ag_linked', 'Linked Travel', 2, 'SAWA-LINK1', 'confirmed')`);

  const port = 21000 + Math.floor(Math.random() * 900);
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
const agencyOf = async (id) => (await db.query("SELECT agency_id FROM tour_products WHERE id=$1", [id])).rows[0].agency_id;
const tourBody = (id, extra = {}) => ({
  id, type: "day_tour", title: "Memphis with Linked", city: "Cairo", duration: "8 hours", minSeats: 4, maxSeats: 8,
  publishedRate: 43, breakPrice: 37, depositPercent: 10, bookingCutoffHours: 24, bookingCutoffUnit: "hours", ...extra,
});

test("Linked lists the agency's tours, bookings and used referral codes; the delete is refused", { skip }, async () => {
  const r = await call("admin", "GET", "/admin/agencies/ag_linked/links");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.tours.map((t) => t.id), ["tour_linked_a", "tour_linked_c", "tour_linked_b"]);
  assert.equal(r.body.bookings.length, 1);
  assert.equal(r.body.bookings[0].bookingCode, "SAWA-LINK1");
  assert.equal(r.body.bookings[0].date, "2026-11-13");
  assert.deepEqual(r.body.referralCodes, []);
  const del = await call("admin", "DELETE", "/admin/agencies/ag_linked");
  assert.equal(del.status, 409);
  assert.match(del.body.error, /3 tour product\(s\).*1 booking\(s\)/);
  assert.equal((await call("owner", "GET", "/admin/agencies/ag_linked/links")).status, 403, "admin only");
});

test("Unassign takes a tour off the agency and nothing else", { skip }, async () => {
  const r = await call("admin", "POST", "/admin/agencies/ag_linked/tours/tour_linked_b/unassign");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await agencyOf("tour_linked_b"), null);
  assert.equal(await agencyOf("tour_linked_a"), "ag_linked");
  // Not this agency's (any more): refused, unchanged.
  assert.equal((await call("admin", "POST", "/admin/agencies/ag_linked/tours/tour_linked_b/unassign")).status, 404);
  assert.equal((await call("admin", "POST", "/admin/agencies/ag_empty/tours/tour_linked_a/unassign")).status, 404);
  assert.equal(await agencyOf("tour_linked_a"), "ag_linked");
});

test('a tour save keeps the operator unless the admin chose "Not assigned"', { skip }, async () => {
  const keep = await call("admin", "POST", "/admin/tour-products", tourBody("tour_linked_c"));
  assert.equal(keep.status, 201, JSON.stringify(keep.body));
  assert.equal(await agencyOf("tour_linked_c"), "ag_linked", "no agencyId key: unchanged");
  const same = await call("admin", "POST", "/admin/tour-products", tourBody("tour_linked_c", { agencyId: "ag_linked" }));
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.equal(await agencyOf("tour_linked_c"), "ag_linked", "same company: unchanged");
  const cleared = await call("admin", "POST", "/admin/tour-products", tourBody("tour_linked_c", { agencyId: null }));
  assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
  assert.equal(await agencyOf("tour_linked_c"), null, '"Not assigned" clears it');
});

test("Deactivate signs the team out and keeps everything; Reactivate brings them back", { skip }, async () => {
  assert.equal((await call("owner", "GET", "/agency/tour-products")).status, 200);
  const off = await call("admin", "POST", "/admin/agencies/ag_linked/status", { status: "inactive" });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.agency.status, "inactive");
  assert.equal((await call("owner", "GET", "/agency/tour-products")).status, 401, "an inactive agency's team can't sign in");
  assert.equal(await agencyOf("tour_linked_a"), "ag_linked", "its tours stay");
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM pledges WHERE agency_id='ag_linked'")).rows[0].n, 1, "its bookings stay");
  const listed = (await call("admin", "GET", "/admin/agencies")).body.agencies.find((a) => a.id === "ag_linked");
  assert.equal(listed.status, "inactive");
  assert.equal(listed.operatorSelectable, false);
  assert.equal((await call("admin", "POST", "/admin/agencies/ag_linked/status", { status: "gone" })).status, 422);
  const on = await call("admin", "POST", "/admin/agencies/ag_linked/status", { status: "active" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal((await call("owner", "GET", "/agency/tour-products")).status, 200, "the same team is back");
  const audit = (await db.query("SELECT action FROM audit_log WHERE entity_id='ag_linked' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(audit.filter((a) => a.startsWith("agency.")), ["agency.deactivate", "agency.reactivate"]);
});

test("067 allows only active and inactive", { skip }, async () => {
  await assert.rejects(db.query("UPDATE agencies SET status='paused' WHERE id='ag_empty'"), /agencies_status_check/);
});
