// 055 — merging duplicate dates, and the root cause that made them: the real
// migrations on an empty Postgres, the real server as a separate process,
// signed-in ops and agency users. Runs when TEST_DATABASE_URL is set (see
// test-db.js) and skips otherwise.
//
// The case (27 Sep 2026): eleven travelers of one group booked the same tour
// and day separately, and each booking made its own date.
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
const DB_NAME = "sawa_it_merge";
let server, db, dbUrl, fakeAuth, BASE, merge;

const cairoDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" })
  .format(new Date(Date.now() + offsetDays * 86400000));
const TOUR = "tour_it_merge";
const OTHER = "tour_it_other";
const DAY = cairoDay(20);
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000091", email: "ops@sawa.test", role: "super_admin", agency: null },
  "ag-a-token": { id: "00000000-0000-4000-8000-000000000092", email: "owner@agency-a.test", role: "agency_owner", agency: "ag_ma" },
};

before(async () => {
  if (skip) return;
  fakeAuth = createServer((req, res) => {
    const u = USERS[(req.headers.authorization || "").replace(/^Bearer /, "")];
    res.setHeader("Content-Type", "application/json");
    if (!u || !req.url.startsWith("/auth/v1/user")) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: u.id, email: u.email, aud: "authenticated", role: "authenticated" }));
  });
  await new Promise((r) => fakeAuth.listen(0, "127.0.0.1", r));
  dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_ma', 'Agency A'), ('ag_mb', 'Agency B')`);
  for (const u of Object.values(USERS)) {
    await db.query(`INSERT INTO app_users (id, email, role, agency_id) VALUES ($1,$2,$3,$4)`, [u.id, u.email, u.role, u.agency]);
  }
  for (const id of [TOUR, OTHER]) {
    await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active, booking_cutoff_hours, default_time)
                    VALUES ($1,'day_tour',$2,'Cairo',4,12,100,80,'approved',true,24,'08:00')`, [id, id === TOUR ? "Giza Merge Tour" : "Other Tour"]);
  }
  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  merge = await import("./departure-merge.js");

  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d; });
  server.stderr.on("data", (d) => { out += d; });
  let lastError = "no response";
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
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
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

const call = async (method, path, body, token) => {
  const r = await fetch(`${BASE}/api${path}`, {
    method, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ops = (method, path, body) => call(method, path, body, "ops-token");
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
let depSeq = 950000;
async function departure({ tour = TOUR, day = DAY, status = "open", max = 12, notes = null } = {}) {
  const id = ++depSeq;
  await db.query(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status, notes)
     VALUES ($1,'day_tour',$2,'Giza Merge Tour',$3,'08:00','Cairo',4,$4,100,80,$5,$6)`, [id, tour, day, max, status, notes]);
  return id;
}
let plSeq = 0;
async function booking(depId, { seats = 1, agency = "direct_customer", source = "public", status = "confirmed", email = null } = {}) {
  const id = `pl_merge_${++plSeq}`;
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source, booking_code, booking_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'+201000000000',$8,$9,$10,$11)`,
    [id, depId, agency, agency === "direct_customer" ? "Direct" : agency, seats, `Traveler ${plSeq}`, email || `t${plSeq}@example.test`,
      status, source, `SAWA-MRG${String(plSeq).padStart(3, "0")}`, 100 * seats]);
  return id;
}
const request = (body, token) => call("POST", token ? "/agency/departure-requests" : "/public/departure-requests", {
  tourProductId: TOUR, date: DAY, customerName: "Group Member", customers: "Group Member", customerEmail: "member@example.test",
  customerPhone: "+201000000001", seats: 1, ...body,
}, token);

// ---------------------------------------------------------------- the root cause
test("the root cause: a request for a tour and day that already has a date joins it, whatever the traveler chose", { skip }, async () => {
  const day = cairoDay(25);
  // 1. The first request makes a date awaiting review.
  const first = await request({ date: day, customerEmail: "first@example.test" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const depId = first.body.departure.id;
  assert.equal(first.body.departure.status, "pending_review");
  // 2. The next ones join that request, even when they press "request my date anyway".
  for (const [i, ignoreMatches] of [[1, false], [2, true]]) {
    const r = await request({ date: day, customerEmail: `member${i}@example.test`, ignoreMatches });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.departure.id, depId, "joined the date that exists");
    assert.equal(r.body.booking.status, "pending");
  }
  assert.equal(Number((await one("SELECT count(*) AS n FROM departures WHERE tour_product_id = $1 AND date = $2", [TOUR, day])).n), 1, "one date, not three");
  assert.equal(Number((await one("SELECT count(*) AS n FROM audit_log WHERE action = 'departure_request.join' AND entity_id = $1", [String(depId)])).n), 2);
  // 3. Approved: the date opens with all three bookings confirmed.
  assert.equal((await ops("POST", `/admin/departure-requests/${depId}/approve`)).status, 200);
  assert.deepEqual((await db.query("SELECT DISTINCT status FROM pledges WHERE departure_id = $1", [depId])).rows.map((r) => r.status), ["confirmed"]);
  // 4. Once it's open, a request for that day is sent to book it, and can't be pushed past.
  for (const ignoreMatches of [false, true]) {
    const r = await request({ date: day, customerEmail: "late@example.test", ignoreMatches });
    assert.equal(r.status, 409);
    assert.equal(r.body.exactDay, true);
    assert.deepEqual(r.body.nearMatches.map((m) => m.id), [depId]);
  }
  // The same for an agency.
  const ag = await request({ date: day, ignoreMatches: true }, "ag-a-token");
  assert.equal(ag.status, 409);
  assert.equal(ag.body.exactDay, true);
  // 5. Admin can't create a second date for that day either.
  const adm = await ops("POST", "/admin/departures", { tourProductId: TOUR, date: day, firstTraveler: { name: "Phone Booking", email: "phone@example.test", seats: 1 } });
  assert.equal(adm.status, 409);
  assert.match(adm.body.error, new RegExp(`already has a date on that day \\(departure ${depId}`));
  // 6. Only when that date is full is a second one for the day made.
  await booking(depId, { seats: 9 });   // 3 + 9: the date is at its maximum of 12
  const full = await request({ date: day, customerEmail: "overflow@example.test" });
  assert.equal(full.status, 201, JSON.stringify(full.body));
  assert.notEqual(full.body.departure.id, depId);
});

// ---------------------------------------------------------------- the merge
test("merge: bookings, payments, cost lines and notes move to the kept date; seats and GoAhead are worked out again; the duplicates close, leave the site and redirect; each traveler gets one email; audited", { skip }, async () => {
  const kept = await departure({ notes: "Kept date" });
  const dupA = await departure({ notes: "Pickup at the Marriott" });
  const dupB = await departure({ status: "pending_review" });
  const b1 = await booking(kept, { seats: 2 });
  const b2 = await booking(dupA, { seats: 1, email: "moved.a@example.test" });
  const b3 = await booking(dupB, { seats: 2, status: "pending", source: "public_request", email: "moved.b@example.test" });
  await db.query(`INSERT INTO booking_payments (pledge_id, kind, amount, link_url, due_at, due_bound_by, state, paid_at, provider_reference)
                  VALUES ($1, 'deposit', 10, 'https://pay.tab.travel/m', now(), 'window', 'paid', now(), 'TAB-M')`, [b2]);
  await db.query(`INSERT INTO departure_costs (departure_id, category, description, amount) VALUES ($1, 'transport', 'Van', 40)`, [dupA]);

  const preview = await ops("POST", "/admin/departures/merge/preview", { keptId: kept, duplicateIds: [dupA, dupB] });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body.problems));
  assert.equal(preview.body.seatsAfter, 5);
  assert.equal(preview.body.goAheadAfter, true);
  assert.equal(preview.body.needsOperatorChoice, false);
  assert.ok(preview.body.split.byAgency.length >= 0 && typeof preview.body.split.sawaAfter === "number", "the old profit split is shown");

  const r = await ops("POST", "/admin/departures/merge", { keptId: kept, duplicateIds: [dupA, dupB] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.merge.movedBookings, 2);
  // Bookings (with their travelers' details) moved; the payment follows its booking.
  const rows = (await db.query("SELECT id, departure_id, status FROM pledges WHERE id = ANY($1::text[]) ORDER BY id", [[b1, b2, b3]])).rows;
  assert.ok(rows.every((p) => Number(p.departure_id) === kept));
  assert.equal(rows.find((p) => p.id === b3).status, "confirmed", "a booking awaiting review is approved onto the open date");
  assert.equal((await one("SELECT pledge_id FROM booking_payments WHERE provider_reference = 'TAB-M'")).pledge_id, b2);
  assert.equal(Number((await one("SELECT departure_id FROM departure_costs WHERE description = 'Van'")).departure_id), kept);
  assert.match((await one("SELECT notes FROM departures WHERE id = $1", [kept])).notes, /Merged from departure \d+: Pickup at the Marriott/);
  // Seats and GoAhead worked out again.
  assert.equal((await one("SELECT status FROM departures WHERE id = $1", [kept])).status, "minimum_reached", "5 of 4: GoAhead");
  // The duplicates close and point at the kept date.
  for (const id of [dupA, dupB]) {
    const d = await one("SELECT status, merged_into_id FROM departures WHERE id = $1", [id]);
    assert.deepEqual([d.status, Number(d.merged_into_id)], ["closed", kept]);
  }
  // Off the site; their links redirect; a booking on one is refused.
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  assert.ok(!boot.departures.some((d) => [dupA, dupB].includes(d.id)), "gone from the site");
  assert.ok(boot.departures.some((d) => d.id === kept));
  const redir = await fetch(`${BASE}/tour/giza-merge-tour?date=${dupA}&ref=x`, { redirect: "manual" });
  assert.equal(redir.status, 301);
  assert.equal(redir.headers.get("location"), `/tour/giza-merge-tour?date=${kept}&ref=x`);
  const late = await call("POST", `/public/departures/${dupA}/bookings`, { customerName: "Late", customerEmail: "late2@example.test", seats: 1 });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /joined with another listing/);
  // One email to each moved traveler.
  const mails = (await db.query("SELECT recipient, subject FROM email_log WHERE kind = 'departure_merged' ORDER BY recipient")).rows;
  assert.deepEqual(mails.map((m) => m.recipient), ["moved.a@example.test", "moved.b@example.test"]);
  assert.match(mails[0].subject, /nothing changes/);
  assert.equal(r.body.merge.emailed, 2);
  // Audited.
  const log = await one("SELECT detail FROM audit_log WHERE action = 'departure.merge' AND entity_id = $1", [String(kept)]);
  assert.deepEqual(log.detail.merged.sort(), [dupA, dupB].sort());
  assert.equal(log.detail.bookings.length, 2);

  // Reverted within 24 hours: everything back as it was.
  const undo = await ops("POST", `/admin/departure-merges/${r.body.merge.id}/revert`);
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  const back = (await db.query("SELECT id, departure_id, status FROM pledges WHERE id = ANY($1::text[]) ORDER BY id", [[b1, b2, b3]])).rows;
  assert.deepEqual(back.map((p) => [p.id, Number(p.departure_id)]), [[b1, kept], [b2, dupA], [b3, dupB]].sort());
  assert.equal(back.find((p) => p.id === b3).status, "pending", "back awaiting review");
  assert.equal(Number((await one("SELECT departure_id FROM departure_costs WHERE description = 'Van'")).departure_id), dupA);
  assert.deepEqual([(await one("SELECT status, merged_into_id FROM departures WHERE id = $1", [dupA]))].map((d) => [d.status, d.merged_into_id]), [["open", null]]);
  assert.equal((await one("SELECT status FROM departures WHERE id = $1", [dupB])).status, "pending_review");
  assert.equal((await one("SELECT notes FROM departures WHERE id = $1", [kept])).notes, "Kept date");
  assert.ok(await one("SELECT 1 FROM audit_log WHERE action = 'departure.merge_reverted' AND entity_id = $1", [String(kept)]));
  assert.equal((await ops("POST", `/admin/departure-merges/${r.body.merge.id}/revert`)).status, 409, "only once");
});

test("a merge can be undone only within 24 hours", { skip }, async () => {
  const kept = await departure();
  const dup = await departure();
  await booking(kept); await booking(dup);
  const r = await ops("POST", "/admin/departures/merge", { keptId: kept, duplicateIds: [dup] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await assert.rejects(merge.revertMerge({ mergeId: r.body.merge.id, by: "ops", now: Date.now() + 25 * 3600000 }), /only within 24 hours/);
});

// ---------------------------------------------------------------- the refusals
test("refused: over the maximum group, a duplicate settled or paid out, another tour or day, a catalog date, a date already merged", { skip }, async () => {
  const refused = async (keptId, duplicateIds, re) => {
    const p = await ops("POST", "/admin/departures/merge/preview", { keptId, duplicateIds });
    assert.equal(p.body.ok, false, JSON.stringify(p.body));
    assert.ok(p.body.problems.some((x) => re.test(x)), `${re} in ${JSON.stringify(p.body.problems)}`);
    const m = await ops("POST", "/admin/departures/merge", { keptId, duplicateIds });
    assert.equal(m.status, 409);
    assert.match(m.body.error, re);
  };
  // The maximum group.
  const small = await departure({ max: 4 });
  const big = await departure();
  await booking(small, { seats: 3 }); await booking(big, { seats: 2 });
  await refused(small, [big], /hold 5 travelers; the kept date takes at most 4/);
  // Settled: the cost sheet final, or a loss decided.
  const k1 = await departure(); const settled = await departure();
  await booking(k1); await booking(settled);
  await db.query("INSERT INTO departure_settlements (departure_id, costs_final_at) VALUES ($1, now())", [settled]);
  await refused(k1, [settled], /already settled/);
  // Paid out in a Wednesday run.
  const k2 = await departure(); const paid = await departure();
  await booking(k2); await booking(paid);
  const run = await one("INSERT INTO payout_runs (pay_date, cutoff_at, state, approved_at) VALUES ($1, now(), 'approved', now()) RETURNING id", [cairoDay(-100)]);
  await db.query("INSERT INTO payout_lines (run_id, departure_id, agency_id, amount) VALUES ($1, $2, 'ag_ma', 5)", [run.id, paid]);
  await refused(k2, [paid], /already been paid out/);
  // Another tour, another day.
  const k3 = await departure();
  const otherTour = await departure({ tour: OTHER });
  const otherDay = await departure({ day: cairoDay(21) });
  await refused(k3, [otherTour], /different tour/);
  await refused(k3, [otherDay], /different day/);
  // A catalog date (one per product and day by construction).
  const k4 = await departure(); const cat = await departure();
  const prod = await one(
    `INSERT INTO catalogue_products (catalogue_no, code, slug, title, type, base_city)
     VALUES (901, 'IT-MERGE', 'it-merge', 'Merge test product', 'day_tour', 'Cairo') RETURNING id`);
  await db.query("INSERT INTO catalogue_departures (product_id, date, legacy_departure_id) VALUES ($1, $2, $3)", [prod.id, DAY, cat]);
  await refused(k4, [cat], /catalog departure/);
  // A kept date awaiting review can't absorb an open one.
  const inReview = await departure({ status: "pending_review" }); const open = await departure();
  await refused(inReview, [open], /Keep a date that is open/);
});

test("different operators: admin chooses who runs the kept date, after seeing the old profit split", { skip }, async () => {
  const k = await departure(); const d = await departure();
  // Each date was opened by a different agency's request.
  const pa = await booking(k, { seats: 2, agency: "ag_ma", source: "agency_request" });
  const pb = await booking(d, { seats: 2, agency: "ag_mb", source: "agency_request" });
  // Money collected on each, so the old split has shares to show.
  for (const [pl, ref] of [[pa, "TAB-OA"], [pb, "TAB-OB"]]) {
    await db.query(`INSERT INTO booking_payments (pledge_id, kind, amount, link_url, due_at, due_bound_by, state, paid_at, provider_reference)
                    VALUES ($1, 'deposit', 50, 'https://pay.tab.travel/o', now(), 'window', 'paid', now(), $2)`, [pl, ref]);
  }
  const p = await ops("POST", "/admin/departures/merge/preview", { keptId: k, duplicateIds: [d] });
  assert.equal(p.body.needsOperatorChoice, true);
  assert.deepEqual(p.body.operatorChoices.map((o) => o.agencyId).sort(), ["ag_ma", "ag_mb"]);
  const names = p.body.split.byAgency.map((a) => a.agencyId).sort();
  assert.deepEqual(names, ["ag_ma", "ag_mb"], "both agencies' shares, before and after");
  const without = await ops("POST", "/admin/departures/merge", { keptId: k, duplicateIds: [d] });
  assert.equal(without.status, 422);
  assert.match(without.body.error, /Choose who runs the kept date/);
  const chosen = await ops("POST", "/admin/departures/merge", { keptId: k, duplicateIds: [d], operatorAgencyId: "ag_mb" });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
  assert.equal((await one("SELECT operator_agency_override AS o FROM departures WHERE id = $1", [k])).o, "ag_mb");
  const { operatorOf } = await import("./operator-lookup.js");
  assert.equal((await operatorOf(k)).id, "ag_mb", "the choice stands over the U01 rule");
});
