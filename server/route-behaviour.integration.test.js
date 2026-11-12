// The routes that decide who may do what to a booking, RUN — not read.
//
// The code review of 12 Nov 2026 found that 87 of 142 test files read source
// text, and that one of them (agency-cancel.test.js) asserted a route's SQL by
// regex while the route left an agency invoice behind. These routes had no
// test that called them at all:
//
//   an agency cancelling its own booking        (and nobody else's)
//   Sawa confirming a date, and cancelling one
//   Sawa approving and declining a requested date
//   an agency owner managing its own team       (and nobody else's)
//   the partner code: visits, the widget record, the registered website
//
// Same shape as the other integration suites: the real migrations on an empty
// Postgres, the real server as a separate process, signed-in users through a
// stand-in for Supabase's token check, everything over HTTP, then the database
// read to see what actually happened. Runs when TEST_DATABASE_URL is set.
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
const DB_NAME = "sawa_it_route_behaviour";
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, dbUrl, fakeAuth;
const banned = [];   // logins the server asked the auth provider to revoke or restore

const cairoDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" })
  .format(new Date(Date.now() + offsetDays * 86400000));

const TOUR = "tour_it_routes";
const DEP = { forming: 920001, goahead: 920002, toCancel: 920003, toConfirm: 920004 };
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-0000000000f1", email: "ops@sawa.test", role: "super_admin", agency: null },
  "a-owner": { id: "00000000-0000-4000-8000-0000000000a1", email: "owner@agency-a.test", role: "agency_owner", agency: "ag_a" },
  "a-agent": { id: "00000000-0000-4000-8000-0000000000a2", email: "agent@agency-a.test", role: "agency_agent", agency: "ag_a" },
  "b-owner": { id: "00000000-0000-4000-8000-0000000000b1", email: "owner@agency-b.test", role: "agency_owner", agency: "ag_b" },
};

before(async () => {
  if (skip) return;
  fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    // The server revoking or restoring a login (supabase.auth.admin.updateUserById).
    const admin = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)/.exec(req.url);
    if (admin && req.method === "PUT") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => { banned.push({ id: admin[1], ...JSON.parse(body || "{}") }); res.end(JSON.stringify({ id: admin[1] })); });
      return;
    }
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    if (!u || !req.url.startsWith("/auth/v1/user")) { res.statusCode = 401; res.end(JSON.stringify({ msg: "invalid token" })); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated", role: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));
  const authUrl = `http://127.0.0.1:${fakeAuth.address().port}`;

  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });

  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_a', 'Agency A Tours'), ('ag_b', 'Agency B Travel')`);
  for (const u of Object.values(USERS)) {
    await db.query(`INSERT INTO app_users (id, email, role, agency_id) VALUES ($1,$2,$3,$4)`, [u.id, u.email, u.role, u.agency]);
  }
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Route Tour','Cairo',4,8,80,64,'approved',true,24)`, [TOUR]);
  let day = 20;
  for (const id of Object.values(DEP)) {
    await db.query(
      `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
       VALUES ($1,'day_tour',$2,'Route Tour',$3,'08:00','Cairo',4,8,80,64,'open')`, [id, TOUR, cairoDay(day++)]);
  }

  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(PORT), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: authUrl, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "", TURNSTILE_SECRET_KEY: "",
      // Sign-in checks are remembered for a minute by default; these tests
      // change who may sign in and look again at once.
      AUTH_CACHE_SECONDS: "0",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
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
  fakeAuth?.close();
  await db?.end();
  await dropDatabase(DB_NAME);
});

const call = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const pledge = (id) => one("SELECT * FROM pledges WHERE id = $1", [id]);
const liveSeats = async (depId) => Number((await one(
  "SELECT COALESCE(sum(seats),0) AS n FROM pledges WHERE departure_id=$1 AND status <> 'cancelled'", [depId])).n);
const depStatus = async (depId) => (await one("SELECT status FROM departures WHERE id = $1", [depId])).status;
const audited = async (action, entityId) => Number((await one(
  "SELECT count(*) AS n FROM audit_log WHERE action = $1 AND entity_id = $2", [action, String(entityId)])).n);

