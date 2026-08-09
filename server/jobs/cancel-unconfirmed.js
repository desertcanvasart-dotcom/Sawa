// Cancels departures that never reached their minimum by the GoAhead deadline,
// and tells everyone holding a seat.
//
// This is the mechanism behind a promise the booking conditions and the GoAhead
// page have both always made: "if a departure does not reach its minimum of
// four travelers by its deadline, it is cancelled automatically and you pay
// nothing". Until this existed, nothing cancelled anything — an unfilled date
// sat at `open` until its departure day passed and the travellers holding seats
// were never told.
//
// Run: npm run job:cancel-unconfirmed        (Railway cron, daily)
// Dry run: DRY_RUN=1 npm run job:cancel-unconfirmed
//
// Safe to run repeatedly and to run concurrently: each departure is re-read
// FOR UPDATE inside its own transaction and re-checked against the rule, so a
// second runner finds it already cancelled and skips it.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool, withTransaction } from "../db/index.js";
import { mapDeparture, mapProduct } from "../db/mappers.js";
import { missedConfirmDeadline, confirmDeadlineAt, seatsTotal, goAheadSeatsFor } from "../domain.js";
import { sendEmail, cancellationEmail } from "../email.js";

const DRY_RUN = process.env.DRY_RUN === "1";

function dateLabel(dep) {
  const start = dep.startDate || dep.date;
  return dep.endDate && dep.endDate !== start ? `${start} – ${dep.endDate}` : start;
}

async function loadCandidates() {
  // Only `open` dates can qualify — see missedConfirmDeadline. Narrowing here
  // as well keeps the scan off the whole table.
  const deps = await pool.query("SELECT * FROM departures WHERE status = 'open'");
  const products = await pool.query("SELECT * FROM tour_products");
  const byId = new Map(products.rows.map((p) => [p.id, mapProduct(p)]));
  const out = [];
  for (const row of deps.rows) {
    const pledges = await pool.query(
      "SELECT * FROM pledges WHERE departure_id = $1",
      [row.id]
    );
    const dep = mapDeparture(row, pledges.rows);
    const product = byId.get(row.tour_product_id) || null;
    if (missedConfirmDeadline(dep, product)) out.push({ dep, product });
  }
  return out;
}

async function cancelOne({ dep, product }) {
  return withTransaction(async (c) => {
    // Re-read under a lock and re-check: between the scan and here, someone may
    // have booked the seat that would have confirmed it.
    const fresh = await c.query("SELECT * FROM departures WHERE id = $1 FOR UPDATE", [dep.id]);
    if (!fresh.rows.length) return { skipped: "gone" };
    const pledges = await c.query("SELECT * FROM pledges WHERE departure_id = $1", [dep.id]);
    const current = mapDeparture(fresh.rows[0], pledges.rows);
    if (!missedConfirmDeadline(current, product)) return { skipped: "no longer qualifies" };

    await c.query("UPDATE departures SET status = 'cancelled' WHERE id = $1", [dep.id]);
    await c.query(
      `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        "system@sawa.tours", "system", "departure.auto_cancel", "departure", String(dep.id),
        JSON.stringify({
          reason: "minimum not reached by the GoAhead deadline",
          seats: seatsTotal(current.pledges),
          minSeats: goAheadSeatsFor(current),
          deadline: new Date(confirmDeadlineAt(current, product)).toISOString(),
        }),
      ]
    );
    // Who to tell — direct travellers carry an email; agency pledges do not.
    const recipients = current.pledges
      .filter((p) => p.status !== "cancelled" && p.customerEmail)
      .map((p) => p.customerEmail);
    return { cancelled: true, recipients: [...new Set(recipients)], departure: current };
  });
}

// The work itself. Deliberately does not touch the pool or the process: the
// scheduler inside the running server calls this too, and a job that closed the
// connection pool or exited would take the website down with it.
//
// `deps` exists for one test and is never passed in production. The claim that
// a dry run reaches neither the cancel nor the send could only be checked by
// reading this function, and reading is not observing — see JJ2. With the seam,
// a test can put a candidate in front of it and assert that both stay untouched.
export async function runCancelUnconfirmed({
  dryRun = false,
  log = console.log,
  deps = { loadCandidates, cancelOne, send: sendEmail },
} = {}) {
  const candidates = await deps.loadCandidates();
  log(`${candidates.length} departure(s) past their GoAhead deadline${dryRun ? " (dry run)" : ""}`);

  let cancelled = 0;
  let notified = 0;
  for (const candidate of candidates) {
    const { dep } = candidate;
    const seats = seatsTotal(dep.pledges);
    const line = `  #${dep.id} ${dateLabel(dep)} — ${seats}/${goAheadSeatsFor(dep)} seats — ${dep.route}`;

    if (dryRun) { log(line + "  [would cancel]"); continue; }

    const result = await deps.cancelOne(candidate);
    if (result.skipped) { log(line + `  [skipped: ${result.skipped}]`); continue; }
    cancelled += 1;

    // Email never blocks the cancellation: the date is already cancelled and
    // committed by this point, and a mail outage must not leave it open.
    for (const to of result.recipients) {
      const sent = await deps.send(cancellationEmail({
        to, route: result.departure.route, dateLabel: dateLabel(result.departure),
      })).catch(() => ({ ok: false }));
      if (sent?.ok) notified += 1;
    }
    log(line + `  [cancelled, ${result.recipients.length} traveller(s) emailed]`);
  }

  if (!dryRun) log(`cancelled ${cancelled}, emails sent ${notified}`);
  return { candidates: candidates.length, cancelled, notified };
}

// Run as a script (npm run job:cancel-unconfirmed) rather than imported.
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  runCancelUnconfirmed({ dryRun: DRY_RUN })
    .then(() => pool.end())
    .catch((e) => {
      console.error("cancel-unconfirmed failed:", e.message);
      process.exit(1);
    });
}
