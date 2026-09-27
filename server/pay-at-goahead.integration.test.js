// Model phase 4 on a real Postgres: pay at GoAhead ("mode C") and the
// cancellation tiers. docs/phase4/payments-readiness.md section 9 lists what
// is tested; docs/phase4/REPORT.md maps each area to the tests below.
//
//   tiers        seeded, versioned, immutable once published; a booking keeps
//                the version it was made under (direct: at booking; agency: at
//                the agency's booking, and the traveler's link accepts that
//                same version); the loss check (clause 10.2)
//   GoAhead      one full-price request per live booking, through the
//                tab-manual provider (ops tasks); agency-billed seats to the
//                agency, for the invoice amount, due at the deadline
//   deadline     48 hours from the link, capped at the cut-off; the reminder
//                at halfway, once; the warning 2 hours before; the release
//   extension    reason required, the original kept, audited
//   waitlist     order, expiry, back on sale, pay now, the fee returned on a
//                resale before the cut-off
//   manifest     paid and due before the cut-off; released seats removed and
//                the band recalculated (clause 10.1); frozen: manifest seats
//   guarantee    below 4 still runs; 4–6 band + per traveler; the advance's
//                excess becomes a receivable and is set off
//   commission   void on unpaid; earned when paid and traveled
//   refunds      full price × retained %, recorded with the amount
//   flag off     legacy bookings unchanged
//
// Skips without TEST_DATABASE_URL (see test-db.js). Tests share one database
// and run in order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";
import { zonedDateTimeToUtc } from "./tz.js";
import { shiftDate } from "../shared/catalogue.js";
import { tierAt, refundFor } from "../shared/cancellation-tiers.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_pay_at_goahead";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN = 60000;
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000081", email: "boss@sawa.test", role: "super_admin" },
  "staff-token": { id: "00000000-0000-4000-8000-000000000082", email: "finance@sawa.test", role: "ops_staff" },
  "ag-a-token": { id: "00000000-0000-4000-8000-000000000083", email: "owner@agency-a.test", role: "agency_owner", agency: "ag_a" },
  "ag-b-token": { id: "00000000-0000-4000-8000-000000000084", email: "owner@agency-b.test", role: "agency_owner", agency: "ag_b" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, rates, asg, settle, fin, comm, tiers, pag, jobs;
let productId, X, on;
const deps = {};
const sent = [];
const send = async (m) => { sent.push(m); return { ok: true }; };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const cairo = (iso) => new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date(iso)) + " Cairo time";

async function startServer(extraEnv) {
  // A port nothing is listening on: a random one could land on the other
  // server this suite started, and the health check would answer from it.
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const proc = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false", PORT: String(port), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fakeAuth.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", ENABLE_JOB_SCHEDULER: "", FEATURES: "",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(proc);
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  proc.stderr.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return base;
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;   // not listening yet — reported below if it never is
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start (${lastError}):\n${out}`);
}

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
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query("TRUNCATE catalogue_products CASCADE");
  await db.query("TRUNCATE operators CASCADE");
  // The rate card example: €95 retail.
  await db.query(
    `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                booking_cutoff_hours, included, not_included)
     VALUES ($1,'day_tour','Giza Pyramids, Sphinx & the Grand Egyptian Museum','Cairo','08:00',4,12,95,95,'approved',true,24,'["Guide"]','["Tips"]')`, [GIZA]);
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  await db.query(`INSERT INTO agencies (id, name, billing_approved, billing_due_days) VALUES ('ag_a', 'Agency A', true, 14)`);
  await db.query(`INSERT INTO agencies (id, name) VALUES ('ag_b', 'Agency B')`);
  for (const u of Object.values(USERS)) {
    await db.query("INSERT INTO app_users (id, email, role, agency_id) VALUES ($1, $2, $3, $4)", [u.id, u.email, u.role, u.agency || null]);
  }

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  process.env.EMAIL_REPLY_TO = "ops-alerts@sawa.test";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  settle = await import("./operator-settlement.js");
  fin = await import("./finance.js");
  comm = await import("./commissions.js");
  tiers = await import("./cancellation-tiers.js");
  pag = await import("./pay-at-goahead.js");
  jobs = await import("./jobs/operator-jobs.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await cat.generateDepartures({ materialise: true });

  // The rate card example: 2,200 EGP per traveler; fees 1,500 / 2,000 / 2,600;
  // commission €10 a seat.
  const rd = await rates.saveRateDraft(db, productId, { perTraveler: 2200, fee4_6: 1500, fee7_9: 2000, fee10_12: 2600, commissionPerSeat: 10 }, { by: "it" });
  await rates.publishRate({ productId, versionId: rd.id, by: "it" });

  X = (await ops.createOperator(db, { legalName: "Nile Tours S.A.E.", email: "dispatch@nile-tours.test" }, "it")).id;
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, X, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await ops.setApprovals(db, X, [productId], "it");
  await ops.setOperatorStatus(db, X, "active", { by: "it" });

  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20
      ORDER BY date LIMIT 9`, [productId, today()]);
  assert.ok(r.rows.length >= 9, "need nine departures");
  [deps.a, deps.b, deps.c, deps.d, deps.e, deps.f, deps.g, deps.h, deps.i] = r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), legacy: x.legacy_departure_id }));
  on = await startServer({ FEATURES: "catalogue_v2" });
});

after(async () => {
  if (skip) return;
  for (const s of servers) s.kill();
  fakeAuth?.close();
  const { pool } = await import("./db/index.js");
  await pool.end();
  await db?.end();
  if (!process.env.KEEP_TEST_DB) await dropDatabase(DB_NAME);
});

// A pay-at-GoAhead booking, made as the booking routes make one.
let seq = 0;
async function book(dep, seats, { agencyId = "direct_customer", billing = false, total = null, email = "t@example.test", now = Date.now() } = {}) {
  const id = `pl_pag_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  const names = Array.from({ length: seats }, (_, i) => `Traveler ${seq}.${i + 1}`);
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source,
                          pickup_point, nationality, safety_needs, traveller_names, booking_total, booking_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'+201000000000','confirmed','public','Mena House','Brazilian','None',$8,$9,$10)`,
    [id, dep.legacy, agencyId, agencyId === "direct_customer" ? "Direct" : agencyId, seats, names[0], email,
      JSON.stringify(names), total ?? 95 * seats, `PAG${String(seq).padStart(5, "0")}`]);
  await tiers.fixBookingTerms(db, { pledgeId: id, by: agencyId === "direct_customer" ? "traveller" : "agency", now });
  if (agencyId !== "direct_customer") {
    await comm.recordAgencyBooking(db, { pledgeId: id, agency: { id: agencyId, billing_approved: billing, billing_due_days: 14 }, catalogueDepartureId: dep.id });
  }
  return id;
}
const reqOf = (pledgeId) => one("SELECT * FROM payment_requests WHERE pledge_id = $1 ORDER BY id DESC LIMIT 1", [pledgeId]);
const cutoffOf = (dep) => zonedDateTimeToUtc(dep.date, "08:00") - 48 * HOUR;
const startOf = (dep) => zonedDateTimeToUtc(dep.date, "08:00");
const tick = (now) => pag.runPayAtGoAheadTick({ db, now, send });
const link = (pledgeId, now) => reqOf(pledgeId).then((r) => pag.attachLink(db, { requestId: Number(r.id), linkUrl: `https://pay.tab.travel/${r.reference}`, by: "ops", now, send }));
const pay = (pledgeId, now = Date.now()) => reqOf(pledgeId).then((r) => pag.markRequestPaid(db, { requestId: Number(r.id), providerReference: `TAB-${r.id}`, by: "ops", now }));

