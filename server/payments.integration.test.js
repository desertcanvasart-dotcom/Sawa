// 043 — payment links end to end: the real migrations on an empty Postgres,
// the real server as a separate process, signed-in ops and agency users, and
// every step of a booking's payments driven over HTTP. Runs when
// TEST_DATABASE_URL is set (see test-db.js) and skips otherwise.
//
// Sign-in is Supabase's: the server checks a bearer token by calling
// `<SUPABASE_URL>/auth/v1/user`. A tiny local stand-in answers that call for
// the two test tokens, so the server's own auth path runs unmodified.
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
const DB_NAME = "sawa_it_payments";
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, dbUrl, fakeAuth;

const cairoDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" })
  .format(new Date(Date.now() + offsetDays * 86400000));

const TOUR = "tour_it_pay";
const DEP = 910001;
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000001", email: "ops@sawa.test", role: "super_admin", agency: null },
  "agency-token": { id: "00000000-0000-4000-8000-000000000002", email: "owner@agency.test", role: "agency_owner", agency: "ag_it" },
};

before(async () => {
  if (skip) return;
  fakeAuth = createServer((req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const u = USERS[token];
    res.setHeader("Content-Type", "application/json");
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
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_it', 'Integration Agency')`);
  for (const u of Object.values(USERS)) {
    await db.query(`INSERT INTO app_users (id, email, role, agency_id) VALUES ($1,$2,$3,$4)`, [u.id, u.email, u.role, u.agency]);
  }
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Payment Tour','Cairo',4,12,100,80,'approved',true,24)`, [TOUR]);
  await db.query(`INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
                  VALUES ($1,'day_tour',$2,'Payment Tour',$3,'08:00','Cairo',4,12,100,80,'open')`, [DEP, TOUR, cairoDay(20)]);

  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(PORT), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: authUrl, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "",
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
const ops = (method, path, body) => call(method, path, body, "ops-token");
const itemFor = async (pledgeId) => (await ops("GET", "/admin/payments")).body.items.find((i) => i.pledge.id === pledgeId);
const waitForEmail = async (kind, to) => {
  for (let i = 0; i < 50; i++) {
    const r = await db.query("SELECT subject FROM email_log WHERE kind = $1 AND recipient = $2", [kind, to]);
    if (r.rows.length) return r.rows[0];
    await new Promise((res) => setTimeout(res, 100));
  }
  return null;
};

let direct, agencyPledgeId;

test("a date reaches GoAhead: both bookings join the payments queue asking for a deposit link", { skip }, async () => {
  const b = await call("POST", `/public/departures/${DEP}/bookings`, { customerName: "Dana Direct", customerEmail: "dana@example.com", seats: 2 });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  direct = b.body.booking;
  const a = await call("POST", `/departures/${DEP}/pledges`, { seats: 2, customers: "I-2-2", customerEmail: "cust@agency-client.com", customerPhone: "+201000000000" }, "agency-token");
  assert.equal(a.status, 201, JSON.stringify(a.body));
  agencyPledgeId = (await db.query("SELECT id FROM pledges WHERE agency_id = 'ag_it'")).rows[0].id;

  const q = await ops("GET", "/admin/payments");
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.available, true);
  const mine = q.body.items.filter((i) => i.departure.id === DEP);
  assert.equal(mine.length, 2);
  for (const i of mine) {
    assert.equal(i.summary.stage, "deposit_link_needed");
    assert.equal(i.summary.label, "Deposit link needed");
    assert.ok(i.defaults.deposit > 0 && i.defaults.deposit < i.defaults.full, JSON.stringify(i.defaults));
  }
});

test("the payment routes are for ops only", { skip }, async () => {
  assert.equal((await call("GET", "/admin/payments")).status, 401);
  assert.equal((await call("GET", "/admin/payments", undefined, "agency-token")).status, 403);
  const r = await call("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/x" }, "agency-token");
  assert.equal(r.status, 403);
});

test("a deposit link is checked, stored with its deadline, and emailed to the customer", { skip }, async () => {
  const bad = await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "deposit", url: "http://pay.tab.travel/x" });
  assert.equal(bad.status, 422, "https only");
  const tooMuch = await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/x", amount: 99999 });
  assert.equal(tooMuch.status, 422, "never more than is outstanding");

  const r = await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/dana-deposit" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.emailed, true);
  const p = r.body.payment;
  assert.equal(p.state, "link_sent");
  assert.equal(p.provider, "tab");
  assert.equal(p.emailedTo, "dana@example.com");
  const hours = (Date.parse(p.dueAt) - Date.parse(p.linkSentAt)) / 3600000;
  assert.ok(Math.abs(hours - 72) < 0.1, `3 days to pay, got ${hours}h (${p.dueBoundBy})`);
  assert.equal(p.dueBoundBy, "window");

  const again = await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/second" });
  assert.equal(again.status, 409, "one open deposit link at a time");

  const mail = await waitForEmail("payment_link", "dana@example.com");
  assert.ok(mail, "the link was emailed");
  assert.match(mail.subject, /deposit link/i);

  assert.equal((await itemFor(direct.id)).summary.stage, "link_sent");
});

