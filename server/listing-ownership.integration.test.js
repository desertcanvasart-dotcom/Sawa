// Security: an agency may edit only listings its own agency owns
// (docs/security/agency-listing-takeover.md).
//
// POST /api/agency/tour-products with the id of a Sawa-owned listing (no
// agency) used to pass the ownership check, overwrite the listing, take it
// offline as "pending", and set its agency to the caller's. These tests run the
// real server against a real Postgres. Skips without TEST_DATABASE_URL.
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
const DB_NAME = "sawa_it_listing_ownership";
const USERS = {
  "agency-a": { id: "00000000-0000-4000-8000-000000000061", email: "owner@agency-a.test", role: "agency_owner", agency: "ag_a" },
  "agency-a-agent": { id: "00000000-0000-4000-8000-000000000062", email: "agent@agency-a.test", role: "agency_agent", agency: "ag_a" },
  "agency-b": { id: "00000000-0000-4000-8000-000000000063", email: "owner@agency-b.test", role: "agency_owner", agency: "ag_b" },
};
const SAWA_LISTING = "tour_sawa_owned_giza";
const B_LISTING = "tour_agency_b_luxor";
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
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_a', 'Agency A'), ('ag_b', 'Agency B')");
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency]);
  }
  const listing = (id, title, agencyId) => db.query(
    `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                booking_cutoff_hours, included, not_included, agency_id)
     VALUES ($1,'day_tour',$2,'Cairo','08:00',4,12,100,80,'approved',true,24,'["Guide"]','["Tips"]',$3)`, [id, title, agencyId]);
  await listing(SAWA_LISTING, "Giza Pyramids with Sawa", null);
  await listing(B_LISTING, "Luxor West Bank by Agency B", "ag_b");

  const port = 21000 + Math.floor(Math.random() * 900);
  proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
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

const submit = (token, body) => fetch(`${base}/api/agency/tour-products`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const row = async (id) => (await db.query("SELECT title, status, active, agency_id, description FROM tour_products WHERE id = $1", [id])).rows[0];

test("an agency can't take over a Sawa-owned listing by posting its id", { skip }, async () => {
  const before = await row(SAWA_LISTING);
  for (const token of ["agency-a", "agency-a-agent"]) {
    const r = await submit(token, { id: SAWA_LISTING, type: "day_tour", title: "Hijacked", description: "not Sawa's any more", publishedRate: 1 });
    assert.equal(r.status, 403, `${token}: ${await r.text()}`);
  }
  assert.deepEqual(await row(SAWA_LISTING), before, "the listing is untouched: title, status, owner");
});

test("an agency can't edit another agency's listing", { skip }, async () => {
  const before = await row(B_LISTING);
  const r = await submit("agency-a", { id: B_LISTING, type: "day_tour", title: "Hijacked" });
  assert.equal(r.status, 403);
  assert.deepEqual(await row(B_LISTING), before);
});

test("an agency still creates its own listings and edits them", { skip }, async () => {
  const created = await submit("agency-a", { type: "day_tour", title: "Agency A Sunset Felucca", publishedRate: 60 });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const { product } = JSON.parse(createdBody);
  assert.equal((await row(product.id)).agency_id, "ag_a");
  const edited = await submit("agency-a-agent", { id: product.id, type: "day_tour", title: "Agency A Sunset Felucca, 2 hours", publishedRate: 60 });
  assert.equal(edited.status, 201, await edited.text());
  assert.equal((await row(product.id)).title, "Agency A Sunset Felucca, 2 hours");
  // Agency B edits its own.
  const own = await submit("agency-b", { id: B_LISTING, type: "day_tour", title: "Luxor West Bank, revised", publishedRate: 90 });
  assert.equal(own.status, 201, await own.text());
});

test("an id that doesn't exist is not created under the caller's name", { skip }, async () => {
  const r = await submit("agency-a", { id: "tour_made_up_id", type: "day_tour", title: "Invented" });
  assert.equal(r.status, 404);
  assert.equal(await row("tour_made_up_id"), undefined);
});
