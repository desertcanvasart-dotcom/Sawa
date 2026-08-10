// DIR-20 — drain the payment-link queue.
//
// Reads departures that reached GoAhead and have not been alerted, sends one
// internal email each, and records the send. It is a JOB and not a route for
// 20.1's reason: the transition happens under three different transaction
// boundaries and will happen under more.
//
// DRY BY DEFAULT, like cancel-unconfirmed: a job that emails on its first
// accidental run is a job that emails ops about every departure ever confirmed.
// Set DRY_RUN=0 to send.
//
//   node server/jobs/alert-goahead.js            # dry
//   DRY_RUN=0 node server/jobs/alert-goahead.js  # live
import { pool } from "../db/index.js";
import { sendEmail } from "../email.js";
import { goAheadPaymentLinkEmail } from "../email.js";
import { pendingGoAheads, markAlerted, alertPayload, reportAlerts } from "../goahead-alert.js";

const DRY_RUN = process.env.DRY_RUN !== "0";
const ALERT_TO = process.env.GOAHEAD_ALERT_TO || "hello@sawa.tours";
const PORTAL = process.env.APP_URL || "";

export async function runGoAheadAlerts({ dryRun = DRY_RUN, to = ALERT_TO } = {}) {
  const due = await pendingGoAheads();
  console.log(`${due.length} departure(s) confirmed and awaiting a payment link${dryRun ? " (dry run)" : ""}`);

  let sent = 0;
  for (const departure of due) {
    const pledges = (await pool.query(
      `SELECT * FROM pledges WHERE departure_id = $1`, [departure.id])).rows;
    const agency = (await pool.query(
      `SELECT a.* FROM agencies a
         JOIN tour_products p ON p.agency_id = a.id
        WHERE p.id = $1`, [departure.tour_product_id])).rows[0] || null;

    const payload = alertPayload({ departure, pledges, agency, portalBase: PORTAL });
    const line = `  #${departure.id} ${payload.date} — ${payload.seatsConfirmed} seat(s) — ${payload.route}`;

    if (dryRun) { console.log(`${line}  [would alert ${to}]`); continue; }

    try {
      await sendEmail(goAheadPaymentLinkEmail({ to, payload }));
      // Recorded only AFTER the send resolved. A failure leaves the departure
      // in the queue, which is the whole design: the record is the queue, and
      // an alert nobody received must not look like one that was delivered.
      await markAlerted(pool, departure.id, { to, seats: payload.seatsConfirmed });
      sent += 1;
      console.log(`${line}  [alerted]`);
    } catch (e) {
      console.error(`${line}  [FAILED — ${e.message}] — stays in the queue`);
    }
  }

  const ok = dryRun ? true : reportAlerts({ intended: due.length, sent });
  return { due: due.length, sent, dryRun, ok };
}

const isCli = process.argv[1] && process.argv[1].endsWith("alert-goahead.js");
if (isCli) {
  const { ok } = await runGoAheadAlerts();
  await pool.end();
  process.exit(ok ? 0 : 1);
}
