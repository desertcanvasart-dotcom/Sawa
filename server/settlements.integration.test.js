// 044 — settlements and the Wednesday payouts end to end: the real migrations
// on an empty Postgres, the real server, signed-in ops and agency users, the
// client's revenue-sharing model driven over HTTP from bookings to transfers.
// Runs when TEST_DATABASE_URL is set (see test-db.js) and skips otherwise.
//
// The departure: 12 passengers (the group maximum) — agency A 6 (its own
// booking, so A operates), Capital Travel Service 4 (direct), agency B 2
// (through B's widget) — at €250, so €3,000 collected. A submits €1,600 of
// costs; Sawa approves €1,500. Gross profit €1,500, Sawa €150, and €1,350
// shared 6/4/2: A €675, CTS €450, B €225.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { payDateOnOrAfter, cairoDay } from "./settlement.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_settlements";
const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, fakeAuth;
const storage = { buckets: new Map(), objects: new Map() };

const day = (n) => cairoDay(Date.now() + n * 86400000);
const TOUR = "tour_it_settle";
const DEP = 920001;
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000011", email: "ops@sawa.test", role: "super_admin", agency: null },
  "a-token": { id: "00000000-0000-4000-8000-000000000012", email: "owner@a.test", role: "agency_owner", agency: "ag_a" },
  "b-token": { id: "00000000-0000-4000-8000-000000000013", email: "owner@b.test", role: "agency_owner", agency: "ag_b" },
};
// A Wednesday whose Saturday is after today, so today's payments are inside it.
const WED1 = payDateOnOrAfter(day(4));
const WED2 = payDateOnOrAfter(day(11));

