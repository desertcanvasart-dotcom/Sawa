// Model phase 2 on a real Postgres: operators and their documents, the roster,
// the rate card, assignment at GoAhead, the manifest, strikes, and parity with
// catalogue_v2 off. Skips without TEST_DATABASE_URL (see test-db.js).
//
// The tests share one database and run in order: each builds on the state the
// one before it left.
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
import { ACK_HOURS } from "../shared/operators.js";
import { datesInMonth } from "../shared/operators.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_operators";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const GIZA = "tour_giza_pyramids_sphinx_the_grand_e_mq41k335";
const MEMPHIS = "tour_memphis_saqqara_dahshur_birth_of_mq41k505";

const USERS = {
  "ops-token": { id: "00000000-0000-4000-8000-000000000051", email: "ops@sawa.test", role: "super_admin" },
  "op-a-token": { id: "00000000-0000-4000-8000-000000000052", email: "owner@op-a.test", role: "operator_owner" },
};

let db, dbUrl, fakeAuth, servers = [];
let cat, ops, roster, rates, asg, jobs;
let productId, A, B, C;
const deps = {};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const sent = [];
const send = async (m) => { sent.push(m); return { ok: true }; };

async function startServer(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 900);
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
  for (const [id, title] of [[GIZA, "Giza Pyramids, Sphinx & the Grand Egyptian Museum"], [MEMPHIS, "Memphis, Saqqara & Dahshur — Birth of the Pyramid"]]) {
    await db.query(
      `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats, published_rate, break_price, status, active,
                                  booking_cutoff_hours, included, not_included)
       VALUES ($1,'day_tour',$2,'Cairo','08:00',4,12,100,80,'approved',true,24,'["Guide"]','["Tips"]')`, [id, title]);
  }
  // Capital Travel Service exists before 049's mapping runs again, the way
  // production has it.
  await db.query("INSERT INTO agencies (id, name) VALUES ('ag_cts', 'Capital Travel Service')");
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  const admin = USERS["ops-token"];
  await db.query("INSERT INTO app_users (id, email, role) VALUES ($1, $2, $3)", [admin.id, admin.email, admin.role]);

  process.env.DATABASE_URL = dbUrl;
  process.env.PGSSL = "false";
  process.env.FEATURES = "catalogue_v2";
  process.env.EMAIL_REPLY_TO = "ops-alerts@sawa.test";
  cat = await import("./catalogue.js");
  ops = await import("./operators.js");
  roster = await import("./roster.js");
  rates = await import("./rates.js");
  asg = await import("./assignments.js");
  jobs = await import("./jobs/operator-jobs.js");

  productId = Number((await db.query("SELECT id FROM catalogue_products WHERE catalogue_no = 1")).rows[0].id);
  const draft = (await db.query("SELECT id FROM catalogue_spec_versions WHERE product_id = $1 AND state = 'draft'", [productId])).rows[0].id;
  await cat.publishDraft({ productId, versionId: Number(draft), by: "it" });
  await db.query("UPDATE catalogue_products SET needs_nationality = true WHERE id = $1", [productId]);
  await cat.generateDepartures({ materialise: true });

  // Three bookable departures in one month, at least three weeks out.
  const month = shiftDate(today(), 45).slice(0, 7);
  const r = await db.query(
    `SELECT id, date, legacy_departure_id FROM catalogue_departures
      WHERE product_id = $1 AND legacy_departure_id IS NOT NULL AND status = 'open' AND to_char(date, 'YYYY-MM') = $2
      ORDER BY date LIMIT 4`, [productId, month]);
  assert.ok(r.rows.length >= 4, `need four departures in ${month}, got ${r.rows.length}`);
  [deps.main, deps.unrostered, deps.swapped, deps.later] = r.rows.map((x) => ({ id: Number(x.id), date: ymd(x.date), legacy: x.legacy_departure_id }));
  deps.month = month;
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

