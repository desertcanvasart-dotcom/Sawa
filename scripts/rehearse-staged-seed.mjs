// DIR-16 — rehearse the staged seed against a throwaway database.
//
// Driven by scripts/rehearse-staged-seed.sh, which builds the cluster and
// applies the real schema. This side seeds the rehearsal fixture through the
// SAME transition the app uses (server/departure-status.js refreshStatus,
// inside the insert's transaction), then judges what it observes. It does not
// merely print state — it exits non-zero unless every expectation holds, so
// "the rehearsal passed" is an exit code, not a reading of its output.
//
// The fixture is data/bookings-rehearsal.json — TEST data, confirmed by the
// client 2026-08-11, untracked because its addresses may belong to real
// strangers. Absence is a refusal, not a pass: without a subject this script
// has nothing to observe (EEEE1 — zero rows is the absence of a subject).
//
// Nothing here can reach production: it refuses any DATABASE_URL that is not
// the rehearsal cluster on 127.0.0.1:55433.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REHEARSAL_URL_PREFIX = "postgres://sawa@127.0.0.1:55433/";
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith(REHEARSAL_URL_PREFIX)) {
  console.error("REFUSING: DATABASE_URL is not the rehearsal cluster on 127.0.0.1:55433.");
  console.error("Run this through scripts/rehearse-staged-seed.sh, never by hand against a real database.");
  process.exit(1);
}

const { pool, withTransaction } = await import(join(ROOT, "server", "db", "index.js"));
const { refreshStatus } = await import(join(ROOT, "server", "departure-status.js"));
const { auditRestatements, verdict } = await import(join(ROOT, "scripts", "check-seed-expiry.js"));

let fixture;
try {
  fixture = JSON.parse(await readFile(join(ROOT, "data", "bookings-rehearsal.json"), "utf8"));
} catch {
  console.error("REFUSING: data/bookings-rehearsal.json is not present — nothing to rehearse.");
  console.error("The fixture is untracked (it carries addresses). Rebuild it from the client's CSV first.");
  await pool.end();
  process.exit(1);
}

const stage = process.argv[2];
if (!["stage1", "remainder", "verify-stage1", "verify-full"].includes(stage)) {
  console.error("Usage: rehearse-staged-seed.mjs stage1|verify-stage1|remainder|verify-full");
  await pool.end();
  process.exit(1);
}

const stage1Row = fixture.stage1Scenario.row;
const entries = fixture.departures.map((e, i) => ({ ...e, depId: 999100 + i + 1 }));

// ---- seeding stages --------------------------------------------------------

const toSeed =
  stage === "stage1" ? entries.filter((e) => e.row === stage1Row)
  : stage === "remainder" ? entries.filter((e) => e.row !== stage1Row)
  : [];

for (const e of toSeed) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO tour_products (id, type, title, city, default_time, min_seats, max_seats,
         published_rate, deposit_percent)
       VALUES ($1,'day_tour',$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [e.tourProductId, e.title, e.city, e.time, e.minSeats, e.maxSeats,
       e.publishedRate, e.depositPercent ?? 10]
    );
    await c.query(
      `INSERT INTO departures (id, type, tour_product_id, route, date, time, city,
         min_seats, max_seats, published_rate, cutoff, status, deposit_percent)
       VALUES ($1,'day_tour',$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11)`,
      [e.depId, e.tourProductId, e.title, e.departureDate, e.time, e.city,
       e.minSeats, e.maxSeats, e.publishedRate, `${e.bookingCutoffHours}h`, e.depositPercent ?? 10]
    );
    await c.query(
      `INSERT INTO pledges (id, departure_id, agency_id, seats, customers, price_per_person,
         booking_total, paid, source, booking_code, customer_email, customer_phone, created_at)
       VALUES ($1,$2,'direct_customer',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [`plg_reh_${e.row}`, e.depId, e.pledge.seats,
       JSON.stringify([{ name: e.pledge.travellerName }]),
       e.pledge.pricePerPerson, e.pledge.bookingTotal, e.pledge.paid === true,
       "csv-import-rehearsal", `SAWA-RH${String(e.row).padStart(3, "0")}`,
       e.pledge.customerEmail, e.pledge.customerPhone, e.pledge.bookedOn]
    );
    // The real transition, in the same transaction — never a status computed here.
    await refreshStatus(c, e.depId);
  });
  console.log(`seeded #${e.depId}  row ${e.row}  ${e.pledge.travellerName}, ${e.pledge.seats} seat(s), paid=${e.pledge.paid}`);
}