// An agency books seats for its own customer, as its portal does. Answers the
// new booking's id, read from the database: the response is the departure.
async function agencyBooks(token, depId, seats, who) {
  const r = await call("POST", `/departures/${depId}/pledges`, { seats, customers: `Client ${who}`, customerEmail: `${who}@example.test` }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return (await one("SELECT id FROM pledges WHERE departure_id = $1 AND customer_email = $2 ORDER BY created_at DESC LIMIT 1", [depId, `${who}@example.test`])).id;
}

// ---------------------------------------------------------------- an agency's own booking
test("an agency cancels its own forming booking; another agency and a stranger cannot, and cannot tell it exists", { skip }, async () => {
  const id = await agencyBooks("a-owner", DEP.forming, 2, "a1");
  assert.equal(await liveSeats(DEP.forming), 2);

  const stranger = await call("POST", `/agency/bookings/${id}/cancel`, {});
  assert.equal(stranger.status, 401);
  const other = await call("POST", `/agency/bookings/${id}/cancel`, {}, "b-owner");
  assert.equal(other.status, 404, "another agency's booking answers like a missing one");
  const missing = await call("POST", `/agency/bookings/pl_does_not_exist/cancel`, {}, "b-owner");
  assert.deepEqual([other.status, other.body.error], [missing.status, missing.body.error], "…with the same words, so its existence is not disclosed");
  const staff = await call("POST", `/agency/bookings/${id}/cancel`, {}, "ops-token");
  assert.equal(staff.status, 403, "Sawa's staff use their own routes");
  assert.equal((await pledge(id)).status, "confirmed", "nothing above touched it");
  assert.equal(await liveSeats(DEP.forming), 2);

  // A colleague in the same agency may: the booking is the agency's.
  const ok = await call("POST", `/agency/bookings/${id}/cancel`, {}, "a-agent");
  assert.deepEqual([ok.status, ok.body], [200, { cancelled: true }]);
  const row = await pledge(id);
  assert.equal(row.status, "cancelled", "marked, never deleted");
  assert.equal(await liveSeats(DEP.forming), 0, "the seats are released");
  assert.equal(await audited("booking.cancel", id), 1);

  const again = await call("POST", `/agency/bookings/${id}/cancel`, {}, "a-owner");
  assert.deepEqual([again.status, again.body], [200, { cancelled: true }], "a second click is not an error");
  assert.equal(await audited("booking.cancel", id), 1, "…and is not a second cancellation");
});

test("once a date reaches GoAhead an agency can no longer walk a seat out of it", { skip }, async () => {
  const mine = await agencyBooks("a-owner", DEP.goahead, 1, "a2");
  await agencyBooks("b-owner", DEP.goahead, 3, "b2");
  assert.equal(await depStatus(DEP.goahead), "minimum_reached", "four seats: GoAhead");

  const r = await call("POST", `/agency/bookings/${mine}/cancel`, {}, "a-owner");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /reached GoAhead/);
  assert.match(r.body.error, /section 13 of the Terms/);
  assert.equal((await pledge(mine)).status, "confirmed");
  assert.equal(await liveSeats(DEP.goahead), 4);
  assert.equal(await depStatus(DEP.goahead), "minimum_reached", "the date did not fall back to forming");
});

// ---------------------------------------------------------------- Sawa confirms and cancels a date
test("confirming a date needs its GoAhead seats, and is Sawa's to do", { skip }, async () => {
  await agencyBooks("a-owner", DEP.toConfirm, 3, "a3");
  const early = await call("POST", `/admin/departures/${DEP.toConfirm}/confirm`, {}, "ops-token");
  assert.equal(early.status, 409);
  assert.match(early.body.error, /4 booked seats are required/);
  assert.equal(await depStatus(DEP.toConfirm), "open");

  await agencyBooks("b-owner", DEP.toConfirm, 1, "b3");
  assert.equal((await call("POST", `/admin/departures/${DEP.toConfirm}/confirm`, {}, "a-owner")).status, 403, "an agency cannot confirm a date");
  assert.equal((await call("POST", `/admin/departures/${DEP.toConfirm}/confirm`, {})).status, 401);

  const ok = await call("POST", `/admin/departures/${DEP.toConfirm}/confirm`, {}, "ops-token");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await depStatus(DEP.toConfirm), "supplier_confirmed");
  assert.equal(await audited("departure.confirm", DEP.toConfirm), 1);
  assert.equal((await call("POST", `/admin/departures/999999/confirm`, {}, "ops-token")).status, 404);
});