async function pledge(legacyId, seats, extra = {}) {
  const id = `pl_op_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(
    `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, customer_phone, status, source,
                          pickup_point, nationality, safety_needs, traveller_names)
     VALUES ($1,$2,'direct_customer','Direct',$3,$4,'t@example.test','+201000000000','confirmed','public',$5,$6,$7,$8)`,
    [id, legacyId, seats, extra.name || "Lead Traveler", extra.pickup || "Mena House", extra.nationality || null,
      extra.safety || null, JSON.stringify(extra.names || [])]);
  return id;
}
const fullDocs = async (operatorId, expiresOn = shiftDate(today(), 365)) => {
  for (const kind of ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"]) {
    await ops.addDocument(db, operatorId, { kind, number: `${kind}-1`, expiresOn }, { by: "it" });
  }
};
const cutoffOf = async (dep) => {
  const hours = Number((await db.query("SELECT cutoff_hours FROM catalogue_products WHERE id = $1", [productId])).rows[0].cutoff_hours);
  return zonedDateTimeToUtc(dep.date, "08:00") - hours * HOUR;
};

// ---------------------------------------------------------------- operators
test("migration 049 maps Capital Travel Service to a pending operator like any other", { skip }, async () => {
  // Truncated in before(); the mapping ran on the second migrate.
  const r = await db.query("SELECT * FROM operators WHERE agency_id = 'ag_cts'");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].status, "pending");
});

test("an operator is activated only with four current documents; an expired one suspends it and it can't be rostered", { skip }, async () => {
  A = (await ops.createOperator(db, { legalName: "Operator A", email: "dispatch@op-a.test" }, "it")).id;
  B = (await ops.createOperator(db, { legalName: "Operator B", email: "dispatch@op-b.test" }, "it")).id;
  C = (await ops.createOperator(db, { legalName: "Operator C", email: "dispatch@op-c.test" }, "it")).id;
  await assert.rejects(ops.setOperatorStatus(db, A, "active", { by: "it" }), /before activating/);
  for (const id of [A, B, C]) {
    await fullDocs(id);
    await ops.setApprovals(db, id, [productId], "it");
    assert.equal((await ops.setOperatorStatus(db, id, "active", { by: "it" })).status, "active");
  }
  assert.deepEqual(await ops.rosterEligibility(db, C, productId), { ok: true });

  // C's liability insurance lapses yesterday; its vehicle insurance is 30 days out.
  await db.query("UPDATE operator_documents SET expires_on = $2 WHERE operator_id = $1 AND kind = 'liability_insurance' AND superseded_at IS NULL", [C, shiftDate(today(), -1)]);
  await db.query("UPDATE operator_documents SET expires_on = $2 WHERE operator_id = $1 AND kind = 'vehicle_insurance' AND superseded_at IS NULL", [C, shiftDate(today(), 30)]);
  sent.length = 0;
  const run = await ops.runDocumentJob({ db, send, adminEmail: "ops-alerts@sawa.test" });
  assert.equal(run.suspended, 1);
  const c = await ops.getOperator(db, C);
  assert.equal(c.status, "suspended");
  assert.equal(c.statusReason, "document_expired:liability_insurance");
  assert.equal((await ops.rosterEligibility(db, C, productId)).ok, false);
  await assert.rejects(roster.setPlanLine(db, { month: deps.month, productId, weekday: 1, operatorId: C }), /only active operators/);

  // Suspended operators aren't reminded; an active one is, 30 days out, once.
  await db.query("UPDATE operator_documents SET expires_on = $2 WHERE operator_id = $1 AND kind = 'vehicle_insurance' AND superseded_at IS NULL", [A, shiftDate(today(), 30)]);
  sent.length = 0;
  const reminders = await ops.runDocumentJob({ db, send, adminEmail: "ops-alerts@sawa.test" });
  assert.equal(reminders.reminders, 2, JSON.stringify(reminders));
  assert.deepEqual(sent.map((m) => m.to).sort(), ["dispatch@op-a.test", "ops-alerts@sawa.test"]);
  assert.match(sent[0].subject, /Vehicle insurance/i);
  assert.equal((await ops.runDocumentJob({ db, send, adminEmail: "ops-alerts@sawa.test" })).reminders, 0, "once per document and recipient");

  // A valid replacement reactivates C.
  const replaced = await ops.addDocument(db, C, { kind: "liability_insurance", number: "L-2", expiresOn: shiftDate(today(), 365) }, { by: "it" });
  assert.equal(replaced.reactivated, true);
  assert.equal((await ops.getOperator(db, C)).status, "active");
  // An operator suspended by an admin is not reactivated by an upload.
  await ops.setOperatorStatus(db, C, "suspended", { by: "it", reason: "service review" });
  assert.equal((await ops.addDocument(db, C, { kind: "etaa_membership", number: "E-2", expiresOn: shiftDate(today(), 365) }, { by: "it" })).reactivated, false);
  assert.equal((await ops.getOperator(db, C)).status, "suspended");
});

// ---------------------------------------------------------------- roster
test("a month is planned by weekday, built, published; swaps need an admin; unrostered departures are flagged", { skip }, async () => {
  for (let wd = 0; wd < 7; wd++) await roster.setPlanLine(db, { month: deps.month, productId, weekday: wd, operatorId: B });
  const built = await roster.buildMonth(db, deps.month, "it");
  assert.ok(built.written >= 4, JSON.stringify(built));
  // One date to nobody, which the calendar must flag.
  await roster.overrideEntry(db, { productId, date: deps.unrostered.date, operatorId: null, by: "it" });

  // Unpublished: operators see nothing and nothing is assignable.
  assert.equal((await roster.operatorRoster(db, B)).length, 0);
  assert.equal(await roster.rosteredOperator(db, productId, deps.main.date), null);

  const pub = await roster.publishMonth(db, deps.month, { by: "ops@sawa.test" });
  assert.equal(pub.deadline, `${shiftDate(`${deps.month}-01`, -1).slice(0, 7)}-15`);
  const mine = await roster.operatorRoster(db, B);
  assert.ok(mine.some((e) => e.date === deps.main.date));
  assert.ok(!mine.some((e) => e.date === deps.unrostered.date));
  assert.equal((await roster.operatorRoster(db, A)).length, 0, "A sees none of B's dates");

  // B asks to hand one date to A; only an admin's approval moves it.
  const entry = (await db.query("SELECT id FROM roster_entries WHERE product_id = $1 AND date = $2", [productId, deps.swapped.date])).rows[0];
  await assert.rejects(roster.requestSwap(db, { entryId: Number(entry.id), fromOperatorId: A, toOperatorId: C, by: "a" }), /isn't on your roster/);
  await assert.rejects(roster.requestSwap(db, { entryId: Number(entry.id), fromOperatorId: B, toOperatorId: C, by: "b" }), /only active/);
  const swap = await roster.requestSwap(db, { entryId: Number(entry.id), fromOperatorId: B, toOperatorId: A, note: "vehicle in service", by: "dispatch@op-b.test" });
  assert.equal((await roster.rosteredOperator(db, productId, deps.swapped.date)).operatorId, B, "not moved until approved");
  const decided = await roster.decideSwap(db, { swapId: swap.id, approve: true, by: "ops@sawa.test" });
  assert.equal(decided.state, "approved");
  assert.equal(decided.decidedBy, "ops@sawa.test");
  const moved = (await db.query("SELECT operator_id, source FROM roster_entries WHERE id = $1", [entry.id])).rows[0];
  assert.equal(Number(moved.operator_id), A);
  assert.equal(moved.source, "swap");

  const flagged = await roster.unrosteredDepartures(db, { from: `${deps.month}-01`, to: datesInMonth(deps.month).pop() });
  assert.ok(flagged.has(deps.unrostered.id));
  assert.ok(!flagged.has(deps.main.id));
});

// ---------------------------------------------------------------- rates
test("the rate card imports as drafts without its EXAMPLE rows; a version locks at first seat; a new one leaves it alone", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const imported = await rates.importRateCard({ db, buffer: readFileSync(join(ROOT, "docs", "model", "sawa-rate-card.xlsx")), by: "it" });
  assert.equal(imported.skipped.filter((s) => s.reason === "EXAMPLE row").length, 2);
  assert.ok(imported.imported.some((r) => r.productId === productId));
  assert.ok(imported.problems.every((p) => !/EXAMPLE/i.test(p)));
  // The card's amounts are blank, so the draft can't be published as is.
  const draft = (await rates.ratesFor(db, productId)).find((v) => v.state === "draft");
  await assert.rejects(rates.publishRate({ productId, versionId: draft.id, by: "it" }), /Fill in every rate/);

  await rates.saveRateDraft(db, productId, { perTraveler: 40, fee4_6: 150, fee7_9: 200, fee10_12: 260 }, { by: "it" });
  const v1 = await rates.publishRate({ productId, versionId: draft.id, by: "it" });
  assert.equal(v1.currency, "EGP");
  await assert.rejects(db.query("UPDATE catalogue_rate_versions SET per_traveler = 1 WHERE id = $1", [v1.id]), /published/i);

  await pledge(deps.main.legacy, 2, { name: "Ana Lima", names: ["Ana Lima", "Bo Lima"], nationality: "Brazilian", safety: "nut allergy" });
  const locked = (await db.query("SELECT rate_version_id, spec_version_id FROM catalogue_departures WHERE id = $1", [deps.main.id])).rows[0];
  assert.equal(Number(locked.rate_version_id), v1.id, "locked at the first seat");
  assert.ok(locked.spec_version_id, "the spec in force is locked too");

  const v2draft = await rates.saveRateDraft(db, productId, { perTraveler: 55 }, { by: "it" });
  const v2 = await rates.publishRate({ productId, versionId: v2draft.id, by: "it" });
  assert.equal(v2.version, v1.version + 1);
  await pledge(deps.main.legacy, 2, { name: "Cy Ode" });
  await rates.lockRatesForSoldDepartures(db, Date.now() + 5 * DAY);
  assert.equal(Number((await db.query("SELECT rate_version_id FROM catalogue_departures WHERE id = $1", [deps.main.id])).rows[0].rate_version_id), v1.id,
    "a new version doesn't touch a departure already sold");
  await pledge(deps.later.legacy, 1);
  assert.equal(Number((await db.query("SELECT rate_version_id FROM catalogue_departures WHERE id = $1", [deps.later.id])).rows[0].rate_version_id), v2.id,
    "a departure first sold now takes the new version");
});

// ---------------------------------------------------------------- assignment
test("GoAhead assigns the rostered operator, who is notified; a missed acknowledgement is a strike and an admin reassigns", { skip }, async () => {
  await pledge(deps.main.legacy, 2, { name: "Di Ek" });
  await pledge(deps.main.legacy, 2, { name: "Ed Fo" });   // 8 seats
  await cat.runStatusJob({});
  assert.equal((await db.query("SELECT status FROM catalogue_departures WHERE id = $1", [deps.main.id])).rows[0].status, "go_ahead");
  // The unrostered departure goes ahead too.
  await pledge(deps.unrostered.legacy, 4);
  await cat.runStatusJob({});

  sent.length = 0;
  const now = Date.now();
  const tick = await asg.runAssignmentTick({ db, now, send });
  assert.equal(tick.assigned, 1, JSON.stringify(tick));
  assert.equal(tick.alerted, 1);
  const a = (await db.query("SELECT * FROM catalogue_assignments WHERE departure_id = $1", [deps.main.id])).rows[0];
  assert.equal(Number(a.operator_id), B);
  assert.equal(a.state, "offered");
  assert.equal(new Date(a.ack_due_at).getTime(), now + ACK_HOURS * HOUR, "4 hours to acknowledge");
  const note = (await db.query("SELECT * FROM operator_notifications WHERE operator_id = $1 AND kind = 'assignment'", [B])).rows[0];
  assert.match(note.body, /specification v1/);
  assert.match(note.body, /8 seats sold/);
  assert.ok(note.emailed_at, "emailed as well");
  const email = sent.find((m) => m.to === "dispatch@op-b.test");
  assert.match(email.subject, /Giza/);
  assert.match(email.text, /8/);
  const alert = (await db.query("SELECT * FROM catalogue_admin_alerts WHERE departure_id = $1", [deps.unrostered.id])).rows[0];
  assert.equal(alert.kind, "no_rostered_operator");
  assert.ok(sent.some((m) => m.to === "ops-alerts@sawa.test"), "the admin is emailed");
  // Once per GoAhead.
  assert.equal((await asg.runAssignmentTick({ db, now, send })).assigned, 0);

  // Past the 4 hours: B can no longer acknowledge; a strike, a notice, an alert.
  await assert.rejects(asg.acknowledge(db, { assignmentId: Number(a.id), operatorId: B, by: "b", now: now + (ACK_HOURS + 1) * HOUR }), /time to acknowledge has passed/);
  const late = await asg.expireAcknowledgements({ db, now: now + (ACK_HOURS + 1) * HOUR, send });
  assert.equal(late.expired, 1);
  const strikes = await ops.strikesFor(db, B);
  assert.equal(strikes.filter((s) => s.kind === "missed_acknowledgement").length, 1);
  assert.equal((await asg.expireAcknowledgements({ db, now: now + (ACK_HOURS + 2) * HOUR, send })).expired, 0);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM catalogue_admin_alerts WHERE departure_id = $1 AND kind = 'missed_acknowledgement' AND resolved_at IS NULL", [deps.main.id])).rows[0].n, 1);

  // The admin reassigns to A; the alerts close; A acknowledges in time.
  await assert.rejects(asg.assignByAdmin(db, { departureId: deps.main.id, operatorId: C, by: "ops" }), /suspended/);
  const re = await asg.assignByAdmin(db, { departureId: deps.main.id, operatorId: A, by: "ops@sawa.test", now: now + (ACK_HOURS + 2) * HOUR, send });
  assert.equal(re.source, "admin");
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM catalogue_admin_alerts WHERE departure_id = $1 AND resolved_at IS NULL", [deps.main.id])).rows[0].n, 0);
  await assert.rejects(asg.acknowledge(db, { assignmentId: re.id, operatorId: B, by: "b", now: now + (ACK_HOURS + 2) * HOUR }), /not found/);
  assert.equal((await asg.acknowledge(db, { assignmentId: re.id, operatorId: A, by: "a", now: now + (ACK_HOURS + 3) * HOUR })).state, "acknowledged");

  // Two more strikes put B at three in 90 days: flagged for fewer days.
  await ops.addStrike(db, { operatorId: B, kind: "shopping_stop", note: "unscheduled stop", by: "ops" });
  await ops.addStrike(db, { operatorId: B, kind: "service_failure", note: "late pickup", by: "ops" });
  const listed = (await ops.listOperators(db)).find((o) => o.id === B);
  assert.equal(listed.strikes90, 3);
});

// ---------------------------------------------------------------- manifest
test("the manifest is live until the cut-off, then frozen; the expected amount follows the worked examples", { skip }, async () => {
  // 8 travelers at 40 plus the 7–9 fee of 200.
  let e = await asg.expectedAmountFor(db, deps.main.id);
  assert.equal(e.travelers, 8);
  assert.equal(e.total, 520);
  // Two cancel before the cut-off: 6 at 40 plus the 4–6 fee of 150.
  const two = (await db.query("SELECT id FROM pledges WHERE departure_id = $1 AND customers = 'Di Ek'", [deps.main.legacy])).rows[0].id;
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [two]);
  e = await asg.expectedAmountFor(db, deps.main.id);
  assert.equal(e.total, 390);
  assert.equal(e.frozen, false);
  await db.query("UPDATE pledges SET status = 'confirmed' WHERE id = $1", [two]);

  const live = await asg.manifestFor(db, { departureId: deps.main.id, operatorId: A, user: { id: USERS["op-a-token"].id, email: "owner@op-a.test" } });
  assert.equal(live.frozen, false);
  assert.equal(live.seatCount, 8);
  const ana = live.travelers.find((t) => t.name === "Ana Lima");
  assert.equal(ana.nationality, "Brazilian", "asked for where the product needs it");
  assert.equal(ana.safetyNeeds, "nut allergy");
  assert.equal(ana.pickupPoint, "Mena House");
  assert.equal(ana.contactNumber, "+201000000000");
  assert.ok(live.travelers.some((t) => t.name === "Bo Lima"), "a named second traveler");
  assert.ok(!JSON.stringify(live).includes("t@example.test"), "no traveler email on a manifest");

  // Another operator, including the one it was taken from, sees nothing.
  await assert.rejects(asg.manifestFor(db, { departureId: deps.main.id, operatorId: B }), /isn't assigned to you/);
  await assert.rejects(asg.manifestFor(db, { departureId: deps.main.id, operatorId: C }), /isn't assigned to you/);

  // Frozen at the cut-off; two cancel after it and the amount stays at 520.
  const cutoff = await cutoffOf(deps.main);
  assert.equal((await asg.freezeManifests({ db, now: cutoff - 60000 })).frozen, 0);
  assert.equal((await asg.freezeManifests({ db, now: cutoff + 60000 })).frozen, 1);
  await db.query("UPDATE pledges SET status = 'cancelled' WHERE id = $1", [two]);
  e = await asg.expectedAmountFor(db, deps.main.id);
  assert.equal(e.frozen, true);
  assert.equal(e.total, 520);
  const frozen = await asg.manifestFor(db, { departureId: deps.main.id, operatorId: A, user: { id: USERS["op-a-token"].id, email: "owner@op-a.test" } });
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.seatCount, 8);

  const views = (await db.query("SELECT * FROM manifest_access_log WHERE departure_id = $1 ORDER BY id", [deps.main.id])).rows;
  assert.equal(views.length, 2, "every operator view is logged");
  assert.deepEqual(views.map((v) => v.frozen), [false, true]);

  // Access ends 90 days after the departure.
  const tooSoon = await asg.revokeExpiredManifestAccess({ db, now: zonedDateTimeToUtc(shiftDate(deps.main.date, 89), "12:00") });
  assert.equal(tooSoon.revoked, 0);
  const revoked = await asg.revokeExpiredManifestAccess({ db, now: zonedDateTimeToUtc(shiftDate(deps.main.date, 91), "12:00") });
  assert.ok(revoked.revoked >= 1);
  await assert.rejects(asg.manifestFor(db, { departureId: deps.main.id, operatorId: A }), /ended 90 days after/);
  // Sawa keeps its own view.
  assert.equal((await asg.manifestFor(db, { departureId: deps.main.id })).seatCount, 8);
});

// ---------------------------------------------------------------- flag off
test("with catalogue_v2 off the jobs do nothing, the operator portal is not there and booking fields are ignored", { skip }, async () => {
  const OFF = { FEATURES: "" };
  assert.deepEqual(await jobs.runOperatorAssignments({ env: OFF, log: () => {} }), { skipped: "catalogue_v2 is off" });
  assert.deepEqual(await jobs.runOperatorDaily({ env: OFF, log: () => {} }), { skipped: "catalogue_v2 is off" });

  const opUser = USERS["op-a-token"];
  await db.query("INSERT INTO app_users (id, email, role, operator_id) VALUES ($1, $2, $3, $4)", [opUser.id, opUser.email, opUser.role, A]);
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
  const legacy = deps.swapped.legacy;
  const book = (base, name) => fetch(`${base}/api/public/departures/${legacy}/bookings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: name, customerEmail: `${name.toLowerCase()}@example.test`, seats: 1, customerPhone: "+201001112233",
      pickupPoint: "Marriott Zamalek", nationality: "Canadian", safetyNeeds: "wheelchair", travelerNames: [name] }),
  });

  const off = await startServer({ FEATURES: "" });
  assert.equal((await fetch(`${off}/api/operator/me`, { headers: auth("op-a-token") })).status, 404);
  assert.equal((await fetch(`${off}/api/operator/assignments`, { headers: auth("op-a-token") })).status, 404);
  const b1 = await book(off, "Offa");
  assert.equal(b1.status, 201, await b1.text());
  const p1 = (await db.query("SELECT pickup_point, nationality, safety_needs, traveller_names FROM pledges WHERE customers = 'Offa'")).rows[0];
  assert.deepEqual([p1.pickup_point, p1.nationality, p1.safety_needs, p1.traveller_names], [null, null, null, []]);
  // An admin screen for phase 2 answers: the admin tools work with the flag off,
  // as phase 1's do. The strike flag shows on the roster screen.
  const rosterRes = await fetch(`${off}/api/admin/roster?month=${deps.month}`, { headers: auth("ops-token") });
  assert.equal(rosterRes.status, 200);
  const rosterBody = await rosterRes.json();
  assert.equal(rosterBody.operators.find((o) => o.id === B).flagged, true);
  assert.equal(rosterBody.operators.find((o) => o.id === A).flagged, false);
  // Nobody but staff reaches them.
  assert.equal((await fetch(`${off}/api/admin/operators`, { headers: auth("op-a-token") })).status, 403);

  const on = await startServer({ FEATURES: "catalogue_v2" });
  const me = await fetch(`${on}/api/operator/me`, { headers: auth("op-a-token") });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).operator.id, A);
  const mine = await (await fetch(`${on}/api/operator/assignments`, { headers: auth("op-a-token") })).json();
  assert.ok(mine.assignments.every((x) => x.operatorId === A));
  assert.ok(mine.assignments.some((x) => x.departureId === deps.main.id));
  // Another operator's departure: not found.
  assert.equal((await fetch(`${on}/api/operator/departures/${deps.unrostered.id}/manifest`, { headers: auth("op-a-token") })).status, 404);
  const b2 = await book(on, "Onna");
  assert.equal(b2.status, 201, await b2.text());
  const p2 = (await db.query("SELECT pickup_point, nationality, safety_needs, traveller_names FROM pledges WHERE customers = 'Onna'")).rows[0];
  assert.deepEqual([p2.pickup_point, p2.nationality, p2.safety_needs, p2.traveller_names], ["Marriott Zamalek", "Canadian", "wheelchair", ["Onna"]]);
});