test("the customer's booking page shows the open link", { skip }, async () => {
  const r = await call("GET", `/public/bookings/${direct.bookingCode}`);
  assert.equal(r.status, 200);
  const pay = r.body.booking.payment;
  assert.equal(pay.stage, "link_sent");
  assert.equal(pay.open.linkUrl, "https://pay.tab.travel/dana-deposit");
  assert.equal(pay.open.kind, "deposit");
});

test("marking paid needs Tab's reference, happens once, and thanks the customer", { skip }, async () => {
  const id = (await itemFor(direct.id)).summary.open.id;
  assert.equal((await ops("POST", `/admin/payments/${id}/paid`, {})).status, 422);
  const r = await ops("POST", `/admin/payments/${id}/paid`, { reference: "TAB-1001" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payment.state, "paid");
  assert.equal(r.body.payment.providerReference, "TAB-1001");
  assert.equal((await ops("POST", `/admin/payments/${id}/paid`, { reference: "TAB-1001" })).status, 409, "a double click can't pay twice");

  const item = await itemFor(direct.id);
  assert.equal(item.summary.stage, "deposit_paid");
  assert.ok(item.summary.paid > 0 && item.summary.outstanding > 0);
  assert.equal((await db.query("SELECT paid FROM pledges WHERE id=$1", [direct.id])).rows[0].paid, false, "not paid in full yet");
  assert.ok(await waitForEmail("payment_received", "dana@example.com"));
});

test("a wrong link is voided, not edited; a replacement can then be sent", { skip }, async () => {
  const sent = await ops("POST", `/admin/bookings/${agencyPledgeId}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/wrong" });
  assert.equal(sent.status, 201);
  const v = await ops("POST", `/admin/payments/${sent.body.payment.id}/void`, { reason: "wrong amount" });
  assert.equal(v.status, 200);
  assert.equal(v.body.payment.state, "void");
  assert.equal((await ops("POST", `/admin/payments/${sent.body.payment.id}/paid`, { reference: "X" })).status, 409, "a void link can't be paid");
  assert.equal((await itemFor(agencyPledgeId)).summary.stage, "deposit_link_needed");
  const again = await ops("POST", `/admin/bookings/${agencyPledgeId}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/right" });
  assert.equal(again.status, 201, "the void link no longer blocks a new one");
  const rows = (await db.query("SELECT link_url, state FROM booking_payments WHERE pledge_id=$1 ORDER BY id", [agencyPledgeId])).rows;
  assert.deepEqual(rows.map((r) => r.state), ["void", "link_sent"], "what was sent survives");
});

test("the agency sees its own bookings' payment status and link — nobody else's", { skip }, async () => {
  const r = await call("GET", "/agency/payments", undefined, "agency-token");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.available, true);
  assert.deepEqual(Object.keys(r.body.byPledge), [agencyPledgeId], "only the agency's own booking");
  const s = r.body.byPledge[agencyPledgeId];
  assert.equal(s.stage, "link_sent");
  assert.equal(s.open.linkUrl, "https://pay.tab.travel/right");
});

test("paying the rest makes the booking paid in full; a refund reopens it", { skip }, async () => {
  const rest = await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "balance", url: "https://pay.tab.travel/dana-balance" });
  assert.equal(rest.status, 201, JSON.stringify(rest.body));
  assert.equal(rest.body.payment.dueBoundBy, "balance-due-date", "due on the date quoted at booking");
  assert.equal((await ops("POST", `/admin/payments/${rest.body.payment.id}/paid`, { reference: "TAB-1002" })).status, 200);
  let item = await itemFor(direct.id);
  assert.equal(item.summary.stage, "paid_in_full");
  assert.equal(item.summary.outstanding, 0);
  assert.equal((await db.query("SELECT paid FROM pledges WHERE id=$1", [direct.id])).rows[0].paid, true);
  assert.equal((await ops("POST", `/admin/bookings/${direct.id}/payment-links`, { kind: "full", url: "https://pay.tab.travel/x" })).status, 422,
    "nothing left to collect");

  const refund = await ops("POST", `/admin/payments/${rest.body.payment.id}/refund`, { reference: "TAB-R-1" });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.payment.state, "refunded");
  item = await itemFor(direct.id);
  assert.notEqual(item.summary.stage, "paid_in_full");
  assert.equal((await db.query("SELECT paid FROM pledges WHERE id=$1", [direct.id])).rows[0].paid, false);
});