test("cancelling a date cancels every booking on it, keeps the rows, and closes it to new bookings", { skip }, async () => {
  const a = await agencyBooks("a-owner", DEP.toCancel, 2, "a4");
  const b = await agencyBooks("b-owner", DEP.toCancel, 1, "b4");
  const direct = await call("POST", `/public/departures/${DEP.toCancel}/bookings`, { customerName: "Dina Direct", customerEmail: "dina@example.test", seats: 1 });
  assert.equal(direct.status, 201, JSON.stringify(direct.body));
  const code = direct.body.booking.bookingCode;

  assert.equal((await call("POST", `/admin/departures/${DEP.toCancel}/cancel`, {}, "a-owner")).status, 403, "an agency cannot cancel a date");
  assert.equal(await liveSeats(DEP.toCancel), 4);

  const r = await call("POST", `/admin/departures/${DEP.toCancel}/cancel`, {}, "ops-token");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pledgesCancelled, 3);
  assert.equal(r.body.notificationsIntended, 3, "each traveller on it is to be told");
  assert.equal(await depStatus(DEP.toCancel), "cancelled");
  assert.equal(await liveSeats(DEP.toCancel), 0);
  assert.deepEqual([(await pledge(a)).status, (await pledge(b)).status], ["cancelled", "cancelled"]);
  assert.equal(Number((await one("SELECT count(*) AS n FROM pledges WHERE departure_id = $1", [DEP.toCancel])).n), 3, "no booking is erased");

  // What each party now sees.
  const lookup = await call("GET", `/public/bookings/${code}`);
  assert.equal(lookup.body.booking.state, "date_cancelled");
  assert.equal(lookup.body.booking.canCancel, false);
  const late = await call("POST", `/public/departures/${DEP.toCancel}/bookings`, { customerName: "Late Larry", customerEmail: "larry@example.test", seats: 1 });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /canceled/);
  const publicList = (await call("GET", "/bootstrap")).body.departures.find((d) => d.id === DEP.toCancel);
  assert.ok(!publicList || publicList.status === "cancelled", "not offered as bookable");
  // The traveller cancelling "their" booking afterwards is told it is done, not refused.
  assert.deepEqual((await call("POST", `/public/bookings/${code}/cancel`, {})).body, { cancelled: true });
});

// ---------------------------------------------------------------- a requested date
test("a requested date is hidden until Sawa approves it; declining cancels it and its booking", { skip }, async () => {
  const request = (day, who) => call("POST", "/public/departure-requests", {
    tourProductId: TOUR, date: cairoDay(day), customerName: `Requester ${who}`, customerEmail: `${who}@example.test`, seats: 2, ignoreMatches: true,
  });
  const first = await request(40, "req1");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const dep1 = first.body.departure.id;
  assert.equal(await depStatus(dep1), "pending_review");
  const listed = async (id) => (await call("GET", "/bootstrap")).body.departures.some((d) => d.id === id);
  assert.equal(await listed(dep1), false, "a date awaiting review is not on the public site");
  const booking = await call("POST", `/public/departures/${dep1}/bookings`, { customerName: "Early Bird", customerEmail: "early@example.test", seats: 1 });
  assert.equal(booking.status, 409, "and cannot be booked yet");

  assert.equal((await call("POST", `/admin/departure-requests/${dep1}/approve`, {}, "a-owner")).status, 403);
  const ok = await call("POST", `/admin/departure-requests/${dep1}/approve`, {}, "ops-token");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await depStatus(dep1), "open");
  assert.equal(await listed(dep1), true);
  assert.equal(await liveSeats(dep1), 2, "the requester's seats count towards GoAhead");
  assert.equal((await call("POST", `/admin/departure-requests/${dep1}/approve`, {}, "ops-token")).status, 409, "it can be approved once");

  const second = await request(45, "req2");
  const dep2 = second.body.departure.id;
  const no = await call("POST", `/admin/departure-requests/${dep2}/decline`, { reason: "No guide available that week." }, "ops-token");
  assert.equal(no.status, 200, JSON.stringify(no.body));
  assert.equal(await depStatus(dep2), "cancelled");
  assert.equal(await liveSeats(dep2), 0);
  // The declined date is still sent to the public site until its day passes,
  // marked cancelled (the public list drops only dates awaiting review and
  // dates gone by). What matters is that it reads as cancelled and takes no booking.
  const declined = (await call("GET", "/bootstrap")).body.departures.find((d) => d.id === dep2);
  assert.ok(!declined || declined.status === "cancelled", "never shown as open");
  assert.equal((await call("POST", `/public/departures/${dep2}/bookings`, { customerName: "Too Late", customerEmail: "late2@example.test", seats: 1 })).status, 409);
  const audit = await one("SELECT detail FROM audit_log WHERE action = 'departure_request.decline' AND entity_id = $1", [String(dep2)]);
  assert.equal(audit.detail.reason, "No guide available that week.");
  assert.equal((await call("POST", `/admin/departure-requests/${dep2}/approve`, {}, "ops-token")).status, 409, "a declined date cannot then be opened");
});