// ---------------------------------------------------------------- tiers
test("tiers: version 1 is seeded from today's schedule, in force, and fixed once published", { skip }, async () => {
  const v1 = await tiers.tierVersionInForce(db);
  assert.equal(v1.version, 1);
  const day = v1.rows.filter((t) => t.productType === "day_tour").map((t) => [t.minBeforeHours, t.retainedPct]);
  assert.deepEqual(day, [[48, 0], [0, 10]]);
  const cruise = v1.rows.filter((t) => t.productType === "cruise").map((t) => [t.minBeforeHours / 24, t.unit, t.retainedPct]);
  assert.deepEqual(cruise, [[30, "days", 0], [15, "days", 12.5], [0, "days", 25]]);
  await assert.rejects(db.query("UPDATE cancellation_tiers SET retained_pct = 5 WHERE version_id = $1", [v1.id]), /published/);
  await assert.rejects(db.query("UPDATE cancellation_tier_versions SET effective_from = '2027-01-01' WHERE id = $1", [v1.id]), /published/);

  // A draft copies the version in force; rows are checked before saving.
  const d = await tiers.createTierDraft(db, { by: "it" });
  assert.equal(d.version, 2);
  assert.equal(d.rows.length, v1.rows.length);
  const rows = d.rows.map((t) => ({ ...t }));
  await assert.rejects(tiers.saveTierDraft(db, { versionId: d.id, rows: rows.filter((t) => !(t.productType === "day_tour" && t.minBeforeHours === 0)), by: "it" }),
    /no-shows/);
  await assert.rejects(tiers.saveTierDraft(db, { versionId: d.id, rows: rows.map((t) => (t.productType === "cruise" && t.minBeforeHours === 0 ? { ...t, retainedPct: 5 } : t)), by: "it" }),
    /can't fall/);
  await assert.rejects(tiers.publishTierDraft(db, { versionId: d.id, effectiveFrom: shiftDate(today(), -1), by: "it" }), /past/);
  deps.draft2 = d.id;
});

test("a booking keeps the tier version in force when it was made, though tiers change before GoAhead", { skip }, async () => {
  // Direct booking through the public route: the traveler accepts the Terms here.
  const res = await fetch(`${on}/api/public/departures/${deps.a.legacy}/bookings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Ana Lima", customerEmail: "ana@example.test", customerPhone: "+201001112233", seats: 2,
      travelerNames: ["Ana Lima", "Bo Lima"], pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true,
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  const made = JSON.parse(body).booking;
  const p = await one("SELECT * FROM pledges WHERE id = $1", [made.id]);
  assert.deepEqual([p.payment_mode, p.terms_fixed_by, Number(p.cancellation_tier_version_id)], ["pay_at_goahead", "traveller", 1]);
  assert.ok(p.traveller_terms_accepted_at);
  deps.a.ana = p.id;

  // Tiers change: day tours keep 20% under 48 hours from today.
  const v2rows = (await tiers.tierVersionById(db, deps.draft2)).rows.map((t) => (t.productType === "day_tour" && t.minBeforeHours === 0 ? { ...t, retainedPct: 20 } : t));
  await tiers.saveTierDraft(db, { versionId: deps.draft2, rows: v2rows, by: "it" });
  const v2 = await tiers.publishTierDraft(db, { versionId: deps.draft2, effectiveFrom: today(), by: "it" });
  assert.equal((await tiers.tierVersionInForce(db)).id, v2.id);
  deps.v2 = v2.id;

  // GoAhead: three more bookings, made under version 2.
  deps.a.second = await book(deps.a, 2);
  deps.a.agency = await book(deps.a, 2, { agencyId: "ag_a", billing: true });
  deps.a.gone = await book(deps.a, 1);
  await db.query("UPDATE pledges SET status = 'cancelled', cancelled_reason = 'traveler', cancelled_at = now() WHERE id = $1", [deps.a.gone]);
  await cat.runStatusJob({});
  assert.equal((await one("SELECT status FROM catalogue_departures WHERE id = $1", [deps.a.id])).status, "go_ahead");
  assert.equal(Number((await one("SELECT cancellation_tier_version_id AS v FROM pledges WHERE id = $1", [deps.a.ana])).v), 1, "made under v1, keeps v1");
  assert.equal(Number((await one("SELECT cancellation_tier_version_id AS v FROM pledges WHERE id = $1", [deps.a.second])).v), v2.id);
  // The fee on a late cancellation follows the booking's version: 10%, not 20%.
  const quoteAna = await pag.cancellationQuote(db, { pledgeId: deps.a.ana, now: startOf(deps.a) - DAY });
  assert.deepEqual([quoteAna.tierVersion, quoteAna.retainedPct], [1, 10]);
  const quoteSecond = await pag.cancellationQuote(db, { pledgeId: deps.a.second, now: startOf(deps.a) - DAY });
  assert.deepEqual([quoteSecond.tierVersion, quoteSecond.retainedPct], [2, 20]);
});

test("an agency booking keeps the version the agency booked under; the traveler's link shows and accepts that version", { skip }, async () => {
  const res = await fetch(`${on}/api/departures/${deps.b.legacy}/pledges`, {
    method: "POST", headers: auth("ag-b-token"),
    body: JSON.stringify({ seats: 2, customers: "Omar Said", customerEmail: "omar@example.test", customerPhone: "+201009998877",
      travelerNames: ["Omar Said", "Mona Said"], pickupPoint: "Zamalek", nationality: "Egyptian", safetyNone: true }),
  });
  assert.equal(res.status, 201, await res.text());
  const p = await one("SELECT * FROM pledges WHERE departure_id = $1 AND agency_id = 'ag_b'", [deps.b.legacy]);
  assert.deepEqual([p.terms_fixed_by, Number(p.cancellation_tier_version_id), p.traveller_terms_accepted_at], ["agency", deps.v2, null]);
  assert.ok(p.booking_code, "a catalog agency booking gets a code: the payment's reference");
  deps.b.omar = p.id;

  // The tiers change again (v3: day tours back to 10%, packages 15% at 29–15 days).
  const d3 = await tiers.createTierDraft(db, { by: "it" });
  const rows3 = d3.rows.map((t) => (t.productType === "day_tour" && t.minBeforeHours === 0 ? { ...t, retainedPct: 10 }
    : ["cruise", "multi_day"].includes(t.productType) && t.minBeforeHours === 360 ? { ...t, retainedPct: 15 } : t));
  await tiers.saveTierDraft(db, { versionId: d3.id, rows: rows3, by: "it" });
  const v3 = await tiers.publishTierDraft(db, { versionId: d3.id, effectiveFrom: today(), by: "it" });
  deps.v3 = v3.id;

  // The traveler opens the link: the version the agency booked under.
  const page = await (await fetch(`${on}/api/public/bookings/${p.booking_code}`)).json();
  assert.equal(page.booking.payAtGoAhead.terms.versionId, deps.v2);
  assert.deepEqual(page.booking.payAtGoAhead.terms.tiers.map((t) => t.retainedPct), [0, 20]);
  assert.equal(page.booking.payAtGoAhead.terms.fixedBy, "agency");
  const wrong = await fetch(`${on}/api/public/bookings/${p.booking_code}/accept-terms`, { method: "POST", headers: auth("x"), body: JSON.stringify({ versionId: v3.id }) });
  assert.equal(wrong.status, 409, "only the version the agency booked under");
  const ok = await fetch(`${on}/api/public/bookings/${p.booking_code}/accept-terms`, { method: "POST", headers: auth("x"), body: JSON.stringify({ versionId: deps.v2 }) });
  assert.equal(ok.status, 200, await ok.text());
  const after = await one("SELECT * FROM pledges WHERE id = $1", [p.id]);
  assert.equal(Number(after.cancellation_tier_version_id), deps.v2, "the booking keeps it");
  assert.ok(after.traveller_terms_accepted_at);
});

test("loss check (clause 10.2): €95 retail, 2,200 EGP a traveler at 55 EGP/EUR, 10% kept under 48 hours → a loss is flagged", { skip }, async () => {
  await fin.setFxRate(db, { day: today(), egpPerEur: 55, by: "it" });
  const report = await tiers.tierLossReport(db, { versionId: deps.v3 });
  const giza = report.products.find((p) => p.product.id === productId);
  const [early, late] = giza.windows;
  assert.deepEqual([early.afterPoint, early.losesMoney], [false, false], "48 hours or more: before the cut-off, not checked");
  assert.deepEqual([late.afterPoint, late.retainedEur, late.owedEur, late.lossEur, late.losesMoney], [true, 9.5, 40, 30.5, true]);
  assert.equal(giza.losesMoney, true);
  assert.ok(report.warnings >= 1);
  // The same through the admin route.
  const viaRoute = await (await fetch(`${on}/api/admin/cancellation-tiers/${deps.v3}/loss-check`, { headers: auth("staff-token") })).json();
  assert.equal(viaRoute.products.find((p) => p.product.id === productId).windows[1].lossEur, 30.5);
  // And on the margin report, under the departure's locked rate and its bookings' versions.
  const margin = (await fin.marginReport(db, { from: deps.a.date, to: deps.a.date })).find((r) => r.departure.id === deps.a.id);
  assert.ok(margin.lossWarnings.some((w) => w.tierVersion === 1 && w.lossEur === 30.5), JSON.stringify(margin.lossWarnings));
  assert.ok(margin.lossWarnings.some((w) => w.tierVersion === 2 && w.lossEur === 21), "20% keeps €19 against €40");
});

// ---------------------------------------------------------------- GoAhead and the deadline
test("at GoAhead: one full-price request per live booking, the agency-billed seats to the agency; ops get tasks and one email", { skip }, async () => {
  sent.length = 0;
  const t0 = Date.now();
  deps.t0 = t0;
  const out = await tick(t0);
  assert.equal(out.requested, 3, JSON.stringify(out));
  const ana = await reqOf(deps.a.ana);
  assert.deepEqual([ana.state, ana.payer, Number(ana.amount_eur), ana.provider, ana.reference],
    ["awaiting_link", "traveller", 190, "tab-manual", (await one("SELECT booking_code FROM pledges WHERE id = $1", [deps.a.ana])).booking_code]);
  const agency = await reqOf(deps.a.agency);
  assert.deepEqual([agency.payer, Number(agency.amount_eur)], ["agency", 190 - 20], "the invoice amount: price less commission");
  assert.equal(await reqOf(deps.a.gone), undefined, "none for a canceled booking");
  const tasks = (await db.query("SELECT * FROM payment_tasks WHERE kind = 'create_link' AND state = 'open'")).rows;
  assert.equal(tasks.length, 3);
  assert.match(tasks[0].title, /^Make a Tab link for €190, reference \S+$/);
  const opsMail = sent.filter((m) => m.kind === "pay_at_goahead_ops_links");
  assert.equal(opsMail.length, 1);
  assert.equal(opsMail[0].to, "ops-alerts@sawa.test");
  assert.equal((await tick(t0 + MIN)).opsNotified, 0, "once");
  assert.equal((await tick(t0 + MIN)).requested, 0, "exactly one request per booking");

  // Ops paste the links: the deadline starts, 48 hours, and the payer is emailed.
  sent.length = 0;
  for (const id of [deps.a.ana, deps.a.second, deps.a.agency]) await link(id, t0);
  const sentAna = await reqOf(deps.a.ana);
  assert.deepEqual([sentAna.state, sentAna.due_bound_by], ["sent", "window"]);
  assert.equal(new Date(sentAna.due_at).getTime(), t0 + 48 * HOUR);
  assert.equal(new Date(sentAna.original_due_at).getTime(), t0 + 48 * HOUR);
  const mailAna = sent.find((m) => m.to === "t@example.test" || m.to === "ana@example.test");
  assert.ok(mailAna.subject.includes(cairo(sentAna.due_at)), "the traveler copy states the stored deadline");
  const mailAgency = sent.find((m) => m.to === "owner@agency-a.test");
  assert.match(mailAgency.text, /agency's booking/);
  const inv = await one("SELECT * FROM agency_invoices WHERE pledge_id = $1", [deps.a.agency]);
  assert.equal(ymd(inv.due_on), new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(t0 + 48 * HOUR)),
    "the agency-billed invoice is due at the deadline");
  assert.equal((await db.query("SELECT 1 FROM payment_tasks WHERE kind = 'create_link' AND state = 'open'")).rowCount, 0);
});

test("before the cut-off the manifest shows paid seats and seats with payment due", { skip }, async () => {
  await pay(deps.a.ana, deps.t0 + HOUR);
  const m = await asg.manifestFor(db, { departureId: deps.a.id });
  assert.equal(m.frozen, false);
  const byBooking = new Map(m.travelers.filter((t) => t.lead).map((t) => [t.booking, t.payment]));
  const code = async (id) => (await one("SELECT booking_code FROM pledges WHERE id = $1", [id])).booking_code;
  assert.deepEqual(byBooking.get(await code(deps.a.ana)), { standing: "paid" });
  const due = byBooking.get(await code(deps.a.second));
  assert.equal(due.standing, "due");
  assert.equal(Date.parse(due.dueAt), deps.t0 + 48 * HOUR);
  assert.equal(m.seatCount, 6);
});

test("the reminder goes once, at the halfway point, and never after payment", { skip }, async () => {
  sent.length = 0;
  assert.equal((await tick(deps.t0 + 23 * HOUR)).reminded, 0);
  const r = await tick(deps.t0 + 24 * HOUR + MIN);
  assert.equal(r.reminded, 2, "the two unpaid; not Ana, who paid");
  assert.ok(sent.every((m) => m.to !== "ana@example.test"));
  assert.equal(sent.filter((m) => m.kind === "pay_at_goahead_reminder").length, 2);
  assert.equal((await tick(deps.t0 + 30 * HOUR)).reminded, 0, "once");
});

test("ops are warned 2 hours before a release; a payment recorded after the warning stops it; the unpaid seat is released", { skip }, async () => {
  sent.length = 0;
  const w = await tick(deps.t0 + 46 * HOUR + MIN);
  assert.equal(w.warned, 2);
  const warn = sent.find((m) => m.kind === "pay_at_goahead_ops_release_warning");
  assert.match(warn.subject, /2 seats will be released in 2 hours/);
  // The second traveler paid in Tab; ops mark it after the warning.
  await pay(deps.a.second, deps.t0 + 47 * HOUR);
  sent.length = 0;
  const rel = await tick(deps.t0 + 48 * HOUR + MIN);
  assert.equal(rel.released, 1);
  const agency = await one("SELECT * FROM pledges WHERE id = $1", [deps.a.agency]);
  assert.deepEqual([agency.status, agency.cancelled_reason], ["cancelled", "unpaid"]);
  assert.equal((await reqOf(deps.a.agency)).state, "released");
  assert.ok(sent.some((m) => m.kind === "pay_at_goahead_released" && m.to === "owner@agency-a.test"));
  for (const id of [deps.a.ana, deps.a.second]) {
    assert.equal((await one("SELECT status FROM pledges WHERE id = $1", [id])).status, "confirmed", "a paid booking is never released");
  }
  assert.equal((await one("SELECT state FROM agency_invoices WHERE pledge_id = $1", [deps.a.agency])).state, "void", "the agency invoice is voided");
  await assert.rejects(pay(deps.a.agency), /Reinstate/);
  // Released like a cancellation before the cut-off (clause 10.1): off the
  // manifest, the band recalculated, the operator not paid for it.
  const m = await asg.manifestFor(db, { departureId: deps.a.id });
  assert.equal(m.seatCount, 4);
  const amount = await asg.expectedAmountFor(db, deps.a.id);
  assert.deepEqual([amount.travelers, amount.band, amount.total], [4, "4-6", 1500 + 4 * 2200]);
  // The commission on the released agency seat is void.
  await comm.decideCommissions({});
  const c = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [deps.a.agency]);
  assert.deepEqual([c.state, c.state_reason], ["void", "Released: not paid by the deadline."]);
});

test("at the cut-off the manifest freezes with manifest seats only", { skip }, async () => {
  const at = cutoffOf(deps.a) + MIN;
  await tick(at);
  await asg.freezeManifests({ db, now: at });
  const frozen = await one("SELECT * FROM catalogue_manifests WHERE departure_id = $1", [deps.a.id]);
  assert.equal(frozen.seat_count, 4);
  assert.ok(frozen.travelers.every((t) => t.payment === undefined), "no payment marks once frozen");
});

test("the deadline: capped at the cut-off, never under 24 hours unless the cut-off is sooner; admin sees the short window", { skip }, async () => {
  // Departure B goes ahead with Omar's 2 seats plus 2 more.
  deps.b.more = await book(deps.b, 2);
  await cat.runStatusJob({});
  // 20 hours before the cut-off: under the 24-hour floor (a short window),
  // over the 12-hour minimum that would hold the link for a decision.
  const late = cutoffOf(deps.b) - 20 * HOUR;
  await tick(late);
  await link(deps.b.more, late);
  const r = await reqOf(deps.b.more);
  assert.deepEqual([new Date(r.due_at).getTime(), r.due_bound_by], [cutoffOf(deps.b), "cutoff"]);
  const overview = await pag.payAtGoAheadOverview(db);
  const b = overview.departures.find((d) => d.id === deps.b.id);
  assert.equal(b.counts.shortWindow, 2);
  // Undo for the extension test: this request is canceled, a fresh one made at GoAhead time.
  await db.query("UPDATE payment_requests SET state = 'cancelled', cancelled_at = now() WHERE pledge_id = ANY($1::text[])", [[deps.b.more, deps.b.omar]]);
});

// ---------------------------------------------------------------- extension
test("an extension needs a reason, keeps the original deadline, is audited, and the release follows it", { skip }, async () => {
  const now = Date.now();
  await tick(now);
  await link(deps.b.omar, now);
  const r = await reqOf(deps.b.omar);
  const ext = (body) => fetch(`${on}/api/admin/pay-requests/${r.id}/extend`, { method: "POST", headers: auth("staff-token"), body: JSON.stringify(body) });
  const due = new Date(r.due_at).getTime();
  assert.equal((await ext({ dueAt: new Date(due + DAY).toISOString() })).status, 422, "a reason is required");
  assert.equal((await ext({ dueAt: new Date(due - HOUR).toISOString(), reason: "x" })).status, 422, "later than the current deadline");
  assert.equal((await ext({ dueAt: new Date(cutoffOf(deps.b) + HOUR).toISOString(), reason: "x" })).status, 422, "not after the cut-off");
  const ok = await ext({ dueAt: new Date(due + DAY).toISOString(), reason: "Card blocked abroad; paying from home tomorrow" });
  assert.equal(ok.status, 200, await ok.text());
  const after = await reqOf(deps.b.omar);
  assert.equal(new Date(after.original_due_at).getTime(), due, "the original deadline is kept");
  assert.equal(new Date(after.due_at).getTime(), due + DAY);
  const audit = await one("SELECT * FROM audit_log WHERE action = 'pay_request.extend' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.detail.reason, "Card blocked abroad; paying from home tomorrow");
  assert.equal(audit.actor_email, "finance@sawa.test");
  assert.equal((await tick(due + MIN)).released, 0, "not at the old deadline");
  assert.equal((await one("SELECT status FROM pledges WHERE id = $1", [deps.b.omar])).status, "confirmed");
  assert.equal((await tick(due + DAY + MIN)).released >= 1, true, "at the new one");
  assert.equal((await one("SELECT cancelled_reason FROM pledges WHERE id = $1", [deps.b.omar])).cancelled_reason, "unpaid");
});

// ---------------------------------------------------------------- guarantee below 4
test("the guarantee: releases take the departure to 2; it still runs; the operator is paid the 4–6 band plus 2 per-traveler amounts; the excess advance is set off", { skip }, async () => {
  const d = deps.d;
  d.agencyB = await book(d, 2, { agencyId: "ag_b" });
  const others = [await book(d, 2), await book(d, 2), await book(d, 2)];
  await cat.runStatusJob({});
  const a = await asg.assignByAdmin(db, { departureId: d.id, operatorId: X, by: "ops" });
  await asg.acknowledge(db, { assignmentId: a.id, operatorId: X, by: "dispatch" });
  const adv = await one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [a.id]);
  assert.equal(Number(adv.amount), (8 * 2200 + 2000) / 2, "50% of the expected amount on 8 booked seats");
  // Finance paid the advance (bank details and transfers are phase 3's tests).
  await db.query("UPDATE operator_payables SET state = 'paid', paid_at = now() WHERE id = $1", [adv.id]);
  const now = Date.now();
  await tick(now);
  for (const id of [d.agencyB, ...others]) await link(id, now);
  await pay(d.agencyB, now + HOUR);
  const rel = await tick(now + 48 * HOUR + MIN);
  assert.equal(rel.released, 3);
  const dep = await one("SELECT status FROM catalogue_departures WHERE id = $1", [d.id]);
  assert.equal(dep.status, "go_ahead", "the departure is guaranteed");
  assert.notEqual((await one("SELECT status FROM departures WHERE id = $1", [d.legacy])).status, "open", "the legacy date isn't reopened");
  await asg.freezeManifests({ db, now: cutoffOf(d) + MIN });
  assert.equal((await one("SELECT seat_count FROM catalogue_manifests WHERE departure_id = $1", [d.id])).seat_count, 2);
  await db.query("UPDATE catalogue_departures SET status = 'completed' WHERE id = $1", [d.id]);
  await settle.runSettlementTick({});
  const bal = await one("SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance'", [d.id]);
  assert.equal(Number(bal.detail.operatorAmount), 1500 + 2 * 2200, "the 4–6 band plus 2 × the per-traveler amount");
  assert.equal(Number(bal.amount), 1500 + 2 * 2200 - 9800);
  const rec = await one("SELECT * FROM operator_receivables WHERE source_payable_id = $1", [bal.id]);
  assert.equal(Number(rec.amount_egp), 9800 - 5900, "the advance's excess is owed back");
  // Set off against the operator's next advance.
  const e = deps.e;
  for (let n = 0; n < 4; n++) await book(e, 2);
  await cat.runStatusJob({});
  const a2 = await asg.assignByAdmin(db, { departureId: e.id, operatorId: X, by: "ops" });
  await asg.acknowledge(db, { assignmentId: a2.id, operatorId: X, by: "dispatch" });
  const adv2 = await one("SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance'", [a2.id]);
  assert.equal(Number(adv2.setoff_egp), 3900);

  // Commission: agency B's seats were paid and traveled — earned.
  await comm.decideCommissions({});
  const c = await one("SELECT * FROM agency_commissions WHERE pledge_id = $1", [d.agencyB]);
  assert.deepEqual([c.state, Number(c.earned_eur)], ["earned", 20]);
});

// ---------------------------------------------------------------- refunds
test("refunds: full price × the tier's retained percentage, as an ops task, recorded with the amount", { skip }, async () => {
  const f = deps.f;
  f.p = await book(f, 1, { total: 100 });
  for (let n = 0; n < 2; n++) await book(f, 2);
  await cat.runStatusJob({});
  const now = Date.now();
  await tick(now);
  await link(f.p, now);
  await pay(f.p, now + HOUR);
  // Canceled 24 hours before the start: under v3, 10% of €100 is kept.
  const quote = await (await fetch(`${on}/api/admin/pay-at-goahead/bookings/${f.p}/cancellation-quote`, { headers: auth("staff-token") })).json();
  assert.equal(quote.quote.retainedPct, 0, "today: more than 48 hours out, nothing kept");
  const c = await pag.cancelPayAtGoAheadBooking(db, { pledgeId: f.p, reason: "traveler", by: "ops", now: startOf(f) - DAY });
  assert.deepEqual([c.tierVersion, c.retainedPct, c.fee, c.refund], [3, 10, 10, 90]);
  const refund = await one("SELECT * FROM payment_refunds WHERE pledge_id = $1", [f.p]);
  assert.deepEqual([refund.kind, Number(refund.paid_eur), Number(refund.fee_retained_eur), Number(refund.amount_eur), refund.state],
    ["cancellation", 100, 10, 90, "pending"]);
  const task = await one("SELECT * FROM payment_tasks WHERE refund_id = $1", [refund.id]);
  assert.match(task.title, /Refund €90 in Tab/);
  await assert.rejects(pag.completeRefund(db, { refundId: Number(refund.id), providerReference: "", by: "ops" }), /reference/);
  await pag.completeRefund(db, { refundId: Number(refund.id), providerReference: "TAB-R-1", by: "ops" });
  assert.equal((await one("SELECT state FROM payment_tasks WHERE id = $1", [task.id])).state, "done");
  // A package, under the tiers in the database: a €900 cruise canceled 20
  // days out keeps 12.5% under v1, 15% under v3.
  const v1 = await tiers.tierVersionById(db, 1);
  const t1 = tierAt(v1.rows, "cruise", 20 * 24);
  assert.deepEqual(refundFor({ paidEur: 900, priceEur: 900, retainedPct: t1.retainedPct }), { paid: 900, fee: 112.5, refund: 787.5 });
  const v3 = await tiers.tierVersionById(db, deps.v3);
  assert.equal(tierAt(v3.rows, "multi_day", 20 * 24).retainedPct, 15);
  // A booking canceled before payment owes nothing and gets no refund.
  const unpaid = (await db.query("SELECT id FROM pledges WHERE departure_id = $1 AND id <> $2 AND status <> 'cancelled' LIMIT 1", [f.legacy, f.p])).rows[0].id;
  const c2 = await pag.cancelPayAtGoAheadBooking(db, { pledgeId: unpaid, reason: "traveler", by: "ops" });
  assert.equal(c2.refundRecord, null);
  assert.equal((await reqOf(unpaid)).state, "cancelled");
});

// ---------------------------------------------------------------- waitlist
test("the waitlist: offers in order, expiry passes the seats on, a waitlisted booking pays now, and a resale before the cut-off returns the fee", { skip }, async () => {
  const g = deps.g;
  // Tiers with a fee before the cut-off (v4: 5% from 72 to 120 hours out), so a resale matters.
  const d4 = await tiers.createTierDraft(db, { by: "it" });
  const rows4 = [...d4.rows.filter((t) => t.productType !== "day_tour"),
    { productType: "day_tour", minBeforeHours: 120, unit: "hours", retainedPct: 0 },
    { productType: "day_tour", minBeforeHours: 72, unit: "hours", retainedPct: 5 },
    { productType: "day_tour", minBeforeHours: 0, unit: "hours", retainedPct: 10 }];
  await tiers.saveTierDraft(db, { versionId: d4.id, rows: rows4, by: "it" });
  await tiers.publishTierDraft(db, { versionId: d4.id, effectiveFrom: today(), by: "it" });
  const bookings = [];
  for (let n = 0; n < 6; n++) bookings.push(await book(g, 2));
  await cat.runStatusJob({});
  const join = (body) => fetch(`${on}/api/public/departures/${g.legacy}/waitlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const w1 = await join({ name: "First", email: "w1@example.test", seats: 2 });
  const w1Body = await w1.text();
  assert.equal(w1.status, 201, w1Body);
  assert.equal(JSON.parse(w1Body).waitlist.position, 1);
  await join({ name: "Second", email: "w2@example.test", seats: 2 });
  await join({ name: "Third", email: "w3@example.test", seats: 1 });
  assert.equal((await join({ name: "First", email: "w1@example.test", seats: 2 })).status, 409, "once");

  // The first booking pays, then cancels 96 hours out: 5% of €190 kept.
  const now = Date.now();
  await tick(now);
  await link(bookings[0], now);
  await pay(bookings[0], now);
  sent.length = 0;
  const at = startOf(g) - 96 * HOUR;
  const c = await pag.cancelPayAtGoAheadBooking(db, { pledgeId: bookings[0], reason: "traveler", by: "ops", now: at, send });
  assert.deepEqual([c.fee, c.refund], [9.5, 180.5]);
  let w = (await db.query("SELECT name, state FROM departure_waitlist WHERE departure_id = $1 ORDER BY id", [g.id])).rows;
  assert.deepEqual(w.map((x) => x.state), ["offered", "waiting", "waiting"], "first come, first offered");
  assert.ok(sent.some((m) => m.kind === "waitlist_offer" && m.to === "w1@example.test"));
  // The held seats aren't for general sale.
  const res = await fetch(`${on}/api/public/departures/${g.legacy}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Walk In", customerEmail: "walk@example.test", customerPhone: "+201001119999", seats: 1,
      travelerNames: ["Walk In"], pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true }) });
  assert.equal(res.status, 409);

  // The first doesn't take it: it expires and passes to the second.
  sent.length = 0;
  const expiry = new Date((await one("SELECT offer_expires_at FROM departure_waitlist WHERE email = 'w1@example.test'")).offer_expires_at).getTime();
  assert.equal(expiry, at + 12 * HOUR, "held 12 hours");
  assert.equal((await tick(expiry + MIN)).offersExpired, 1);
  w = (await db.query("SELECT state FROM departure_waitlist WHERE departure_id = $1 ORDER BY id", [g.id])).rows;
  assert.deepEqual(w.map((x) => x.state), ["expired", "offered", "waiting"]);
  const offerMail = sent.find((m) => m.kind === "waitlist_offer" && m.to === "w2@example.test");
  const token = offerMail.text.match(/\/waitlist\/([A-Za-z0-9_-]+)/)[1];
  const page = await (await fetch(`${on}/api/public/waitlist/${token}`)).json();
  assert.equal(page.offer.seats, 2);

  // The second books: asked to pay at once; the canceling traveler's fee is returned.
  const took = await fetch(`${on}/api/public/waitlist/${token}/book`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerPhone: "+201002223344", travelerNames: ["Second", "Second Two"], pickupPoint: "Zamalek", nationality: "German", safetyNone: true }) });
  const tookBody = await took.text();
  assert.equal(took.status, 201, tookBody);
  const code = JSON.parse(tookBody).booking.code;
  const np = await one("SELECT * FROM pledges WHERE booking_code = $1", [code]);
  assert.deepEqual([np.payment_mode, np.terms_fixed_by], ["pay_at_goahead", "traveller"]);
  assert.equal((await reqOf(np.id)).state, "awaiting_link", "a waitlisted booking goes straight to pay now");
  const resale = await one("SELECT * FROM payment_refunds WHERE pledge_id = $1 AND kind = 'resale'", [bookings[0]]);
  assert.equal(Number(resale.amount_eur), 9.5, "resold before the cut-off: the whole fee back");
  const back = await one("SELECT SUM(amount_eur) AS n FROM payment_refunds WHERE pledge_id = $1 AND state <> 'cancelled'", [bookings[0]]);
  assert.equal(Number(back.n), 190, "a full refund");

  // Another 2-seat booking cancels before paying: the third (1 seat) is
  // offered, and the other seat goes back on general sale.
  await pag.cancelPayAtGoAheadBooking(db, { pledgeId: bookings[1], reason: "traveler", by: "ops", now: at + 13 * HOUR, send });
  w = (await db.query("SELECT state FROM departure_waitlist WHERE departure_id = $1 ORDER BY id", [g.id])).rows;
  assert.deepEqual(w.map((x) => x.state), ["expired", "booked", "offered"]);
  const walkIn = await fetch(`${on}/api/public/departures/${g.legacy}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Walk In", customerEmail: "walk@example.test", customerPhone: "+201001119999", seats: 1,
      travelerNames: ["Walk In"], pickupPoint: "Mena House", nationality: "Brazilian", safetyNone: true }) });
  assert.equal(walkIn.status, 201, await walkIn.text());
});

