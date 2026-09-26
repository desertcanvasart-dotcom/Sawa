// Which company runs a departure, for the emails that tell travellers.
//
// The same rule as the catalogue (operatorForDeparture in domain.js, U01): the
// company with the most confirmed travellers on the date, ties to the agency
// that opened it, fixed when bookings close, direct bookings counting as the
// direct-bookings operator's unless they came through an agency's widget. Whitelisted through
// publicOperator() — the same fields the tour page may show, never a licence
// number.
//
// Never throws: an email that can't name its operator still goes out without
// the line, rather than not at all.
import { pool } from "./db/index.js";
import { mapAgency, mapPledge, mapDeparture, mapProduct } from "./db/mappers.js";
import { operatorForDeparture, directOperatorId, publicOperator, bookingClosesAtMs } from "./domain.js";
import { isMissingPaymentsTable } from "./payments.js";
import { DIRECT_BOOKINGS_OPERATOR } from "./brand.js";
import { rethrowIfProgrammerError } from "./errors.js";

// The two facts the rule needs beyond the booking rows (U01, 26 Sep 2026):
//   - which agency owns each widget referral code, so a traveller who booked
//     through an agency's widget counts for that agency;
//   - when each booking's deposit was paid (043), since only confirmed
//     passengers count once anyone on the date has paid.
// Before migration 043 there are no payments to read: every booking then
// counts, which is also the rule's own answer for a date nobody has paid on.
export async function loadOperatorInputs(db = pool) {
  const referralAgencies = new Map(
    (await db.query("SELECT code, agency_id FROM referrals WHERE agency_id IS NOT NULL")).rows
      .map((r) => [r.code, r.agency_id]));
  let depositPaidAt = new Map();
  try {
    depositPaidAt = new Map((await db.query(
      `SELECT pledge_id, MIN(paid_at) AS paid_at FROM booking_payments WHERE state = 'paid' GROUP BY pledge_id`)).rows
      .map((r) => [r.pledge_id, r.paid_at instanceof Date ? r.paid_at.toISOString() : r.paid_at]));
  } catch (e) {
    if (!isMissingPaymentsTable(e)) throw e;
  }
  return { referralAgencies, depositPaidAt };
}

// Bookings as the rule reads them: mapped, with the deposit time attached.
export function withDepositTimes(pledges, depositPaidAt) {
  return pledges.map((p) => (depositPaidAt.has(p.id) ? { ...p, depositPaidAt: depositPaidAt.get(p.id) } : p));
}

// U01 — the operator named in a traveller's emails.
//
// Which partner runs a date is worked out from its bookings
// (operatorForDeparture). The confirmation and GoAhead emails name it; a
// lookup that fails leaves the name out rather than holding up the email.
export async function operatorFor(departureId, db = pool) {
  try {
    const dep = (await db.query("SELECT * FROM departures WHERE id=$1", [departureId])).rows[0];
    if (!dep) return null;
    const [pledges, product, agencies, inputs] = await Promise.all([
      db.query("SELECT * FROM pledges WHERE departure_id=$1 ORDER BY created_at ASC, id ASC", [departureId]),
      dep.tour_product_id ? db.query("SELECT * FROM tour_products WHERE id=$1", [dep.tour_product_id]) : { rows: [] },
      db.query("SELECT * FROM agencies"),
      loadOperatorInputs(db),
    ]);
    const productRow = product.rows[0] ? mapProduct(product.rows[0]) : null;
    const departure = { ...mapDeparture(dep, []), pledges: withDepositTimes(pledges.rows.map(mapPledge), inputs.depositPaidAt) };
    const id = operatorForDeparture(departure, {
      listingAgencyId: product.rows[0]?.agency_id || null,
      directAgencyId: directOperatorId(agencies.rows, DIRECT_BOOKINGS_OPERATOR),
      referralAgencies: inputs.referralAgencies,
      lockAtMs: bookingClosesAtMs(departure, productRow),
    });
    const row = id ? agencies.rows.find((a) => a.id === id) : null;
    return row ? publicOperator(mapAgency(row)) : null;
  } catch (e) {
    rethrowIfProgrammerError(e);
    console.warn(`[email] couldn't work out the operator for departure ${departureId}:`, e.message);
    return null;
  }
}