// ---------------------------------------------------------------- an agency's own team
test("an owner manages its own team only; a disabled member is signed out at once", { skip }, async () => {
  const agent = USERS["a-agent"].id;
  assert.equal((await call("GET", "/agency/staff", undefined, "a-agent")).status, 403, "an agent cannot manage the team");
  const mine = await call("GET", "/agency/staff", undefined, "a-owner");
  assert.deepEqual(mine.body.staff.map((s) => s.email).sort(), ["agent@agency-a.test", "owner@agency-a.test"], "only this agency's people");

  // Agency B's owner reaches for agency A's agent.
  const reach = await call("PATCH", `/agency/staff/${agent}`, { status: "disabled" }, "b-owner");
  assert.equal(reach.status, 404);
  assert.equal((await call("DELETE", `/agency/staff/${agent}`, undefined, "b-owner")).status, 404);
  // …and for Sawa's own staff, who belong to no agency.
  assert.equal((await call("PATCH", `/agency/staff/${USERS["ops-token"].id}`, { status: "disabled" }, "b-owner")).status, 404);
  assert.equal((await one("SELECT status FROM app_users WHERE id = $1", [agent])).status, "active");
  assert.equal((await one("SELECT status FROM app_users WHERE id = $1", [USERS["ops-token"].id])).status, "active");

  assert.equal((await call("PATCH", `/agency/staff/${USERS["a-owner"].id}`, { role: "agency_agent" }, "a-owner")).status, 409, "an owner cannot demote themself");
  assert.equal((await call("PATCH", `/agency/staff/${agent}`, { role: "super_admin" }, "a-owner")).status, 422, "nor promote anyone to Sawa staff");

  assert.equal((await call("GET", "/me", undefined, "a-agent")).status, 200);
  const off = await call("PATCH", `/agency/staff/${agent}`, { status: "disabled" }, "a-owner");
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.login, "revoked");
  assert.ok(banned.some((b) => b.id === agent && b.ban_duration !== "none"), "the login itself was revoked, not only the row");
  assert.equal((await call("GET", "/me", undefined, "a-agent")).status, 401, "their token stops working at once");

  const on = await call("PATCH", `/agency/staff/${agent}`, { status: "active" }, "a-owner");
  assert.equal(on.body.login, "restored");
  assert.equal((await call("GET", "/me", undefined, "a-agent")).status, 200);
});