test("every payment step is in the audit log", { skip }, async () => {
  const actions = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'payment.%'")).rows.map((r) => r.action);
  for (const a of ["payment.link_sent", "payment.paid", "payment.void", "payment.refund"]) {
    assert.ok(actions.includes(a), `${a} missing from ${actions}`);
  }
});

test("a cancelled booking can't be sent a link", { skip }, async () => {
  const b = await call("POST", `/public/departures/${DEP}/bookings`, { customerName: "Carl Cancel", customerEmail: "carl@example.com", seats: 1 });
  assert.equal(b.status, 201);
  // After GoAhead a traveller cancels through Sawa, so ops cancel it here.
  assert.equal((await ops("PATCH", `/admin/bookings/${b.body.booking.id}`, { status: "cancelled" })).status, 200);
  const r = await ops("POST", `/admin/bookings/${b.body.booking.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/x" });
  assert.equal(r.status, 409);
});

// U01 — the operator rule reads the payments: once anyone on a date has paid
// a deposit, only paid passengers count; a widget booking counts for the
// agency whose code it carries.
test("the operator follows widget bookings and paid deposits", { skip }, async () => {
  const DEP2 = 910002;
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_it_cts', 'Capital Travel Service')`);
  await db.query(`INSERT INTO referrals (code, name, agency_id) VALUES ('integration-agency', 'Integration Agency', 'ag_it')`);
  await db.query(`INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
                  VALUES ($1,'day_tour',$2,'Payment Tour',$3,'08:00','Cairo',4,12,100,80,'open')`, [DEP2, TOUR, cairoDay(25)]);
  const operatorOf = async () => (await ops("GET", "/bootstrap")).body.departures.find((d) => d.id === DEP2).operatorAgencyId;

  const direct2 = await call("POST", `/public/departures/${DEP2}/bookings`, { customerName: "Direct Dee", customerEmail: "dee@example.com", seats: 2 });
  assert.equal(direct2.status, 201);
  assert.equal(await operatorOf(), "ag_it_cts", "two direct seats: Capital Travel Service");
  assert.equal((await call("POST", `/departures/${DEP2}/pledges`, { seats: 1, customers: "I-1", customerEmail: "c1@x.com", customerPhone: "+201000000001" }, "agency-token")).status, 201);
  const widget = await call("POST", `/public/departures/${DEP2}/bookings`, { customerName: "Widget Wes", customerEmail: "wes@example.com", seats: 2, refCode: "integration-agency" });
  assert.equal(widget.status, 201);
  assert.equal(await operatorOf(), "ag_it", "1 agency seat + 2 through its widget beat 2 direct");

  const link = await ops("POST", `/admin/bookings/${direct2.body.booking.id}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/dee" });
  assert.equal(link.status, 201);
  assert.equal((await ops("POST", `/admin/payments/${link.body.payment.id}/paid`, { reference: "TAB-OP-1" })).status, 200);
  assert.equal(await operatorOf(), "ag_it_cts", "only the paid passengers count now");
});

// Last: it removes the table. Migrations do not run on deploy (B5), so this is
// the state production is in between merging and `npm run db:migrate`.
test("before migration 043: the screens say payments are off, and nothing else breaks", { skip }, async () => {
  await db.query("DROP TABLE booking_payments");
  const q = await ops("GET", "/admin/payments");
  assert.equal(q.status, 200);
  assert.deepEqual(q.body, { available: false, items: [] });
  const send = await ops("POST", `/admin/bookings/${agencyPledgeId}/payment-links`, { kind: "deposit", url: "https://pay.tab.travel/x" });
  assert.equal(send.status, 503);
  assert.match(send.body.error, /migration 043/);
  const agency = await call("GET", "/agency/payments", undefined, "agency-token");
  assert.deepEqual(agency.body, { available: false, byPledge: {} });
  const lookup = await call("GET", `/public/bookings/${direct.bookingCode}`);
  assert.equal(lookup.status, 200, "the booking page still works");
  assert.equal(lookup.body.booking.payment, null);
  const again = await call("POST", `/public/departures/${DEP}/bookings`, { customerName: "Late Lou", customerEmail: "lou@example.com", seats: 1 });
  assert.equal(again.status, 201, "booking still works");
});
