// Tell the TRAVELLERS a date reached GoAhead.
//
// ============================================================================
// THE PROMISE THIS KEEPS
// ============================================================================
//
// Every booking confirmation says, in writing:
//
//   "the deposit only falls due once this date reaches its minimum travellers
//    (GoAhead), and we'll email you when that happens."
//
// Reaching GoAhead emailed them nothing. `refreshStatus` wrote
// `minimum_reached` and recorded the milestone for ops; the only `goAheadEmail`
// in the codebase fired from `POST /api/admin/departures/:id/confirm`, which is
// a DIFFERENT transition (`supplier_confirmed`) performed by a human who has
// already noticed. So the promise was kept exactly when someone remembered to
// press a button, and silently broken otherwise.
//
// This is the sibling of alert-goahead.js and is deliberately built the same
// way — the reasoning in DIR-20.1 applies unchanged: `refreshStatus` has four
// callers under three transaction boundaries, so the trigger belongs on the
// milestone record, not in a route. A route-level send would fire for that
// route and no other.
//
// ============================================================================
// DRY BY DEFAULT, AND WHY THAT MATTERS MORE HERE
// ============================================================================
//
// The queue is DERIVED from history: every departure that ever reached GoAhead
// and carries no `goahead_notified` marker. So the backlog on the first run is
// the entire history, and unlike its sibling this job emails CUSTOMERS.
//
// An accidental first live tick would tell every traveller who ever booked that
// their date is confirmed — including people whose trip has long since departed.
// So it refuses to send until told, and the dry run prints exactly who would be
// reached, which is the number to look at before switching it on.
//
// To adopt without a burst, mark the history as already notified — the queue is
// the difference between two audit actions, so backfilling the marker is the
// supported way to start from now:
//
//   INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
//   SELECT 'system@sawa.tours', 'system', 'departure.goahead_notified', 'departure', entity_id, '{"backfill":true}'
//     FROM audit_log WHERE action = 'departure.goahead' AND entity = 'departure'
//    GROUP BY entity_id;
//
//   node server/jobs/notify-goahead.js            # dry
//   DRY_RUN=0 node server/jobs/notify-goahead.js  # live
import { pool } from "../db/index.js";
import { sendEmail, goAheadEmail } from "../email.js";
import { pendingGoAheadNotices, markNotified, reportNotices } from "../goahead-alert.js";

const DRY_RUN = process.env.DRY_RUN !== "0";

// A DATE column arrives from pg as a JS Date. Rendering it with the host's
// timezone put "Sat Sep 19 2026 00:00:00 GMT+0300" in an operations email once
// (YY3); this is customer-facing, so it is normalised the same way.
const isoDay = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};

export function dateLabelFor(departure) {
  const start = isoDay(departure.start_date) || isoDay(departure.date);
  const end = isoDay(departure.end_date);
  return end && end !== start ? `${start} – ${end}` : start;
}

// MM1 — `status <> 'cancelled'` is the whole point of this query.
//
// A traveller who cancelled their own booking is no longer on this date, and
// emailing them that it is confirmed is a message addressed to a named person
// stating something untrue about their booking. That defect shipped once, on
// the two older code paths; it is not being reintroduced here.
//
// DISTINCT because one person may hold two bookings on the same departure and
// should be told once.
export async function recipientsFor(departureId, client = pool) {
  const { rows } = await client.query(
    `SELECT DISTINCT customer_email FROM pledges
      WHERE departure_id = $1 AND customer_email IS NOT NULL AND status <> 'cancelled'`,
    [departureId]
  );
  return rows.map((r) => r.customer_email).filter(Boolean);
}

export async function runGoAheadNotices({ dryRun = DRY_RUN } = {}) {
  const due = await pendingGoAheadNotices();
  console.log(`${due.length} departure(s) confirmed and awaiting a traveller notice${dryRun ? " (dry run)" : ""}`);

  let sent = 0;
  for (const departure of due) {
    const dateLabel = dateLabelFor(departure);
    const to = await recipientsFor(departure.id);
    const line = `  #${departure.id} ${dateLabel} — ${to.length} traveller(s) — ${departure.route}`;

    if (dryRun) { console.log(`${line}  [would email ${to.join(", ") || "nobody"}]`); continue; }

    // A departure with no reachable traveller is DONE, not failed. Leaving it
    // queued would report a permanent shortfall and train the reader to ignore
    // the number that means real people were not told.
    if (!to.length) {
      await markNotified(pool, departure.id, { recipients: 0, reason: "no contactable traveller" });
      sent += 1;
      console.log(`${line}  [nobody to email — marked]`);
      continue;
    }

    try {
      // Awaited, not fire-and-forget: the marker below must mean these were
      // actually accepted for delivery. All-or-nothing per departure — a partial
      // send leaves it queued and the whole set is retried, which may re-send to
      // someone. That is the deliberate trade: a duplicate "your trip is
      // confirmed" is a far smaller harm than a traveller never hearing.
      for (const address of to) {
        await sendEmail(goAheadEmail({ to: address, route: departure.route, dateLabel }));
      }
      await markNotified(pool, departure.id, { recipients: to.length });
      sent += 1;
      console.log(`${line}  [notified]`);
    } catch (e) {
      console.error(`${line}  [FAILED — ${e.message}] — stays in the queue`);
    }
  }

  const ok = dryRun ? true : reportNotices({ intended: due.length, sent });
  return { due: due.length, sent, dryRun, ok };
}

const isCli = process.argv[1] && process.argv[1].endsWith("notify-goahead.js");
if (isCli) {
  const { ok } = await runGoAheadNotices();
  await pool.end();
  process.exit(ok ? 0 : 1);
}
