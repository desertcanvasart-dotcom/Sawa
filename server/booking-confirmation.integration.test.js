// Stopping fake bookings (migration 058; live, legacy and catalog departures
// alike), on a real Postgres and a real server:
//
//   hold        a direct booking is held until its email is confirmed: it
//               counts towards nothing (GoAhead, the public seat count) and
//               isn't a booking the operator can see; the booking page says
//               "Check your email" and can resend the link, at most 3 times
//   confirm     the link makes the booking, through the same checks; twice
//               is once; a date that filled up meanwhile is refused
//   expiry      unconfirmed after 24 hours it expires, with no email
//   agency      an agency's booking counts at once
//   rate limit  5 booking attempts an hour from one address
//   Turnstile   a failed check refuses the booking; no secret key skips it
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_booking_confirmation";
const TOUR = "tour_it_confirm";
const DEP = { a: 910001, b: 910002, c: 910003, d: 910004, e: 910005 };
const HOUR = 3600000;
const USERS = {
  "ag-token": { id: "00000000-0000-4000-8000-0000000000a1", email: "owner@agency.test", role: "agency_owner", agency: "ag_it_confirm" },
};

let db, dbUrl, fakeAuth, fakeTurnstile, servers = [];
let conf;
let main, limited, open;
const turnstileCalls = [];
const cairoDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(Date.now() + d * 86400000));
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const json = { "Content-Type": "application/json" };
const sha = (t) => createHash("sha256").update(t).digest("hex");

async function listen(handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}

async function startServer(extraEnv) {
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "", TURNSTILE_SECRET_KEY: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(proc);
  proc.out = "";
  proc.stdout.on("data", (d) => { proc.out += d; });
  proc.stderr.on("data", (d) => { proc.out += d; });
  const base = `http://127.0.0.1:${port}`;
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { base, proc };
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;   // not listening yet — reported below if it never is
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start (${lastError}):\n${proc.out}`);
}

before(async () => {
  if (skip) return;
  fakeAuth = await listen((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    if (!u) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated" }));
  });
  // Cloudflare's siteverify, stood in for: "good" passes, anything else fails.
  fakeTurnstile = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const f = new URLSearchParams(body);
      turnstileCalls.push({ secret: f.get("secret"), response: f.get("response") });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(f.get("response") === "good" ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }));
    });
  });

  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Confirm Tour','Cairo',4,12,80,64,'approved',true,24)`, [TOUR]);
  for (const [i, id] of Object.values(DEP).entries()) {
    await db.query(
      `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
       VALUES ($1,'day_tour',$2,'Confirm Tour',$3,'08:00','Cairo',4,12,80,64,'open')`, [id, TOUR, cairoDay(10 + i)]);
  }
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_it_confirm', 'Agency Confirm')");
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency || null]);
  }
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  conf = await import("./booking-confirmation.js");

  const verify = `http://127.0.0.1:${fakeTurnstile.address().port}/siteverify`;
  main = await startServer({ BOOKING_EMAIL_CONFIRMATION: "on", TURNSTILE_SECRET_KEY: "secret-x", TURNSTILE_SITE_KEY: "site-x", TURNSTILE_VERIFY_URL: verify });
  limited = await startServer({ BOOKING_EMAIL_CONFIRMATION: "on", BOOKING_RATE_LIMIT_PER_HOUR: "5" });
  open = await startServer({ BOOKING_EMAIL_CONFIRMATION: "on" });
});