before(async () => {
  if (skip) return;
  // Stands in for Supabase: sign-in (/auth/v1/user) and the four storage
  // calls receipts make — bucket lookup, bucket creation, upload, signed link.
  fakeAuth = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = req.url.split("?")[0];
    if (url.startsWith("/storage/v1/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const path = url.slice("/storage/v1".length);
      if (req.method === "GET" && path.startsWith("/bucket/")) {
        const id = path.slice("/bucket/".length);
        if (!storage.buckets.has(id)) { res.statusCode = 404; res.end(JSON.stringify({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" })); return; }
        res.end(JSON.stringify({ id, name: id, public: false })); return;
      }
      if (req.method === "POST" && path === "/bucket") {
        const b = JSON.parse(body.toString());
        storage.buckets.set(b.id || b.name, b);
        res.end(JSON.stringify({ name: b.name })); return;
      }
      if (req.method === "POST" && path.startsWith("/object/sign/")) {
        const key = decodeURIComponent(path.slice("/object/sign/".length));
        if (!storage.objects.has(key)) { res.statusCode = 404; res.end(JSON.stringify({ message: "Object not found" })); return; }
        res.end(JSON.stringify({ signedURL: `/object/sign/${key}?token=t` })); return;
      }
      if (req.method === "POST" && path.startsWith("/object/")) {
        const key = decodeURIComponent(path.slice("/object/".length));
        storage.objects.set(key, { body, type: req.headers["content-type"] });
        res.end(JSON.stringify({ Key: key })); return;
      }
      res.statusCode = 404; res.end("{}"); return;
    }
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    if (!u) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));

  const dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_cts','Capital Travel Service'), ('ag_a','Agency A'), ('ag_b','Agency B')`);
  for (const u of Object.values(USERS)) await db.query(`INSERT INTO app_users (id, email, role, agency_id) VALUES ($1,$2,$3,$4)`, [u.id, u.email, u.role, u.agency]);
  await db.query(`INSERT INTO referrals (code, name, agency_id) VALUES ('agency-b', 'Agency B', 'ag_b')`);
  // A flat €250 a head, so the booking totals are round numbers.
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours)
                  VALUES ($1,'day_tour','Settlement Tour','Cairo',4,12,250,250,'approved',true,24)`, [TOUR]);
  await db.query(`INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
                  VALUES ($1,'day_tour',$2,'Settlement Tour',$3,'08:00','Cairo',4,12,250,250,'open')`, [DEP, TOUR, day(20)]);

  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(PORT), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", ENABLE_JOB_SCHEDULER: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d; });
  server.stderr.on("data", (d) => { out += d; });
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
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
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ops = (m, p, b) => call(m, p, b, "ops-token");
const settlementOf = async () => (await ops("GET", "/admin/settlements")).body.items.find((i) => i.departure.id === DEP);
const shareOf = (v, id) => v.settlement.shares.find((x) => x.agencyId === id);

async function payInFull(pledgeId, ref) {
  const link = await ops("POST", `/admin/bookings/${pledgeId}/payment-links`, { kind: "full", url: `https://pay.tab.travel/${ref}` });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  assert.equal((await ops("POST", `/admin/payments/${link.body.payment.id}/paid`, { reference: ref })).status, 200);
}

let bPledge;

test("12 paid passengers from three parties; A operates", { skip }, async () => {
  const a = await call("POST", `/departures/${DEP}/pledges`, { seats: 6, customers: "A-6", customerEmail: "a@x.com", customerPhone: "+201000000000" }, "a-token");
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const direct = await call("POST", `/public/departures/${DEP}/bookings`, { customerName: "Direct", customerEmail: "d@x.com", seats: 4 });
  const widget = await call("POST", `/public/departures/${DEP}/bookings`, { customerName: "Via B", customerEmail: "w@x.com", seats: 2, refCode: "agency-b" });
  assert.equal(direct.status, 201);
  assert.equal(widget.status, 201);
  const aPledge = (await db.query(`SELECT id FROM pledges WHERE agency_id='ag_a'`)).rows[0].id;
  bPledge = widget.body.booking.id;
  await payInFull(aPledge, "TAB-A");
  await payInFull(direct.body.booking.id, "TAB-D");
  await payInFull(bPledge, "TAB-B");

  const v = await settlementOf();
  assert.equal(v.settlement.revenue, 3000);
  assert.equal(v.operatorAgencyId, "ag_a");
  assert.equal(v.blocker, "not_ended");
});

test("only the operator submits costs; Sawa approves a different amount", { skip }, async () => {
  const cost = { category: "transport", description: "Coach and driver", amount: 1600 };
  assert.equal((await call("POST", `/agency/departures/${DEP}/costs`, cost, "b-token")).status, 403, "B doesn't operate this date");
  const sub = await call("POST", `/agency/departures/${DEP}/costs`, { ...cost, receiptUrl: "https://drive.example.com/receipt" }, "a-token");
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.cost.state, "submitted");
  assert.equal((await call("POST", `/agency/departures/${DEP}/costs`, { ...cost, receiptUrl: "http://insecure" }, "a-token")).status, 422);

  // The tour has happened. Its bookings and payments move back with it — they
  // were made before bookings closed, which the operator rule checks.
  await db.query(`UPDATE departures SET date = $2 WHERE id = $1`, [DEP, day(-1)]);
  await db.query(`UPDATE pledges SET created_at = now() - interval '10 days' WHERE departure_id = $1`, [DEP]);
  await db.query(`UPDATE booking_payments SET link_sent_at = now() - interval '4 days', due_at = now() - interval '1 day',
                    paid_at = now() - interval '3 days'
                   WHERE pledge_id IN (SELECT id FROM pledges WHERE departure_id = $1)`, [DEP]);
  assert.equal((await settlementOf()).operatorAgencyId, "ag_a", "A still operates after the cutoff");
  let v = await settlementOf();
  assert.equal(v.blocker, "costs_to_review");
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/costs-final`, { final: true })).status, 409, "not while a line waits");

  const rev = await ops("POST", `/admin/departure-costs/${sub.body.cost.id}/review`, { decision: "approve", approvedAmount: 1500, note: "coach quote was €1,500" });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  v = await settlementOf();
  assert.equal(v.blocker, "costs_not_final");
  assert.deepEqual([v.settlement.cost, v.settlement.gross, v.settlement.sawaCut, v.settlement.pool], [1500, 1500, 150, 1350]);
  assert.deepEqual([shareOf(v, "ag_a").total, shareOf(v, "ag_cts").total, shareOf(v, "ag_b").total], [675, 450, 225]);
});

test("receipts: the operator uploads a file privately; only staff and the uploader can open it", { skip }, async () => {
  const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 coach contract").toString("base64")}`;
  const up = await call("POST", "/cost-receipts", { filename: "Coach contract.pdf", dataUrl: pdf }, "a-token");
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.match(up.body.ref, /^receipts:agency\/ag_a\/\d+-[a-z0-9]+-coach-contract\.pdf$/);
  assert.equal(storage.buckets.get("cost-receipts")?.public, false, "a private bucket, created on first use");
  assert.equal((await call("POST", "/cost-receipts", { filename: "x.html", dataUrl: "data:text/html;base64,PGI+" }, "a-token")).status, 422);

  // The operator can't attach a file another agency uploaded, even knowing its reference.
  const theirs = await call("POST", "/cost-receipts", { filename: "b.pdf", dataUrl: pdf }, "b-token");
  assert.equal(theirs.status, 201);
  const stolen = await call("POST", `/agency/departures/${DEP}/costs`, { category: "guide", description: "Guide", amount: 1, receiptUrl: theirs.body.ref }, "a-token");
  assert.equal(stolen.status, 422, JSON.stringify(stolen.body));
  const cost = await call("POST", `/agency/departures/${DEP}/costs`, { category: "permits", description: "Site permit", amount: 25, receiptUrl: up.body.ref }, "a-token");
  assert.equal(cost.status, 201, JSON.stringify(cost.body));
  assert.equal(cost.body.cost.receiptFile, "coach-contract.pdf");
  assert.equal(cost.body.cost.receiptUrl, null, "the storage reference is never shown as a link");

  const open = await call("GET", `/cost-receipts/${cost.body.cost.id}`, undefined, "a-token");
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.match(open.body.url, /\/storage\/v1\/object\/sign\/cost-receipts\/agency\/ag_a\//);
  assert.equal(open.body.expiresInSeconds, 120);
  assert.equal((await ops("GET", `/cost-receipts/${cost.body.cost.id}`)).status, 200, "staff can open it");
  assert.equal((await call("GET", `/cost-receipts/${cost.body.cost.id}`, undefined, "b-token")).status, 403, "another agency can't");

  // Sawa rejects it (it was only for this test), so the figures below are unchanged.
  assert.equal((await ops("POST", `/admin/departure-costs/${cost.body.cost.id}/review`, { decision: "reject", note: "test line" })).status, 200);
});

test("a Wednesday run pays signed-off tours; approving it creates the transfers", { skip }, async () => {
  const early = await ops("POST", "/admin/payout-runs", { payDate: WED1 });
  assert.equal(early.status, 201, JSON.stringify(early.body));
  assert.equal(early.body.run.lines.length, 0, "the cost sheet isn't final yet");
  assert.equal((await ops("POST", "/admin/payout-runs", { payDate: day(0) === WED1 ? day(1) : "2026-10-13" })).status, 422, "Wednesdays only");

  assert.equal((await ops("POST", `/admin/settlements/${DEP}/costs-final`, { final: true })).status, 200);
  const run = await ops("POST", "/admin/payout-runs", { payDate: WED1 });
  assert.equal(run.status, 201);
  const lines = Object.fromEntries(run.body.run.lines.map((l) => [l.agencyId, l.amount]));
  assert.deepEqual(lines, { ag_a: 675, ag_cts: 450, ag_b: 225 });

  const ok = await ops("POST", `/admin/payout-runs/${run.body.run.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.run.transfers.length, 3);
  assert.equal((await ops("POST", `/admin/payout-runs/${run.body.run.id}/approve`)).status, 409);
  assert.equal((await ops("POST", "/admin/payout-runs", { payDate: WED1 })).status, 409, "an approved run can't be rebuilt");

  const a = ok.body.run.transfers.find((t) => t.agencyId === "ag_a");
  assert.equal((await ops("POST", `/admin/payout-transfers/${a.id}/paid`, {})).status, 422);
  assert.equal((await ops("POST", `/admin/payout-transfers/${a.id}/paid`, { reference: "BANK-001" })).status, 200);
  assert.equal((await ops("POST", `/admin/payout-transfers/${a.id}/paid`, { reference: "BANK-001" })).status, 409);
});

test("pay now, top up next week: a later decision is paid on the next Wednesday", { skip }, async () => {
  // Sawa decides it will cover €50 of a non-refundable cost for B.
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/adjustments`, { agencyId: "ag_b", amount: 50, reason: "Sawa covers B's non-refundable ticket" })).status, 201);
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/adjustments`, { agencyId: null, amount: -50, reason: "Sawa covers B's non-refundable ticket" })).status, 201);
  const next = await ops("POST", "/admin/payout-runs", { payDate: WED2 });
  assert.equal(next.status, 201);
  assert.deepEqual(next.body.run.lines.map((l) => [l.agencyId, l.amount]), [["ag_b", 50]], "only the difference");
});

test("each agency sees its own share and transfers — never another agency's", { skip }, async () => {
  const a = await call("GET", "/agency/money", undefined, "a-token");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const dep = a.body.departures.find((d) => d.departure.id === DEP);
  assert.equal(dep.operating, true);
  assert.deepEqual([dep.mine.seats, dep.mine.total, dep.mine.paidOut], [6, 675, 675]);
  assert.equal(dep.costs.length, 2, "the operator sees its cost sheet (the coach, and the rejected test line)");
  assert.ok(!("shares" in dep) && !JSON.stringify(dep).includes("ag_b"), "no other agency's figures");
  assert.deepEqual(a.body.transfers.map((t) => [t.amount, t.state, t.bankReference]), [[675, "paid", "BANK-001"]]);

  const b = await call("GET", "/agency/money", undefined, "b-token");
  const bd = b.body.departures.find((d) => d.departure.id === DEP);
  assert.equal(bd.operating, false);
  assert.equal(bd.costs.length, 0, "cost lines only for the operator");
  assert.equal(bd.mine.seats, 2, "widget passengers count for B");
  assert.equal(bd.mine.total, 275, "€225 share + the €50 Sawa covered");
  assert.equal((await call("GET", "/admin/settlements", undefined, "a-token")).status, 403);
});

test("every decision is in the audit log", { skip }, async () => {
  const actions = new Set((await db.query(`SELECT action FROM audit_log WHERE action LIKE 'settlement.%' OR action LIKE 'payout.%'`)).rows.map((r) => r.action));
  for (const a of ["settlement.cost_submitted", "settlement.cost_reviewed", "settlement.costs_final", "settlement.adjustment", "payout.run_built", "payout.run_approved", "payout.transfer_paid"]) {
    assert.ok(actions.has(a), `${a} missing`);
  }
});

test("a loss waits for Sawa's decision", { skip }, async () => {
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/costs-final`, { final: false })).status, 200);
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/costs`, { category: "accommodation", description: "Emergency hotel", amount: 2000 })).status, 201);
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/costs-final`, { final: true })).status, 200);
  let v = await settlementOf();
  assert.equal(v.settlement.loss, true);
  assert.equal(v.blocker, "loss_needs_decision");
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/loss-decision`, {})).status, 422);
  assert.equal((await ops("POST", `/admin/settlements/${DEP}/loss-decision`, { note: "Sawa absorbs the emergency hotel" })).status, 200);
  v = await settlementOf();
  assert.equal(v.blocker, null);
});

// A date confirmed to run, with nothing paid and no costs yet, is listed — so
// its operator has somewhere to enter costs and upload receipts.
test("a date at GoAhead is listed before any money or costs, with its cost sheet open", { skip }, async () => {
  const DEP2 = 920002;
  await db.query(`INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
                  VALUES ($1,'day_tour',$2,'Settlement Tour',$3,'08:00','Cairo',4,12,250,250,'open')`, [DEP2, TOUR, day(30)]);
  assert.equal((await ops("GET", "/admin/settlements")).body.items.some((i) => i.departure.id === DEP2), false, "not while forming");
  const a = await call("POST", `/departures/${DEP2}/pledges`, { seats: 4, customers: "A-4", customerEmail: "a4@x.com", customerPhone: "+201000000004" }, "a-token");
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const v = (await ops("GET", "/admin/settlements")).body.items.find((i) => i.departure.id === DEP2);
  assert.ok(v, "listed once it reaches GoAhead");
  assert.equal(v.settlement.revenue, 0);
  const money = (await call("GET", "/agency/money", undefined, "a-token")).body.departures.find((d) => d.departure.id === DEP2);
  assert.ok(money?.operating, "the operator sees it, with its cost sheet");
  const cost = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "transport", description: "Coach", amount: 900 }, "a-token");
  assert.equal(cost.status, 201, "and can enter a cost straight away");
});

// Mixed pricing (045): a coach is priced for the group, a lunch per person.
test("per-person costs: price × people makes the total; group costs stay a total", { skip }, async () => {
  const DEP2 = 920002;
  const money = (await call("GET", "/agency/money", undefined, "a-token")).body.departures.find((d) => d.departure.id === DEP2);
  assert.equal(money.travellers, 4, "the form suggests the travellers on the date");
  const lunch = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "meals", description: "Lunch", basis: "person", unitAmount: 15, quantity: 12 }, "a-token");
  assert.equal(lunch.status, 201, JSON.stringify(lunch.body));
  assert.equal(lunch.body.cost.basis, "person");
  assert.equal(lunch.body.cost.unitAmount, 15);
  assert.equal(lunch.body.cost.quantity, 12);
  assert.equal(lunch.body.cost.amount, 180);
  const coach = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "transport", description: "Coach", basis: "group", amount: 700 }, "a-token");
  assert.equal(coach.body.cost.basis, "group");
  assert.equal(coach.body.cost.amount, 700);
  assert.equal(coach.body.cost.unitAmount, null);
  assert.equal((await call("POST", `/agency/departures/${DEP2}/costs`, { category: "meals", description: "Lunch", basis: "person", unitAmount: 15 }, "a-token")).status, 422, "people are needed");
  assert.equal((await call("POST", `/agency/departures/${DEP2}/costs`, { category: "transport", description: "Coach", basis: "group" }, "a-token")).status, 422, "a total is needed");
  const staff = await ops("POST", `/admin/settlements/${DEP2}/costs`, { category: "entrance", description: "Tickets", basis: "person", unitAmount: 12.5, quantity: 4 });
  assert.equal(staff.status, 201, JSON.stringify(staff.body));
  assert.equal(staff.body.cost.amount, 50);
  assert.equal(staff.body.cost.state, "approved");
});

// Money in (046): a shop's commission is approved like a cost and adds to the
// profit; a commission we pay is a cost.
test("extra income: the operator records money in; once approved it adds to gross profit", { skip }, async () => {
  const DEP2 = 920002;
  const shop = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "shop_commission", description: "Papyrus shop, 10% of sales", amount: 120 }, "a-token");
  assert.equal(shop.status, 201, JSON.stringify(shop.body));
  assert.equal(shop.body.cost.kind, "income");
  const tours = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "optional_tours", description: "Felucca ride", basis: "person", unitAmount: 20, quantity: 3 }, "a-token");
  assert.equal(tours.body.cost.kind, "income");
  assert.equal(tours.body.cost.amount, 60);
  const paidOut = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "commission_paid", description: "Hotel concierge", amount: 15 }, "a-token");
  assert.equal(paidOut.body.cost.kind, "cost");
  const before = (await ops("GET", "/admin/settlements")).body.items.find((i) => i.departure.id === DEP2).settlement;
  assert.equal(before.income, 0, "not until Sawa approves it");
  assert.equal((await ops("POST", `/admin/departure-costs/${shop.body.cost.id}/review`, { decision: "approve" })).status, 200);
  const after = (await ops("GET", "/admin/settlements")).body.items.find((i) => i.departure.id === DEP2).settlement;
  assert.equal(after.income, 120);
  assert.equal(after.cost, before.cost, "money in never counts as a cost");
  assert.equal(after.gross, Math.round((after.revenue + 120 - after.cost) * 100) / 100);
  const mine = (await call("GET", "/agency/money", undefined, "a-token")).body;
  assert.equal(mine.departures.find((d) => d.departure.id === DEP2).income, 120, "the agency sees it too");
  assert.ok(mine.categories.some((c) => c.id === "shop_commission" && c.kind === "income"));
  const staff = await ops("POST", `/admin/settlements/${DEP2}/costs`, { category: "commission_received", description: "Perfume palace", amount: 40 });
  assert.equal(staff.body.cost.kind, "income");
  assert.equal(staff.body.cost.state, "approved");
  assert.ok((await db.query(`SELECT 1 FROM audit_log WHERE action = 'settlement.cost_submitted' AND detail->>'kind' = 'income'`)).rowCount >= 1);
});

// Production between merging and running 045: per-person lines still save, as
// a total with the price written into the description.
test("before migration 045: a per-person cost saves as its total", { skip }, async () => {
  const DEP2 = 920002;
  await db.query(`ALTER TABLE departure_costs DROP CONSTRAINT departure_costs_basis_chk, DROP COLUMN basis, DROP COLUMN unit_amount, DROP COLUMN quantity`);
  const r = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "meals", description: "Dinner", basis: "person", unitAmount: 20, quantity: 12 }, "a-token");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.cost.amount, 240);
  assert.match(r.body.cost.description, /× 12 people/);
  assert.equal((await ops("GET", "/admin/settlements")).status, 200, "the sheet still loads");
});

// Production between merging and running 046: a commission we pay still
// saves (as "Other"); income is refused rather than counted as a cost.
test("before migration 046: income is refused, commission we pay saves as Other", { skip }, async () => {
  const DEP2 = 920002;
  await db.query(`ALTER TABLE departure_costs DROP CONSTRAINT departure_costs_kind_chk, DROP COLUMN kind`);
  const inc = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "shop_commission", description: "Shop", amount: 50 }, "a-token");
  assert.equal(inc.status, 503);
  assert.match(inc.body.error, /migration 046/);
  const out = await call("POST", `/agency/departures/${DEP2}/costs`, { category: "commission_paid", description: "Concierge", amount: 10 }, "a-token");
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.cost.category, "other");
  assert.match(out.body.cost.description, /^Commission we pay: Concierge/);
  assert.equal(out.body.cost.kind, "cost");
});

// Last: removes the tables — production's state between merging and migrating.
test("before migration 044: the screens say settlements are off", { skip }, async () => {
  await db.query(`DROP TABLE payout_transfers, payout_lines, payout_runs, departure_settlements, settlement_adjustments, departure_costs`);
  assert.deepEqual((await ops("GET", "/admin/settlements")).body, { available: false, items: [] });
  assert.equal((await ops("GET", "/admin/payout-runs")).body.available, false);
  assert.equal((await call("GET", "/agency/money", undefined, "a-token")).body.available, false);
  const w = await ops("POST", `/admin/settlements/${DEP}/costs`, { category: "other", description: "x", amount: 1 });
  assert.equal(w.status, 503);
  assert.match(w.body.error, /migration 044/);
  assert.equal((await call("GET", "/bootstrap")).status, 200, "the site is unaffected");
});