// ---------------------------------------------------------------- admin and flag off
test("admin: the overview lists each departure's seats; the staff routes need staff", { skip }, async () => {
  const r = await fetch(`${on}/api/admin/pay-at-goahead`, { headers: auth("staff-token") });
  assert.equal(r.status, 200);
  const o = await r.json();
  const a = o.departures.find((d) => d.id === deps.a.id);
  assert.deepEqual([a.counts.paid, a.counts.released], [4, 2]);
  assert.deepEqual(o.settings, { windowHours: 48, offerHours: 12 });
  assert.equal((await fetch(`${on}/api/admin/pay-at-goahead`, { headers: auth("ag-a-token") })).status, 403);
  const s = await fetch(`${on}/api/admin/pay-at-goahead/settings`, { method: "PUT", headers: auth("staff-token"), body: JSON.stringify({ windowHours: 24, offerHours: 12 }) });
  assert.equal(s.status, 403, "super admin only");
  const s2 = await fetch(`${on}/api/admin/pay-at-goahead/settings`, { method: "PUT", headers: auth("ops-token"), body: JSON.stringify({ windowHours: 36, offerHours: 12 }) });
  assert.equal(s2.status, 422, "24 or 48");
});

test("with catalogue_v2 off a booking is on the deposit-and-balance flow and the phase 4 jobs do nothing", { skip }, async () => {
  const off = await startServer({ FEATURES: "" });
  const res = await fetch(`${off}/api/public/departures/${deps.h.legacy}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Legacy", customerEmail: "legacy@example.test", customerPhone: "+201001110000", seats: 1 }) });
  assert.equal(res.status, 201, await res.text());
  const p = await one("SELECT * FROM pledges WHERE departure_id = $1", [deps.h.legacy]);
  assert.deepEqual([p.payment_mode, p.cancellation_tier_version_id, p.terms_fixed_at], ["legacy_link", null, null]);
  const lookup = await (await fetch(`${off}/api/public/bookings/${p.booking_code}`)).json();
  assert.equal(lookup.booking.payAtGoAhead, null);
  assert.equal(lookup.booking.payment.stage, "not_due", "the legacy payment summary");
  assert.deepEqual(await jobs.runOperatorAssignments({ env: { FEATURES: "" }, log: () => {} }), { skipped: "catalogue_v2 is off" });
  for (const path of [`/api/public/departures/${deps.h.legacy}/waitlist`, `/api/public/bookings/${p.booking_code}/accept-terms`]) {
    assert.equal((await fetch(`${off}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404, path);
  }
  // A legacy booking never gets a request, whatever its date does.
  await tick(Date.now());
  assert.equal(await reqOf(p.id), undefined);
});