// ---------------------------------------------------------------- the partner code
test("the partner code: created once per agency, counts visits, and names only an active partner", { skip }, async () => {
  const w1 = await call("GET", "/agency/widget", undefined, "a-owner");
  assert.equal(w1.status, 200, JSON.stringify(w1.body));
  const code = w1.body.code;
  assert.match(code, /^agency-a-tours/);
  assert.equal((await call("GET", "/agency/widget", undefined, "a-agent")).body.code, code, "one code per agency, whoever asks");
  assert.notEqual((await call("GET", "/agency/widget", undefined, "b-owner")).body.code, code);
  assert.equal((await call("GET", "/agency/widget")).status, 401);

  assert.equal((await call("POST", "/track/referral", { code })).status, 204);
  assert.equal((await call("POST", "/track/referral", { code: code.toUpperCase() })).status, 204);
  assert.equal((await call("GET", "/agency/widget", undefined, "a-owner")).body.visits, 2, "counted whatever the capitals");

  const named = await call("GET", `/public/referrals/${code}`);
  assert.deepEqual([named.status, named.body.name], [200, "Agency A Tours"]);
  assert.equal((await call("GET", "/public/referrals/nobody-has-this-code")).status, 404);
  await db.query("UPDATE referrals SET active = false WHERE code = $1", [code]);
  assert.equal((await call("GET", `/public/referrals/${code}`)).status, 404, "a switched-off code names nobody");
  await db.query("UPDATE referrals SET active = true WHERE code = $1", [code]);

  // A booking through the widget is credited to the agency.
  const booked = await call("POST", `/public/departures/${DEP.forming}/bookings`, { customerName: "Wendy Widget", customerEmail: "wendy@example.test", seats: 1, refCode: code });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const after1 = (await call("GET", "/agency/widget", undefined, "a-owner")).body;
  assert.equal(after1.bookings, 1);
  assert.equal((await call("GET", "/agency/widget", undefined, "b-owner")).body.bookings, 0, "and to nobody else");
});

test("an agency's website (070): only its owner sets it, only a public https site is kept, and a booking's page is kept only on it", { skip }, async () => {
  const code = (await call("GET", "/agency/widget", undefined, "a-owner")).body.code;
  assert.equal((await call("PATCH", "/agency/profile", { website: "https://nilegate.example" }, "a-agent")).status, 403);
  for (const bad of ["http://nilegate.example", "https://127.0.0.1", "javascript:alert(1)"]) {
    const r = await call("PATCH", "/agency/profile", { website: bad }, "a-owner");
    assert.equal(r.status, 422, `${bad} must be refused`);
  }
  assert.equal((await one("SELECT website FROM agencies WHERE id = 'ag_a'")).website, null);

  const ok = await call("PATCH", "/agency/profile", { website: "www.NileGate.example/tours", contactName: "Mona" }, "a-owner");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.agency.website, "https://www.nilegate.example", "stored as the site's origin");
  assert.equal((await call("GET", "/agency/widget", undefined, "a-owner")).body.website, "https://www.nilegate.example");
  assert.equal((await one("SELECT website FROM agencies WHERE id = 'ag_b'")).website, null, "the other agency is untouched");
  const audit = await one("SELECT detail FROM audit_log WHERE action = 'agency.profile.update' AND entity_id = 'ag_a' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([audit.detail.from.website, audit.detail.to.website], [null, "https://www.nilegate.example"]);

  const book = (who, pageUrl) => call("POST", `/public/departures/${DEP.forming}/bookings`,
    { customerName: `Page ${who}`, customerEmail: `${who}@example.test`, seats: 1, refCode: code, pageUrl });
  const kept = async (who) => (await one("SELECT partner_page_url FROM pledges WHERE customer_email = $1", [`${who}@example.test`])).partner_page_url;
  assert.equal((await book("onsite", "https://nilegate.example/tours?lang=en#book")).status, 201);
  assert.equal(await kept("onsite"), "https://nilegate.example/tours?lang=en");
  assert.equal((await book("elsewhere", "https://evil.example/phish")).status, 201, "the booking itself is not refused");
  assert.equal(await kept("elsewhere"), null, "but a page on another site is not kept, so no email can link to it");

  // Clearing the website: "" is a deliberate value, not "leave it".
  const cleared = await call("PATCH", "/agency/profile", { website: "" }, "a-owner");
  assert.equal(cleared.body.agency.website, null);
  assert.equal((await book("after", "https://nilegate.example/tours")).status, 201);
  assert.equal(await kept("after"), null, "no registered website, nothing kept");
});
