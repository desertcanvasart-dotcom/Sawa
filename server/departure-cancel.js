// PP5 / PP2 — cancelling a departure, once, for both paths.
//
// Two things were wrong and they compound.
//
// KK1: cancelling a departure left its pledges reading `confirmed`. The
// traveller was emailed that the booking was cancelled; the row recording it
// said otherwise. Both cancellation paths did this — the unattended job and the
// admin route — so it is fixed in one place that both call, rather than twice.
//
// PP2: the recipient list has to be read BEFORE the pledges are cancelled, or
// there is nobody left to tell. In the job that happened to be true, because
// `current` was a snapshot taken earlier. In the admin route it was NOT: it read
// recipients after the transaction committed, with `status <> 'cancelled'` — so
// transitioning the pledges would have silently emptied the list.
//
// That failure is invisible by construction. "0 travellers emailed" on a date
// that had four is indistinguishable from a date that had none, and both look
// like a quiet success in the log. So the count is recorded before the write and
// checked after, and a shortfall is an error rather than a line.
import { withTransaction } from "./db/index.js";

// Why a departure was cancelled. Recorded in audit_log today; migration 023
// proposes `pledges.cancelled_reason` to carry it on the row itself.
//
// NOT written to a column here. 023 has not been applied, migrations do not run
// on deploy (B5), and code that writes a column production does not have is an
// outage. When 023 lands, the write goes in here and nowhere else.
export const CANCEL_REASONS = {
  MINIMUM_NOT_REACHED: "minimum_not_reached",
  DATE_CANCELLED: "date_cancelled",
  REQUEST_NOT_REVIEWED: "request_not_reviewed",
};

// Everyone who should hear about this. Read BEFORE anything is cancelled.
//
// Direct travellers carry an email; agency pledges do not, and an agency is told
// through its own dashboard. A pledge already cancelled is excluded — the
// traveller who cancelled their own booking must not be emailed about a date
// they are no longer on (MM1).
export async function recipientsBeforeCancelling(client, departureId) {
  const { rows } = await client.query(
    `SELECT DISTINCT customer_email FROM pledges
      WHERE departure_id = $1 AND customer_email IS NOT NULL AND status <> 'cancelled'`,
    [departureId]
  );
  return rows.map((r) => r.customer_email);
}

// Cancel the date and release the seats, in one transaction.
//
// The order is load-bearing: recipients first, then the departure, then the
// pledges. Reversing the first two lines is the PP2 failure.
export async function cancelDepartureAndPledges(client, departureId) {
  const recipients = await recipientsBeforeCancelling(client, departureId);

  await client.query("UPDATE departures SET status = 'cancelled' WHERE id = $1", [departureId]);

  // The row that says a traveller holds a seat and the row that says the date is
  // running change together or not at all.
  const released = await client.query(
    `UPDATE pledges SET status = 'cancelled'
      WHERE departure_id = $1 AND status <> 'cancelled'
      RETURNING id`,
    [departureId]
  );

  return { recipients, pledgesCancelled: released.rowCount };
}

export function cancelDeparture(departureId) {
  return withTransaction((c) => cancelDepartureAndPledges(c, departureId));
}

// PP2.1 — three states, and they must never render the same.
//
//   nothing to send   an agency-only date, or one whose travellers had all
//                     already cancelled. Said out loud, so it cannot be
//                     mistaken for the third case.
//   all sent          the ordinary outcome.
//   short             somebody who should have been told was not. An ERROR,
//                     because the alternative is a log line that looks exactly
//                     like the first case.
//
// Returns true when the outcome is clean, so a caller can exit non-zero.
export function reportNotifications({ intended, sent, context, log = console.log, error = console.error }) {
  if (intended === 0) {
    log(`${context}: no travelers to notify (nobody held a seat with an email address)`);
    return true;
  }
  if (sent === intended) {
    log(`${context}: ${sent} of ${intended} traveler(s) notified`);
    return true;
  }
  error(
    `${context}: NOTIFICATION SHORTFALL — ${sent} of ${intended} traveler(s) reached. `
    + `${intended - sent} person(s) were told nothing about a departure that was canceled under them.`
  );
  return false;
}
