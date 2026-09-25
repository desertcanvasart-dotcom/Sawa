// O02 — the booking rules end to end: the real migrations on an empty
// Postgres, the real server as a separate process, driven over HTTP the way a
// browser drives it. Runs when TEST_DATABASE_URL is set (see test-db.js) — in
// CI against a Postgres service container — and skips otherwise.
//
// The audit's point was that every unit test stayed green while the booking
// flow itself was broken (anyone could cancel anyone, a GoAhead date reverted
// to Forming, a closed date took bookings). These are those invariants,
// asserted against the running system.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_booking_flow";
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, dbUrl;

// Calendar days in Cairo, which is what departure dates mean (server/tz.js).
const cairoDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" })
  .format(new Date(Date.now() + offsetDays * 86400000));

const TOUR = "tour_it_flow";
const DEP = { open: 900001, race: 900002, closed: 900003, goahead: 900004 };

before(async () => {
  if (skip) return;
  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });

  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  // One day tour: GoAhead at 4, 12 seats, 24-hour cutoff; a second listing
  // with a 72-hour cutoff for a date that is therefore already closed.
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Integration Tour','Cairo',4,12,80,64,'approved',true,24),
                         ($1||'_late','day_tour','Late Tour','Cairo',4,12,80,64,'approved',true,72)`, [TOUR]);
  const dep = (id, product, day) => db.query(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES ($1,'day_tour',$2,'Integration Tour',$3,'08:00','Cairo',4,12,80,64,'open')`, [id, product, day]);
  await dep(DEP.open, TOUR, cairoDay(10));
  await dep(DEP.race, TOUR, cairoDay(11));
  await dep(DEP.closed, `${TOUR}_late`, cairoDay(2));
  await dep(DEP.goahead, TOUR, cairoDay(12));

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
const book = (depId, seats = 1, who = "a") =>
  post(`/public/departures/${depId}/bookings`, { customerName: `Traveller ${who}`, customerEmail: `${who}@example.com`, seats });
const bootstrapDep = async (id) => (await (await fetch(`${BASE}/bootstrap`)).json()).departures.find((d) => d.id === id);
const liveSeats = async (id) => Number((await db.query(
  "SELECT COALESCE(sum(seats),0) AS n FROM pledges WHERE departure_id=$1 AND status <> 'cancelled'", [id])).rows[0].n);

test("a traveller books; the public catalogue shows the seats but no booking handles", { skip }, async () => {
  const r = await book(DEP.open, 2, "first");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.booking.bookingCode, /^SAWA-[A-Z0-9]{8}$/);
  const d = await bootstrapDep(DEP.open);
  assert.equal(d.pledges.reduce((s, p) => s + p.seats, 0), 2);
  for (const p of d.pledges) assert.deepEqual(Object.keys(p).sort(), ["seats", "status"], "S02: no id, agency or timestamp");
  assert.ok(!("baseCost" in d) && !("notes" in d), "S03: no internal fields");
  assert.ok(Date.parse(d.bookingClosesAt) > Date.now(), "F05: the cutoff is published");
});

test("thirteen travellers race for twelve seats: exactly twelve get one", { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 13 }, (_, i) => book(DEP.race, 1, `race${i}`)));
  const codes = results.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 201).length, 12, `statuses: ${codes}`);
  assert.equal(codes.filter((c) => c === 409).length, 1);
  assert.equal(await liveSeats(DEP.race), 12, "never over capacity");
});

test("a date past its cutoff refuses bookings", { skip }, async () => {
  const r = await book(DEP.closed, 1, "late");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed/i);
  assert.equal(await liveSeats(DEP.closed), 0);
});

test("cancelling needs the booking code; the id-only route is gone", { skip }, async () => {
  const r = await book(DEP.open, 1, "cancel");
  assert.equal(r.status, 201);
  const gone = await fetch(`${BASE}/public/departures/${DEP.open}/bookings/${r.body.booking.id}`, { method: "DELETE" });
  assert.equal(gone.status, 404, "S02: the pledge id alone cancels nothing");
  assert.equal(await liveSeats(DEP.open), 3);
  const c = await post(`/public/bookings/${encodeURIComponent(r.body.booking.bookingCode)}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(await liveSeats(DEP.open), 2, "the seat is released");
  const row = (await db.query("SELECT status FROM pledges WHERE id=$1", [r.body.booking.id])).rows[0];
  assert.equal(row.status, "cancelled", "kept, marked cancelled — not erased");
});

test("a date that reached GoAhead stays confirmed after dropping below it", { skip }, async () => {
  const a = await book(DEP.goahead, 2, "ga1");
  const b = await book(DEP.goahead, 1, "ga2");
  const c = await book(DEP.goahead, 1, "ga3");
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(c.status, 201);
  assert.equal((await bootstrapDep(DEP.goahead)).status, "minimum_reached");
  // Sawa cancels one booking after GoAhead (the Terms' schedule, handled by
  // staff): 4 -> 3 seats. The date must still read confirmed...
  await db.query("UPDATE pledges SET status='cancelled' WHERE id=$1", [c.body.booking.id]);
  assert.equal(await liveSeats(DEP.goahead), 3);
  assert.equal((await bootstrapDep(DEP.goahead)).status, "minimum_reached", "the stored GoAhead survives");
  const view = await (await fetch(`${BASE}/public/bookings/${encodeURIComponent(b.body.booking.bookingCode)}`)).json();
  assert.equal(view.booking?.state ?? view.state, "confirmed", "F04: not back to Forming");
  // ...and a traveller on it still can't walk out for free.
  const cancel = await post(`/public/bookings/${encodeURIComponent(b.body.booking.bookingCode)}/cancel`);
  assert.equal(cancel.status, 409, "F04: after GoAhead the Terms' schedule applies");
  assert.equal(await liveSeats(DEP.goahead), 3);
});

test("a date request can't be bigger than the tour", { skip }, async () => {
  const r = await post("/public/departure-requests", {
    tourProductId: TOUR, date: cairoDay(20), customerName: "Big Group", customerEmail: "big@example.com", seats: 13, ignoreMatches: true,
  });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /up to 12/);
  const n = Number((await db.query("SELECT count(*) AS n FROM departures WHERE tour_product_id=$1 AND status='pending_review'", [TOUR])).rows[0].n);
  assert.equal(n, 0, "F02: nothing half-created");
});
