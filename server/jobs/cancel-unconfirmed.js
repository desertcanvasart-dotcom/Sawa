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
import { pool, withDepartureWrites } from "../db/index.js";
import { mapDeparture, mapProduct } from "../db/mappers.js";
import { missedConfirmDeadline, confirmDeadlineAt, seatsTotal, goAheadSeatsFor } from "../domain.js";
import { cancelDepartureAndPledges, reportNotifications, CANCEL_REASONS } from "../departure-cancel.js";
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
  // TT1 — the fourth writer that never told the mirror, and the only unattended
  // one. Autoura has been holding auto-cancelled departures as `open`, with
  // their seats, indefinitely: nothing else ever corrects it.
  return withDepartureWrites(async (c, touch) => {
    // Re-read under a lock and re-check: between the scan and here, someone may
    // have booked the seat that would have confirmed it.
    const fresh = await c.query("SELECT * FROM departures WHERE id = $1 FOR UPDATE", [dep.id]);
    if (!fresh.rows.length) return { skipped: "gone" };
    const pledges = await c.query("SELECT * FROM pledges WHERE departure_id = $1", [dep.id]);
    const current = mapDeparture(fresh.rows[0], pledges.rows);
    if (!missedConfirmDeadline(current, product)) return { skipped: "no longer qualifies" };

    // PP5 — the date and its pledges change together, and the recipient list is
    // read before either. Shared with the admin cancel route so this cannot be
    // fixed on one path and not the other.
    const { recipients, pledgesCancelled } = await cancelDepartureAndPledges(c, dep.id);
    touch(dep.id);
    await c.query(
      `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        "system@sawa.tours", "system", "departure.auto_cancel", "departure", String(dep.id),
        JSON.stringify({
          reason: "minimum not reached by the GoAhead deadline",
          // The machine-readable form. Migration 023 proposes carrying this on
          // the pledge row itself; until it is applied this is where it lives.
          cancelledReason: CANCEL_REASONS.MINIMUM_NOT_REACHED,
          seats: seatsTotal(current.pledges),
          minSeats: goAheadSeatsFor(current),
          pledgesCancelled,
          notifying: recipients.length,
          deadline: new Date(confirmDeadlineAt(current, product)).toISOString(),
        }),
      ]
    );
    return { cancelled: true, recipients, pledgesCancelled, departure: current };
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
  // Separate from `log` so a shortfall cannot be swallowed by a caller that
  // discards ordinary output — the scheduler passes a quiet log and this must
  // still be heard.
  logError = console.error,
  deps = { loadCandidates, cancelOne, send: sendEmail },
} = {}) {
  const candidates = await deps.loadCandidates();
  log(`${candidates.length} departure(s) past their GoAhead deadline${dryRun ? " (dry run)" : ""}`);

  let cancelled = 0;
  let notified = 0;
  let shortfalls = 0;
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
    //
    // PP2 — the intended count is fixed before any send, and checked after.
    const intended = result.recipients.length;
    let reached = 0;
    for (const to of result.recipients) {
      const sent = await deps.send(cancellationEmail({
        to, route: result.departure.route, dateLabel: dateLabel(result.departure),
      })).catch(() => ({ ok: false }));
      if (sent?.ok) { reached += 1; notified += 1; }
    }
    log(line + `  [cancelled, ${result.pledgesCancelled} booking(s) released]`);
    if (!reportNotifications({ intended, sent: reached, context: `  #${dep.id}`, log, error: logError })) {
      shortfalls += 1;
    }
  }

  if (!dryRun) {
    log(`cancelled ${cancelled}, emails sent ${notified}`);
    if (shortfalls) {
      logError(
        `${shortfalls} departure(s) were cancelled WITHOUT reaching every traveller on them. `
        + "This is not a quiet zero — somebody was not told."
      );
    }
  }
  return { candidates: candidates.length, cancelled, notified, shortfalls };
}

// Run as a script (npm run job:cancel-unconfirmed) rather than imported.
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  runCancelUnconfirmed({ dryRun: DRY_RUN })
    .then(async ({ shortfalls }) => {
      // TT1 — the mirror emits are fire-and-forget, so a short-lived process
      // must wait for them. Without this every sync this job started died on
      // "Cannot use a pool after calling end on the pool", silently.
      const { drainDepartureSyncs } = await import("../autoura-sync.js");
      await drainDepartureSyncs();
      await pool.end();
      // A cancelled departure whose travellers were not all reached is a
      // failure, not a completed run. Cron and anything watching exit codes
      // must see it.
      if (shortfalls) process.exit(1);
    })
    .catch((e) => {
      console.error("cancel-unconfirmed failed:", e.message);
      process.exit(1);
    });
}