// ---- verification stages ---------------------------------------------------

async function observe() {
  const deps = (await pool.query(
    `SELECT d.id, d.date::text AS date, d.status, d.min_seats,
            COALESCE(SUM(pl.seats) FILTER (WHERE pl.status <> 'cancelled'),0)::int AS seats
     FROM departures d LEFT JOIN pledges pl ON pl.departure_id = d.id
     GROUP BY d.id ORDER BY d.date`
  )).rows;
  const goaheads = (await pool.query(
    `SELECT entity_id FROM audit_log WHERE action='departure.goahead' ORDER BY entity_id`
  )).rows.map((r) => Number(r.entity_id));
  const emails = (await pool.query(`SELECT count(*)::int n FROM email_log`)).rows[0].n;
  const pledgeCount = (await pool.query(`SELECT count(*)::int n FROM pledges`)).rows[0].n;
  const paid = (await pool.query(
    `SELECT count(*)::int bookings, COALESCE(SUM(booking_total) FILTER (WHERE paid),0)::int received,
            COALESCE(SUM(booking_total) FILTER (WHERE NOT paid),0)::int outstanding
     FROM pledges`
  )).rows[0];
  return { deps, goaheads, emails, pledgeCount, paid };
}

function fail(msg) {
  console.error(`REHEARSAL FAILED: ${msg}`);
  return false;
}

if (stage === "verify-stage1" || stage === "verify-full") {
  const o = await observe();
  console.log("--- observed departure states (computed by refreshStatus, not by this script) ---");
  for (const d of o.deps) console.log(`#${d.id}  ${d.date}  seats ${d.seats}/${d.min_seats}  ${d.status}`);
  console.log(`GoAhead recorded for: ${o.goaheads.map((g) => "#" + g).join(", ") || "none"}`);
  console.log(`email_log rows: ${o.emails}`);
  console.log(`paid: $${o.paid.received} received, $${o.paid.outstanding} outstanding across ${o.paid.bookings} booking(s)`);

  let ok = true;
  const expectForming = entries.filter((e) => e.pledge.seats < e.minSeats);
  const expectConfirmed = entries.filter((e) => e.pledge.seats >= e.minSeats);

  if (stage === "verify-stage1") {
    if (o.deps.length !== 1) ok = fail(`expected exactly 1 departure after stage 1, found ${o.deps.length}`);
    else if (o.deps[0].status !== "open") ok = fail(`stage-1 departure is '${o.deps[0].status}', expected forming ('open')`);
    if (o.goaheads.length !== 0) ok = fail("a below-minimum departure recorded a GoAhead");
  } else {
    const open = o.deps.filter((d) => d.status === "open").length;
    const confirmed = o.deps.filter((d) => d.status === "minimum_reached").length;
    if (o.deps.length !== entries.length) ok = fail(`expected ${entries.length} departures, found ${o.deps.length}`);
    if (open !== expectForming.length) ok = fail(`expected ${expectForming.length} forming, found ${open}`);
    if (confirmed !== expectConfirmed.length) ok = fail(`expected ${expectConfirmed.length} at minimum, found ${confirmed}`);
    const expectedGA = expectConfirmed.map((e) => e.depId).sort();
    if (JSON.stringify(o.goaheads) !== JSON.stringify(expectedGA))
      ok = fail(`GoAhead rows ${JSON.stringify(o.goaheads)} != departures at minimum ${JSON.stringify(expectedGA)}`);
  }
  if (o.emails !== 0) ok = fail(`email_log holds ${o.emails} row(s) — a rehearsal must send nothing`);

  // The seed's one guaranteed side effect: check:seed-expiry must go red the
  // moment pledges holds a row, naming the four E-2 claims. A rehearsal where
  // it stayed green would mean the check cannot notice the thing it watches.
  const v = verdict({ pledgeCount: o.pledgeCount, restatements: auditRestatements() });
  console.log(`check:seed-expiry against the rehearsal DB: state=${v.state}`);
  if (v.state !== "ENDED" || v.pass !== false)
    ok = fail(`check:seed-expiry read '${v.state}' over ${o.pledgeCount} pledge row(s) — expected a red ENDED`);

  await pool.end();
  if (!ok) process.exit(1);
  console.log(`VERIFIED: ${stage === "verify-stage1" ? "stage 1 — one forming departure, nothing confirmed, nothing sent" : "full load — every expectation held"}.`);
  process.exit(0);
}

await pool.end();
