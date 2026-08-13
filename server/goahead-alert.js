// DIR-20 — the payment-link alert.
//
// ============================================================================
// WHAT WAS ACTUALLY WRONG
// ============================================================================
//
// The GoAhead moment — the thing the entire site is built around — notified
// NOBODY. `refreshStatus` wrote `minimum_reached` and returned. The only
// `goAheadEmail` in the codebase fires from `POST /api/admin/departures/:id/
// confirm`, which is a different transition (`supplier_confirmed`) performed by
// a human who has already noticed.
//
// So the sequence was: a fourth traveller books, the date confirms, and the
// only way anyone learns of it is by looking.
//
// ============================================================================
// 20.1 — WHY THE RECORD IS WRITTEN HERE AND NOT IN A ROUTE
// ============================================================================
//
// `refreshStatus` has four callers under THREE different transaction
// boundaries: two plain `withTransaction`, one nested, one
// `withDepartureWrites`. A trigger in any route handler would fire for that
// route and no other — which is the mirror's defect (TT1), where three writers
// told Autoura and the fourth did not.
//
// So the record is written INSIDE `refreshStatus`, in the same transaction as
// the status change. The row and the status commit together or not at all, and
// any future path that confirms a departure gets this for free.
//
// ============================================================================
// 20.3 — THE EMAIL IS THE PROMPT. THE AUDIT ROW IS THE RECORD.
// ============================================================================
//
// An unread email is indistinguishable from no departure needing a link, and
// here that costs revenue directly. So sending is NOT the mechanism:
//
//   departure.goahead        written atomically with the status change
//   departure.goahead_alert  written only when an alert was actually sent
//
// The queue is the difference between them, and it is DERIVED — no new column,
// no new table, nothing to keep in step. `audit_log` is append-only under 024,
// so the queue cannot be quietly emptied either.
//
// A send that fails leaves the departure in the queue. That is the point.
import { pool } from "./db/index.js";

export const GOAHEAD = "departure.goahead";
export const GOAHEAD_ALERT = "departure.goahead_alert";
// The traveller-facing half of the same moment.
//
// DIR-20 solved "ops must be told to send a payment link" and left the other
// promise unkept: the booking confirmation tells every traveller "we'll email
// you when that happens", and reaching GoAhead automatically emailed them
// nothing. `goAheadEmail` existed but fired only from the admin confirm route —
// a DIFFERENT transition (`supplier_confirmed`), performed by a human who has
// already noticed. So the promise was kept only when ops remembered.
//
// Deliberately a SECOND marker rather than a flag on the first: the two sends
// have different recipients, different failure modes and different consequences
// when they do not happen. Ops missing a prompt costs a payment link; a
// traveller missing this is a written promise broken. Sharing one marker would
// mean either send suppressing the other.
export const GOAHEAD_NOTIFIED = "departure.goahead_notified";
export const SYSTEM_ACTOR = "system@sawa.tours";

// Called from refreshStatus, inside the transaction that writes the status.
export async function recordGoAhead(c, departureId, detail = {}) {
  await c.query(
    `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
     VALUES ($1, 'system', $2, 'departure', $3, $4)`,
    [SYSTEM_ACTOR, GOAHEAD, String(departureId), JSON.stringify(detail)]
  );
}

// Departures that reached GoAhead and are still missing `marker`.
//
// Ordered oldest first — a date that has been waiting two days is more urgent
// than one that confirmed a minute ago, and a queue that hides its backlog is
// the shape this whole item exists to avoid.
//
// Parameterised by the marker rather than copied per queue. There are two sends
// off this one transition — the ops payment-link prompt and the traveller's
// "your trip is confirmed" — and the difference between them is a single action
// string. A second hand-written copy of this query is how the two would drift
// into disagreeing about what "confirmed" means, which is the defect class this
// file was written to close.
async function pendingFor(marker, client = pool) {
  const { rows } = await client.query(
    `SELECT d.*, a.confirmed_at
       FROM departures d
       JOIN (SELECT entity_id, MIN(created_at) AS confirmed_at
               FROM audit_log WHERE action = $1 AND entity = 'departure'
              GROUP BY entity_id) a
         ON a.entity_id = d.id::text
      WHERE d.status IN ('minimum_reached', 'supplier_confirmed')
        AND NOT EXISTS (
          SELECT 1 FROM audit_log s
           WHERE s.action = $2 AND s.entity = 'departure' AND s.entity_id = d.id::text
        )
      ORDER BY a.confirmed_at ASC`,
    [GOAHEAD, marker]
  );
  return rows;
}

// The queue: confirmed, and nobody has been told to make a payment link.
export const pendingGoAheads = (client = pool) => pendingFor(GOAHEAD_ALERT, client);

// The queue: confirmed, and the travellers on it have not been told.
//
// A cancelled DEPARTURE drops out of both queues by the status filter above. A
// cancelled PLEDGE is filtered at send time, not here, because the departure
// still needs the rest of its travellers told — the MM1 defect, where a
// traveller who had cancelled was emailed about a date they were no longer on.
export const pendingGoAheadNotices = (client = pool) => pendingFor(GOAHEAD_NOTIFIED, client);