// ---------------------------------------------------------------- links never made (migration 052)
async function freshDeparture() {
  const used = Object.values(deps).filter((d) => d && d.id).map((d) => d.id);
  const r = (await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND date >= $2::date + 20 AND NOT (id = ANY($3::bigint[]))
      ORDER BY date LIMIT 1`, [productId, today(), used])).rows[0];
  const d = { id: Number(r.id), date: ymd(r.date), legacy: r.legacy_departure_id };
  deps[`x${d.id}`] = d;
  return d;
}
const summary = async () => (await fetch(`${on}/api/admin/pay-at-goahead/summary`, { headers: auth("staff-token") })).json();
const decide = (requestId, body) => fetch(`${on}/api/admin/pay-requests/${requestId}/decision`, { method: "POST", headers: auth("staff-token"), body: JSON.stringify(body) });

test("a link never made: alerts to ops and admin at 6 and 12 hours, a dashboard count, and a decision 24 hours before the cut-off; the seat is never released for it", { skip }, async () => {
  const d = await freshDeparture();
  d.short = await book(d, 1, { email: "short@example.test" });
  d.unsecured = await book(d, 1, { email: "unsecured@example.test" });
  d.cancel = await book(d, 1, { email: "cancel@example.test" });
  d.more = await book(d, 1);
  await cat.runStatusJob({});
  const t0 = Date.now();
  await tick(t0);
  const before = await summary();
  assert.ok(before.unlinkedSeats >= 4, JSON.stringify(before));
  sent.length = 0;
  assert.equal((await tick(t0 + 5 * HOUR)).linkAlerts6h, undefined, "not before 6 hours");
  const six = await tick(t0 + 6 * HOUR + MIN);
  assert.ok(six.linkAlerts6h >= 4);
  const firstAlerts = sent.filter((m) => m.kind === "pay_at_goahead_escalation_6h");
  assert.deepEqual(firstAlerts.map((m) => m.to).sort(), ["boss@sawa.test", "ops-alerts@sawa.test"], "ops and every super admin");
  assert.equal((await tick(t0 + 7 * HOUR)).linkAlerts6h, undefined, "once");
  sent.length = 0;
  const twelve = await tick(t0 + 12 * HOUR + MIN);
  assert.ok(twelve.linkAlerts12h >= 4);
  assert.ok(sent.some((m) => m.kind === "pay_at_goahead_escalation_12h" && /Second alert/.test(m.subject)));

  // 24 hours before the cut-off: each needs a decision. Nothing is released.
  sent.length = 0;
  const at = cutoffOf(d) - 24 * HOUR + MIN;
  const dec = await tick(at);
  assert.ok(dec.decisionsNeeded >= 4);
  assert.ok(sent.some((m) => m.kind === "pay_at_goahead_escalation_no_link"));
  const r = await reqOf(d.short);
  assert.deepEqual([r.state, r.decision_needed], ["awaiting_link", "no_link"]);
  assert.ok((await summary()).needsDecision >= 4);
  assert.equal((await tick(cutoffOf(d) - MIN)).released, 0, "an unlinked seat is never released");
  for (const id of [d.short, d.unsecured, d.cancel]) assert.equal((await one("SELECT status FROM pledges WHERE id = $1", [id])).status, "confirmed");
  d.decisionAt = at;
});

test("decision 1: send the link now with a short deadline; the release follows it", { skip }, async () => {
  const d = Object.values(deps).find((x) => x?.short);
  const r = await reqOf(d.short);
  assert.equal((await decide(r.id, { decision: "short_link", linkUrl: "https://pay.tab.travel/short" })).status, 422, "a reason is required");
  const tooLate = new Date(cutoffOf(d) + HOUR).toISOString();
  assert.equal((await decide(r.id, { decision: "short_link", reason: "Ops missed it", linkUrl: "https://pay.tab.travel/short", dueAt: tooLate })).status, 422, "not after the cut-off");
  sent.length = 0;
  const due = new Date(Date.now() + 6 * HOUR).toISOString();
  const res = await decide(r.id, { decision: "short_link", reason: "Ops missed the link; the traveler agreed on the phone", linkUrl: "https://pay.tab.travel/short", dueAt: due });
  assert.equal(res.status, 200, await res.text());
  const after = await reqOf(d.short);
  assert.deepEqual([after.state, after.due_bound_by, after.decision], ["sent", "decision", "short_link"]);
  assert.equal(new Date(after.due_at).toISOString(), due);
  const audit = await one("SELECT * FROM audit_log WHERE action = 'pay_request.decision' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.detail.reason, "Ops missed the link; the traveler agreed on the phone");
  assert.equal((await tick(Date.parse(due) + MIN)).released >= 1, true, "unpaid at the short deadline: released");
  assert.equal((await one("SELECT cancelled_reason FROM pledges WHERE id = $1", [d.short])).cancelled_reason, "unpaid");
});

test("decision 2: travel and collect later — an unsecured seat, never released, on the frozen manifest, paid afterwards", { skip }, async () => {
  const d = Object.values(deps).find((x) => x?.unsecured);
  const r = await reqOf(d.unsecured);
  const res = await decide(r.id, { decision: "travel_unsecured", reason: "Regular guest of the hotel; will pay the guide in cash" });
  assert.equal(res.status, 200, await res.text());
  assert.equal((await reqOf(d.unsecured)).state, "unsecured");
  assert.ok((await summary()).unsecured >= 1);
  await tick(cutoffOf(d) + MIN);
  await asg.freezeManifests({ db, now: cutoffOf(d) + MIN });
  const frozen = await one("SELECT * FROM catalogue_manifests WHERE departure_id = $1", [d.id]);
  const code = (await one("SELECT booking_code FROM pledges WHERE id = $1", [d.unsecured])).booking_code;
  assert.ok(frozen.travelers.some((t) => t.booking === code), "the unsecured traveler travels");
  const overview = await pag.payAtGoAheadOverview(db);
  const seat = overview.departures.find((x) => x.id === d.id).seats.find((s) => s.pledgeId === d.unsecured);
  assert.equal(seat.standing, "unsecured");
  await pay(d.unsecured);
  assert.equal((await reqOf(d.unsecured)).state, "paid", "collected later");
});

test("decision 3: cancel — nothing was charged, nothing refunded, and the traveler gets an apology", { skip }, async () => {
  const d = Object.values(deps).find((x) => x?.cancel);
  const r = await reqOf(d.cancel);
  sent.length = 0;
  const res = await decide(r.id, { decision: "cancel", reason: "No link was sent; traveler can't be reached" });
  assert.equal(res.status, 200, await res.text());
  const p = await one("SELECT status, cancelled_reason FROM pledges WHERE id = $1", [d.cancel]);
  assert.deepEqual([p.status, p.cancelled_reason], ["cancelled", "admin"]);
  assert.equal((await reqOf(d.cancel)).state, "cancelled");
  assert.equal(await one("SELECT 1 FROM payment_refunds WHERE pledge_id = $1", [d.cancel]), undefined, "nothing to refund");
  // The server started for the tests sends mail in log mode; the apology is
  // checked through the module, which takes the send function.
  const d2 = await freshDeparture();
  const ids = [await book(d2, 1, { email: "sorry@example.test" }), await book(d2, 3)];
  await cat.runStatusJob({});
  await tick(Date.now());
  const r2 = await reqOf(ids[0]);
  sent.length = 0;
  await pag.decideUnlinkedSeat(db, { requestId: Number(r2.id), decision: "cancel", reason: "Link never sent", by: "boss@sawa.test", send });
  const apology = sent.find((m) => m.kind === "pay_at_goahead_apology");
  assert.equal(apology.to, "sorry@example.test");
  assert.match(apology.text, /Nothing was charged/);
  deps.x2 = d2;
});

test("a link made too late (under 12 hours to pay) starts no deadline and goes to the same decision", { skip }, async () => {
  const d = await freshDeparture();
  const late = await book(d, 4, { email: "late@example.test" });
  await cat.runStatusJob({});
  await tick(Date.now());
  sent.length = 0;
  // Ops paste the link 10 hours before the cut-off: the traveler would have 10 hours.
  const out = await link(late, cutoffOf(d) - 10 * HOUR);
  assert.equal(out.heldForDecision, true);
  const r = await reqOf(late);
  assert.deepEqual([r.state, r.decision_needed, r.due_at], ["awaiting_link", "late_link", null], "no deadline started");
  assert.ok(r.link_url, "the link is kept");
  assert.ok(!sent.some((m) => m.to === "late@example.test"), "the traveler isn't sent a link they can't use");
  assert.ok(sent.some((m) => m.kind === "pay_at_goahead_escalation_late_link"));
  // The decision can reuse the link that was made.
  const due = new Date(cutoffOf(d) - 2 * HOUR).toISOString();
  await pag.decideUnlinkedSeat(db, { requestId: Number(r.id), decision: "short_link", reason: "Agreed with the traveler", dueAt: due, by: "ops", now: cutoffOf(d) - 9 * HOUR, send });
  const after = await reqOf(late);
  assert.deepEqual([after.state, after.link_url, new Date(after.due_at).toISOString()], ["sent", r.link_url, due]);
  // 12 hours or more is fine: a link 30 hours before the cut-off starts a deadline as usual.
  const d2 = await freshDeparture();
  const ok = await book(d2, 4);
  await cat.runStatusJob({});
  await tick(Date.now());
  const fine = await link(ok, cutoffOf(d2) - 30 * HOUR);
  assert.deepEqual([fine.state, fine.dueBoundBy], ["sent", "cutoff"]);
});

// ---------------------------------------------------------------- Terms versions (migration 052)
test("the Terms are versioned: catalog and legacy series; each booking records the version it accepted", { skip }, async () => {
  const legacy = await tiers.tierVersionById(db, 1);
  assert.ok(legacy);
  const v = (await (await fetch(`${on}/api/admin/terms-versions`, { headers: auth("staff-token") })).json());
  const cat1 = v.versions.find((x) => x.scope === "catalogue" && x.version === 1);
  const leg1 = v.versions.find((x) => x.scope === "legacy" && x.version === 1);
  assert.deepEqual([v.inForce.catalogue, v.inForce.legacy], [cat1.id, leg1.id]);
  // A catalog booking records the catalog version.
  const d = deps.a;
  assert.equal(Number((await one("SELECT terms_version_id FROM pledges WHERE id = $1", [d.ana])).terms_version_id), cat1.id);
  // A new catalog version: later bookings take it; earlier ones keep theirs.
  const draft = await (await fetch(`${on}/api/admin/terms-versions/draft`, { method: "POST", headers: auth("staff-token"), body: JSON.stringify({ scope: "catalogue" }) })).json();
  const saved = await fetch(`${on}/api/admin/terms-versions/${draft.version.id}`, { method: "PUT", headers: auth("staff-token"),
    body: JSON.stringify({ title: "Terms for catalog bookings", documentUrl: "/terms/catalogue", body: "Approved wording" }) });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal((await fetch(`${on}/api/admin/terms-versions/${draft.version.id}/publish`, { method: "POST", headers: auth("staff-token"), body: JSON.stringify({ effectiveFrom: today() }) })).status, 403, "super admin only");
  const pub = await fetch(`${on}/api/admin/terms-versions/${draft.version.id}/publish`, { method: "POST", headers: auth("ops-token"), body: JSON.stringify({ effectiveFrom: today() }) });
  assert.equal(pub.status, 200, await pub.text());
  await assert.rejects(db.query("UPDATE terms_versions SET body = 'x' WHERE id = $1", [draft.version.id]), /published/);
  const later = await book(deps.i, 1);
  assert.equal(Number((await one("SELECT terms_version_id FROM pledges WHERE id = $1", [later])).terms_version_id), draft.version.id);
  assert.equal(Number((await one("SELECT terms_version_id FROM pledges WHERE id = $1", [d.ana])).terms_version_id), cat1.id, "keeps the version it accepted");
  // An agency booking fixes it when the agency books, and the booking page shows it.
  const page = await (await fetch(`${on}/api/public/bookings/${(await one("SELECT booking_code FROM pledges WHERE id = $1", [deps.b.omar])).booking_code}`)).json();
  assert.equal(page.booking.payAtGoAhead.terms.document.version, 1);
  // A legacy booking records the legacy version.
  const legacyBooking = await one("SELECT terms_version_id FROM pledges WHERE departure_id = $1 AND payment_mode = 'legacy_link' LIMIT 1", [deps.h.legacy]);
  assert.equal(Number(legacyBooking.terms_version_id), leg1.id);
});

// ---------------------------------------------------------------- the seller and the collecting agent (27 Sep 2026)
test("seller disclosure: 'a licensed Sawa partner' before assignment; from it, the operator's legal name and licence as seller and the collecting agent as payee, on the request, receipt, voucher and booking page", { skip }, async () => {
  const { BRAND } = await import("./brand.js");
  const payee = `${BRAND.legalName}, collecting agent (${BRAND.agentLicense})`;
  await ops.updateOperator(db, X, { travellerLicenceNo: "TL-4471" });
  const d = await freshDeparture();
  const p = await book(d, 4, { email: "seller@example.test" });
  await cat.runStatusJob({});
  await tick(Date.now());
  sent.length = 0;
  await link(p, Date.now());
  const linkMail = sent.find((m) => m.kind === "pay_at_goahead_link");
  assert.match(linkMail.text, /Operated by a licensed Sawa partner\. Payee: /);
  assert.ok(linkMail.text.includes(`Payee: ${payee}.`));
  const code = (await one("SELECT booking_code FROM pledges WHERE id = $1", [p])).booking_code;
  let page = (await (await fetch(`${on}/api/public/bookings/${code}`)).json()).booking.payAtGoAhead;
  assert.deepEqual([page.seller, page.sellerLine, page.payee, page.voucher], [null, "Operated by a licensed Sawa partner", payee, null]);

  // Assigned: the operator is named from now on.
  await asg.assignByAdmin(db, { departureId: d.id, operatorId: X, by: "ops" });
  page = (await (await fetch(`${on}/api/public/bookings/${code}`)).json()).booking.payAtGoAhead;
  assert.equal(page.sellerLine, "Sold by Nile Tours S.A.E., license no. TL-4471");
  sent.length = 0;
  const r = await reqOf(p);
  const paid = await pag.markRequestPaid(db, { requestId: Number(r.id), providerReference: "TAB-SELLER", by: "ops", send });
  assert.match(paid.receipt.receiptNo, /^R-\d{4}-\d{6}$/);
  const receipt = sent.find((m) => m.kind === "pay_at_goahead_receipt");
  assert.ok(receipt.text.includes(`Issued by ${BRAND.legalName} (Commercial Registration ${BRAND.registrationNumber}, ${BRAND.agentLicense}), collecting agent, on behalf of Nile Tours S.A.E., license no. TL-4471.`), receipt.text);
  const stored = await reqOf(p);
  assert.deepEqual([stored.seller_legal_name, stored.seller_licence_no, stored.receipt_no], ["Nile Tours S.A.E.", "TL-4471", paid.receipt.receiptNo]);
  page = (await (await fetch(`${on}/api/public/bookings/${code}`)).json()).booking.payAtGoAhead;
  assert.deepEqual([page.voucher.bookingCode, page.voucher.seller, page.voucher.payee, page.voucher.receiptNo],
    [code, "Sold by Nile Tours S.A.E., license no. TL-4471", payee, paid.receipt.receiptNo]);
  // The reminder carries the same lines (another booking, still unpaid).
  const p2 = await book(d, 1, { email: "remind@example.test" });
  const now = Date.now();
  await tick(now);
  await link(p2, now);
  sent.length = 0;
  await tick(now + 24 * HOUR + MIN);
  const reminder = sent.find((m) => m.kind === "pay_at_goahead_reminder" && m.to === "remind@example.test");
  assert.ok(reminder.text.includes("Sold by Nile Tours S.A.E., license no. TL-4471.") && reminder.text.includes(`Payee: ${payee}.`), reminder.text);
});

test("the settlement statement distributes the collections: gross, payment costs, agency commission, the operator entitlement and the agent's commission", { skip }, async () => {
  const { BRAND } = await import("./brand.js");
  // Departure D (the guarantee test): 2 travelers paid €190, agency commission €20, entitlement 5,900 EGP.
  await fin.setFxRate(db, { day: deps.d.date, egpPerEur: 50, by: "it" });
  const f = await settle.departureDistribution(db, deps.d.id, { entitlementEgp: 5900 });
  assert.deepEqual([f.grossEur, f.agencyCommissionEur, f.entitlementEur, f.paymentCostsEur], [190, 20, 118, 0]);
  assert.equal(f.agentCommissionEur, 52, "190 − 20 − 118");
  assert.equal(f.guaranteeEur, 0);
  assert.equal(f.lines.at(-1).label, `${BRAND.legalName} commission`);
  // With a 3% fee and a higher rate, collections fall short: the guarantee.
  await fin.setFeeSetting(db, { percent: 3, fixedEur: 0, by: "it" });
  await fin.setFxRate(db, { day: deps.d.date, egpPerEur: 25, by: "it" });
  const g = await settle.departureDistribution(db, deps.d.id, { entitlementEgp: 5900 });
  assert.deepEqual([g.paymentCostsEur, g.entitlementEur, g.agentCommissionEur, g.guaranteeEur], [5.7, 236, 0, 71.7]);
  assert.ok(g.lines.some((l) => l.key === "minimum_departure_guarantee" && l.label === `Minimum Departure Guarantee, paid by ${BRAND.legalName}`));
  // The statement carries it, and so does its PDF.
  const st = await settle.statementFor(db, deps.d.id);
  assert.ok(st.snapshot.distribution, "the statement snapshot has the distribution");
  const { statementPdf } = await import("./pdf.js");
  const pdf = statementPdf({ ...st, snapshot: { ...st.snapshot, distribution: g } }).toString("latin1");
  assert.match(pdf, /Distribution of collections/);
  assert.match(pdf, /Minimum Departure Guarantee/);
  assert.ok(pdf.includes(`Sawa \\(${BRAND.legalName}\\)`), "the header names Sawa's operating company");
  assert.ok(!/Capital Travel/.test(pdf));
  await db.query("DELETE FROM finance_settings WHERE key = 'payment_fees'");
});

test("the Capital Travel Service operator record stays pending and can't be activated", { skip }, async () => {
  const cts = await ops.createOperator(db, { legalName: "Capital Travel Service" }, "it");
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env: { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" }, stdio: "pipe" });
  const op = await ops.getOperator(db, cts.id);
  assert.equal(op.status, "pending");
  assert.match(op.activationBlocked, /not involved in Sawa/);
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, cts.id, { kind, number: "1", expiresOn: shiftDate(today(), 400) }, { by: "it" });
  }
  await assert.rejects(ops.setOperatorStatus(db, cts.id, "active", { by: "it" }), /must not be activated/);
  assert.equal((await ops.getOperator(db, cts.id)).status, "pending");
});