after(async () => {
  if (skip) return;
  for (const s of servers) s.kill();
  fakeAuth?.close();
  fakeTurnstile?.close();
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

let seq = 0;
async function book(server, depId, seats, { token = "good", email = null } = {}) {
  seq += 1;
  const r = await fetch(`${server.base}/api/public/departures/${depId}/bookings`, {
    method: "POST", headers: json,
    body: JSON.stringify({ customerName: `Traveler ${seq}`, customerEmail: email || `t${seq}@example.test`, seats, ...(token ? { turnstileToken: token } : {}) }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, code: body.booking?.bookingCode };
}
const post = (server, path, body = {}) => fetch(`${server.base}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (server, path) => fetch(`${server.base}${path}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
// The link's token is only in the email; the test gives the held booking a
// known one (the table stores its hash).
async function linkFor(code) {
  const t = `tok-${code}`;
  await db.query("UPDATE booking_confirmations SET token_hash = $2 WHERE booking_code = $1", [code, sha(t)]);
  return t;
}
const liveSeats = async (depId) => Number((await one("SELECT COALESCE(SUM(seats), 0) AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [depId])).n);
const depStatus = async (depId) => (await one("SELECT status FROM departures WHERE id = $1", [depId])).status;
const publicDep = async (server, depId) => (await get(server, "/api/bootstrap")).body.departures.find((d) => Number(d.id) === depId);

test("an unconfirmed booking counts towards nothing and isn't shown; the booking page asks for the email confirmation", { skip }, async () => {
  const b = await book(main, DEP.a, 4);
  assert.equal(b.status, 202, JSON.stringify(b.body));
  assert.equal(b.body.confirmationRequired, true);
  assert.equal(b.body.booking.status, "unconfirmed");
  assert.match(b.code, /\S+/);

  assert.equal(await liveSeats(DEP.a), 0, "not a booking yet: no pledge, so no operator manifest, no seat count");
  assert.equal(await depStatus(DEP.a), "open", "four seats held, the minimum, but no GoAhead");
  const dep = await publicDep(main, DEP.a);
  assert.equal((dep.pledges || []).reduce((s, p) => s + Number(p.seats || 0), 0), 0, "the public seat count doesn't include it");
  const held = await one("SELECT * FROM booking_confirmations WHERE booking_code = $1", [b.code]);
  assert.deepEqual([held.status, held.seats, held.email], ["unconfirmed", 4, "t1@example.test"]);
  assert.ok(!JSON.stringify(held).includes("tok-"), "the link's token is stored hashed");
  const mail = await one("SELECT * FROM email_log WHERE kind = 'booking_confirm' ORDER BY id DESC LIMIT 1");
  assert.equal(mail.recipient, "t1@example.test");
  assert.match(mail.subject, /^Confirm your booking/);
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'booking.hold' AND entity_id = $1", [b.code]));

  const page = await get(main, `/api/public/bookings/${b.code}`);
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.booking.state, page.body.booking.confirmation.state, page.body.booking.confirmation.resendsLeft],
    ["held_unconfirmed", "unconfirmed", 3]);
  assert.match(page.body.booking.note, /Check your email to confirm your booking/);
  globalThis.heldA = b.code;
});

test("confirming makes the booking, through the same checks: it counts, reaches GoAhead, and a second click is the same booking", { skip }, async () => {
  const code = globalThis.heldA;
  const link = await linkFor(code);
  const c = await post(main, `/api/public/booking-confirmations/${link}`);
  assert.deepEqual([c.status, c.body.state, c.body.code], [200, "confirmed", code]);
  const p = await one("SELECT * FROM pledges WHERE booking_code = $1", [code]);
  assert.ok(p, "the booking is made, with the code the traveler already has");
  assert.deepEqual([p.seats, p.source, p.customer_email, p.status], [4, "public", "t1@example.test", "confirmed"]);
  assert.equal(await liveSeats(DEP.a), 4);
  assert.equal(await depStatus(DEP.a), "minimum_reached", "the confirmed seats reach GoAhead");
  assert.equal((await one("SELECT status, pledge_id FROM booking_confirmations WHERE booking_code = $1", [code])).pledge_id, p.id);
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'booking.email_confirmed' AND entity_id = $1", [p.id]));
  assert.ok(await one("SELECT 1 FROM email_log WHERE recipient = 't1@example.test' AND kind <> 'booking_confirm'"), "the booking's own confirmation email follows");

  const again = await post(main, `/api/public/booking-confirmations/${link}`);
  assert.deepEqual([again.status, again.body.state], [200, "already"]);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM pledges WHERE booking_code = $1", [code])).n), 1, "one booking, however many clicks");
  const page = await get(main, `/api/public/bookings/${code}`);
  assert.equal(page.body.booking.confirmation, undefined, "the booking page shows the ordinary booking now");
  assert.equal((await post(main, "/api/public/booking-confirmations/not-a-link")).status, 404);
});

test("a date that filled up while the booking waited is refused at confirmation; nothing is booked", { skip }, async () => {
  const b = await book(main, DEP.b, 3);
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, status, source) VALUES ('pl_it_fill', $1, 'ag_it_confirm', 'Agency Confirm', 11, 'Filler', 'confirmed', 'agency')`,
    [DEP.b]);
  const c = await post(main, `/api/public/booking-confirmations/${await linkFor(b.code)}`);
  assert.equal(c.status, 409);
  assert.equal(c.body.state, "refused");
  assert.match(c.body.error, /exceeds the remaining seats.*Nothing was charged/);
  assert.equal(await one("SELECT 1 FROM pledges WHERE booking_code = $1", [b.code]), undefined);
  assert.equal((await one("SELECT status FROM booking_confirmations WHERE booking_code = $1", [b.code])).status, "refused");
});

test("unconfirmed after 24 hours, a booking expires with no email; the link then says so", { skip }, async () => {
  const b = await book(main, DEP.c, 2);
  const link = await linkFor(b.code);
  // Emails go in the background: wait for this booking's own before counting.
  for (let i = 0; i < 50 && !(await one("SELECT 1 FROM email_log WHERE recipient = $1", [`t${seq}@example.test`])); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const mails = Number((await one("SELECT COUNT(*) AS n FROM email_log")).n);
  assert.deepEqual(await conf.expireUnconfirmed({ now: Date.now() + 23 * HOUR }), { expired: 0, purged: 0 });
  const out = await conf.expireUnconfirmed({ now: Date.now() + 24 * HOUR + 60000 });
  assert.equal(out.expired, 1);
  assert.equal((await one("SELECT status FROM booking_confirmations WHERE booking_code = $1", [b.code])).status, "expired");
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM email_log")).n), mails, "no email");
  const c = await post(main, `/api/public/booking-confirmations/${link}`);
  assert.deepEqual([c.status, c.body.state], [200, "expired"]);
  assert.equal(await liveSeats(DEP.c), 0);
  const page = await get(main, `/api/public/bookings/${b.code}`);
  assert.equal(page.body.booking.state, "held_expired");
  assert.match(page.body.booking.note, /wasn't confirmed within 24 hours/);

  // 30 days on, a booking that never became one is deleted with its details.
  const purged = await conf.expireUnconfirmed({ now: Date.now() + 31 * 24 * HOUR });
  assert.ok(purged.purged >= 2, JSON.stringify(purged));
  assert.equal(await one("SELECT 1 FROM booking_confirmations WHERE booking_code = $1", [b.code]), undefined);
  assert.ok(await one("SELECT 1 FROM booking_confirmations WHERE status = 'confirmed'"), "a confirmed one stays (its booking is in pledges)");

  // Past 24 hours the link is refused even before the job has run.
  const late = await book(main, DEP.c, 1);
  await db.query("UPDATE booking_confirmations SET expires_at = now() - interval '1 minute' WHERE booking_code = $1", [late.code]);
  assert.equal((await post(main, `/api/public/booking-confirmations/${await linkFor(late.code)}`)).body.state, "expired");
  assert.equal(await one("SELECT 1 FROM pledges WHERE booking_code = $1", [late.code]), undefined);
});

test("the booking page resends the link at most 3 times; each resend replaces the link; the traveler can cancel", { skip }, async () => {
  const b = await book(main, DEP.d, 1);
  const first = await linkFor(b.code);
  for (let i = 3; i >= 1; i--) {
    const r = await post(main, `/api/public/bookings/${b.code}/resend-confirmation`);
    assert.deepEqual([r.status, r.body.resendsLeft], [200, i - 1]);
  }
  const fourth = await post(main, `/api/public/bookings/${b.code}/resend-confirmation`);
  assert.equal(fourth.status, 429);
  assert.match(fourth.body.error, /3 times/);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'booking_confirm' AND recipient = $1", [`t${seq}@example.test`])).n), 4);
  assert.equal((await post(main, `/api/public/booking-confirmations/${first}`)).status, 404, "the first link was replaced");

  const cancel = await post(main, `/api/public/bookings/${b.code}/cancel`);
  assert.deepEqual([cancel.status, cancel.body.cancelled], [200, true]);
  assert.equal((await get(main, `/api/public/bookings/${b.code}`)).body.booking.state, "held_cancelled");
});

test("an agency's booking counts at once", { skip }, async () => {
  const r = await fetch(`${main.base}/api/departures/${DEP.e}/pledges`, {
    method: "POST", headers: { ...json, Authorization: "Bearer ag-token" }, body: JSON.stringify({ seats: 4, customers: "Agency group" }),
  });
  assert.equal(r.status, 201, await r.text());
  assert.equal(await liveSeats(DEP.e), 4);
  assert.equal(await depStatus(DEP.e), "minimum_reached");
  assert.equal(await one("SELECT 1 FROM booking_confirmations WHERE departure_id = $1", [DEP.e]), undefined);
});

test("Turnstile: a failed or missing token refuses the booking; a passing one goes through; no secret key skips the check", { skip }, async () => {
  const before = await one("SELECT COUNT(*) AS n FROM booking_confirmations");
  const bad = await book(main, DEP.d, 1, { token: "bot" });
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /came from a person/);
  const none = await book(main, DEP.d, 1, { token: null });
  assert.equal(none.status, 403);
  assert.deepEqual((await one("SELECT COUNT(*) AS n FROM booking_confirmations")), before, "nothing held for a refused check");
  assert.ok(turnstileCalls.some((c) => c.secret === "secret-x" && c.response === "bot"), "checked with Cloudflare on the server");
  assert.equal((await book(main, DEP.d, 1, { token: "good" })).status, 202);
  // The date-request form is checked the same way.
  const req = await post(main, "/api/public/departure-requests", { tourProductId: TOUR, date: cairoDay(30), customerName: "R", customerEmail: "r@example.test", seats: 2, turnstileToken: "bot" });
  assert.equal(req.status, 403);
  assert.equal((await get(main, "/api/bootstrap")).body.turnstileSiteKey, "site-x", "the form is given the site key");

  // No secret key: the check is skipped, the booking goes through, and a warning is logged.
  const skipped = await book(open, DEP.d, 1, { token: null });
  assert.equal(skipped.status, 202, JSON.stringify(skipped.body));
  assert.match(open.proc.out, /TURNSTILE_SECRET_KEY is not set/);
  assert.equal((await get(open, "/api/bootstrap")).body.turnstileSiteKey, null);
});

test("at most 5 booking attempts an hour from one address, with a friendly message", { skip }, async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await book(limited, DEP.d, 1, { token: null });
    assert.equal(r.status, 202, `attempt ${i + 1}: ${JSON.stringify(r.body)}`);
    codes.push(r.code);
  }
  const sixth = await book(limited, DEP.d, 1, { token: null });
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /several booking attempts in the last hour.*hello@sawa\.tours/);
  // Date requests share the same allowance.
  const req = await post(limited, "/api/public/departure-requests", { tourProductId: TOUR, date: cairoDay(31), customerName: "R", customerEmail: "r2@example.test", seats: 2 });
  assert.equal(req.status, 429);
  // Reading and confirming aren't attempts.
  assert.equal((await get(limited, `/api/public/bookings/${codes[0]}`)).status, 200);
});