async function mark(client, action, departureId, detail) {
  await client.query(
    `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
     VALUES ($1, 'system', $2, 'departure', $3, $4)`,
    [SYSTEM_ACTOR, action, String(departureId), JSON.stringify(detail)]
  );
}

export const markAlerted = (client, departureId, detail) =>
  mark(client, GOAHEAD_ALERT, departureId, detail);

// Written only after the traveller emails actually went out, for the reason in
// 20.3: the record is the queue, and a notice nobody received must not look
// like one that was delivered.
export const markNotified = (client, departureId, detail) =>
  mark(client, GOAHEAD_NOTIFIED, departureId, detail);

// 20.2 — everything needed to act, without opening anything else.
//
// Every field is read from the row rather than recomputed. `booking_total`,
// `deposit_due` and `balance_due` are what the traveller was quoted AT BOOKING
// (023's write-time capture); recomputing them here could quote a different
// number from the one in their confirmation email, which is the kind of
// difference a person notices on an invoice.
// A DATE column comes back from pg as a JS Date, not a string. The unit tests
// for this function were written with string fixtures and passed; the first
// rehearsal against a real database put
//
//   "Sat Sep 19 2026 00:00:00 GMT+0300 (Eastern European Summer Time)"
//
// in the subject line of an operations email. Two defects in one line: a
// host-timezone rendering, in a project that pinned Cairo at every boundary for
// exactly this reason (YY3) — and, because two Date objects are never `!==`-
// equal, a single-day departure would have rendered as "X – X".
//
// So dates are normalised to YYYY-MM-DD before anything compares or prints
// them. `toISOString` is not used: it converts to UTC and can move the day.
const isoDay = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};

export function alertPayload({ departure, pledges, agency, portalBase = "" }) {
  const live = pledges.filter((p) => p.status !== "cancelled");
  const money = (n) => (n == null ? null : Number(n));
  const start = isoDay(departure.start_date) || isoDay(departure.date);
  const end = isoDay(departure.end_date);
  const travellers = live.map((p) => ({
    name: p.customers || null,
    contact: p.customer_email || (p.agency ? `via agency: ${p.agency}` : null),
    seats: Number(p.seats) || 0,
    bookingCode: p.booking_code || null,
    total: money(p.booking_total),
    depositDue: money(p.deposit_due),
    balanceDue: money(p.balance_due),
    balanceDueDate: isoDay(p.balance_due_date),
  }));
  return {
    departureId: departure.id,
    route: departure.route,
    date: end && end !== start ? `${start} – ${end}` : start,
    operator: agency?.name || null,
    operatorContact: agency?.phone || agency?.contact_name || null,
    seatsConfirmed: travellers.reduce((n, t) => n + t.seats, 0),
    minSeats: Number(departure.min_seats) || null,
    travellers,
    depositTotal: travellers.reduce((n, t) => n + (t.depositDue || 0), 0) || null,
    portalLink: portalBase ? `${portalBase.replace(/\/$/, "")}/admin/departures/${departure.id}` : null,
    // Stated, not implied: a missing operator is a real state and the alert
    // must not render it as an empty string that reads like "none needed".
    unknowns: [
      agency?.name ? null : "operator not recorded on this departure",
      travellers.some((t) => t.total == null) ? "one or more bookings have no captured total" : null,
    ].filter(Boolean),
  };
}

// 20.4 — PP2 discipline. Intended vs sent, and a shortfall is an ERROR.
export function reportAlerts({ intended, sent, log = console.log, error = console.error }) {
  if (intended === 0) { log("goahead-alert: no departures awaiting a payment link"); return true; }
  if (sent === intended) { log(`goahead-alert: ${sent} of ${intended} departure(s) alerted`); return true; }
  error(
    `goahead-alert: ALERT SHORTFALL — ${sent} of ${intended} departure(s) alerted. `
    + `${intended - sent} confirmed departure(s) are waiting for a payment link that nobody has been asked to create. `
    + `They stay in the queue; re-run the job.`
  );
  return false;
}

// The same shape for the traveller notices, and a shortfall here is louder on
// purpose: the confirmation email PROMISED this message. A departure counted
// here is a set of named people who were told they would hear and did not.
export function reportNotices({ intended, sent, log = console.log, error = console.error }) {
  if (intended === 0) { log("goahead-notify: no departures awaiting a traveller notice"); return true; }
  if (sent === intended) { log(`goahead-notify: ${sent} of ${intended} departure(s) notified`); return true; }
  error(
    `goahead-notify: NOTICE SHORTFALL — ${sent} of ${intended} departure(s) notified. `
    + `Travellers on ${intended - sent} confirmed departure(s) were promised "we'll email you when that happens" `
    + `and have not been. They stay in the queue; re-run the job.`
  );
  return false;
}
