// 29 Sep 2026, LIVE: the maximum group is 8 travelers. Migration 062 lowers
// every live tour to 8 without touching a booking; a party larger than 8 is not
// booked but asks for a special arrangement.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_groups_of_eight";
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, dbUrl;
const MIGRATION = readFileSync(join(ROOT, "server", "db", "schema_062_groups_of_eight.sql"), "utf8");
const cairoDay = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(Date.now() + n * 86400000));
const TOUR = "tour_it_g8";
const D = { small: 910001, packed: 910002, open: 910003 };

before(async () => {
  if (skip) return;
  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  // The state of production before the migration: a tour and its dates at 12,
  // a price grid running to 12, and one date that already holds 10 travelers.
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, price_tiers)
     VALUES ($1,'day_tour','Old Twelve','Cairo',4,12,100,60,'approved',true,
       '[{"seats":4,"price":100},{"seats":8,"price":80},{"seats":12,"price":60}]'::jsonb)`, [TOUR]);
  const dep = (id, day, max) => db.query(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES ($1,'day_tour',$2,'Old Twelve',$3,'08:00','Cairo',4,$4,100,60,'open')`, [id, TOUR, day, max]);
  await dep(D.small, cairoDay(10), 12);
  await dep(D.packed, cairoDay(11), 12);
  await dep(D.open, cairoDay(12), 8);
  await db.query(`INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, status)
     VALUES ('p_g8_a', $1, 'direct_customer', 'Direct traveler', 6, 'A', 'confirmed'), ('p_g8_b', $1, 'direct_customer', 'Direct traveler', 4, 'B', 'confirmed'),
            ('p_g8_c', $2, 'direct_customer', 'Direct traveler', 3, 'C', 'confirmed')`, [D.packed, D.small]);
  await db.query(MIGRATION); // the runner applied it to an empty database; this is the run that matters

  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(PORT), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: "https://placeholder.supabase.co", SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d; });
  server.stderr.on("data", (d) => { out += d; });
  let lastError = "no response";
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/bootstrap`);
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
  server?.kill();
  await db?.end();
  await dropDatabase(DB_NAME);
});

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

test("live tours are capped at 8; a price grid keeps sizes 4 to 8 only", { skip }, async () => {
  assert.equal((await one("SELECT max_seats FROM tour_products WHERE id=$1", [TOUR])).max_seats, 8);
  assert.equal((await one("SELECT max_seats FROM departures WHERE id=$1", [D.small])).max_seats, 8);
  const tiers = (await one("SELECT price_tiers FROM tour_products WHERE id=$1", [TOUR])).price_tiers;
  assert.deepEqual(tiers, [{ seats: 4, price: 100 }, { seats: 8, price: 80 }], "the size-12 row is gone; the others keep their prices");
});

test("bookings over 8 are unchanged: the date holding 10 keeps its cap and every pledge", { skip }, async () => {
  assert.equal((await one("SELECT max_seats FROM departures WHERE id=$1", [D.packed])).max_seats, 10, "as large as it is: full, for a person to handle");
  const seats = (await db.query("SELECT id, seats, status FROM pledges WHERE departure_id=$1 ORDER BY id", [D.packed])).rows;
  assert.deepEqual(seats.map((p) => [p.id, p.seats, p.status]), [["p_g8_a", 6, "confirmed"], ["p_g8_b", 4, "confirmed"]]);
  const r = await post(`/public/departures/${D.packed}/bookings`, { customerName: "Late One", customerEmail: "late@example.com", seats: 1 });
  assert.equal(r.status, 409, "and it takes nothing more");
  assert.equal((await one("SELECT count(*)::int AS n FROM pledges WHERE departure_id=$1", [D.packed])).n, 2, "no booking was added or removed");
});

test("the migration is safe to run twice", { skip }, async () => {
  const pledges = (await one("SELECT count(*)::int AS n FROM pledges")).n;
  const caps = (await db.query("SELECT id, max_seats FROM departures ORDER BY id")).rows;
  await db.query(MIGRATION);
  assert.equal((await one("SELECT max_seats FROM tour_products WHERE id=$1", [TOUR])).max_seats, 8);
  assert.equal((await one("SELECT count(*)::int AS n FROM pledges")).n, pledges);
  assert.deepEqual((await db.query("SELECT id, max_seats FROM departures ORDER BY id")).rows, caps, "a second run changes nothing");
});

test("a party of 9 can't book a date of 8", { skip }, async () => {
  const r = await post(`/public/departures/${D.open}/bookings`, { customerName: "Nine", customerEmail: "nine@example.com", seats: 9 });
  assert.equal(r.status, 409);
  assert.equal((await one("SELECT count(*)::int AS n FROM pledges WHERE departure_id=$1", [D.open])).n, 0, "nothing was booked");
  assert.equal((await post(`/public/departures/${D.open}/bookings`, { customerName: "Eight", customerEmail: "eight@example.com", seats: 8 })).status, 201);
});

test("a tour can't be saved above 8", { skip }, async () => {
  const r = await fetch(`${BASE}/admin/tour-products`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Too Big", minSeats: 4, maxSeats: 12 }) });
  assert.ok([401, 403].includes(r.status), "the admin route needs a session; the rule itself is capacityError, tested in domain.test.js");
});

test("a party over 8 asks for a special arrangement: a lead, no booking", { skip }, async () => {
  const before = (await one("SELECT count(*)::int AS n FROM pledges")).n;
  const r = await post("/public/group-requests", { name: "Big Group", email: "big@example.com", groupSize: 12, date: cairoDay(30), productId: TOUR, note: "school trip" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = await one("SELECT * FROM group_requests WHERE email='big@example.com'");
  assert.deepEqual([row.name, row.group_size, row.product_id, row.product_title, row.status], ["Big Group", 12, TOUR, "Old Twelve", "new"]);
  assert.equal((await one("SELECT count(*)::int AS n FROM pledges")).n, before, "no booking is made");
  assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action='group_request.create'")).n, 1);
});

test("the special-arrangement form is only for groups above 8; a bot's honeypot is dropped", { skip }, async () => {
  assert.equal((await post("/public/group-requests", { name: "Small Group", email: "s@example.com", groupSize: 8 })).status, 422);
  assert.equal((await post("/public/group-requests", { name: "Bad", email: "not-an-email", groupSize: 12 })).status, 422);
  const bot = await post("/public/group-requests", { name: "Bot Bot", email: "bot@example.com", groupSize: 20, website: "http://spam" });
  assert.equal(bot.status, 202);
  assert.equal((await one("SELECT count(*)::int AS n FROM group_requests WHERE email='bot@example.com'")).n, 0);
});
