// Which company runs a departure, for the emails that tell travellers.
//
// The same rule as the catalogue (operatorForDeparture in domain.js, U01): the
// company with the most travellers on the date, fixed at GoAhead, direct
// bookings counting as the direct-bookings operator's. Whitelisted through
// publicOperator() — the same fields the tour page may show, never a licence
// number.
//
// Never throws: an email that can't name its operator still goes out without
// the line, rather than not at all.
import { pool } from "./db/index.js";
import { mapAgency, mapPledge } from "./db/mappers.js";
import { operatorForDeparture, directOperatorId, publicOperator } from "./domain.js";
import { DIRECT_BOOKINGS_OPERATOR } from "./brand.js";
import { rethrowIfProgrammerError } from "./errors.js";

// U01 — the operator named in a traveller's emails.
//
// Which partner runs a date is worked out from its bookings
// (operatorForDeparture). The confirmation and GoAhead emails name it; a
// lookup that fails leaves the name out rather than holding up the email.
export async function operatorFor(departureId, db = pool) {
  try {
    const dep = (await db.query(
      "SELECT id, tour_product_id, min_seats, max_seats, status FROM departures WHERE id=$1", [departureId])).rows[0];
    if (!dep) return null;
    const [pledges, product, agencies] = await Promise.all([
      db.query("SELECT * FROM pledges WHERE departure_id=$1", [departureId]),
      dep.tour_product_id ? db.query("SELECT agency_id FROM tour_products WHERE id=$1", [dep.tour_product_id]) : { rows: [] },
      db.query("SELECT * FROM agencies"),
    ]);
    const id = operatorForDeparture(
      { minSeats: dep.min_seats, maxSeats: dep.max_seats, status: dep.status, pledges: pledges.rows.map(mapPledge) },
      { listingAgencyId: product.rows[0]?.agency_id || null, directAgencyId: directOperatorId(agencies.rows, DIRECT_BOOKINGS_OPERATOR) },
    );
    const row = id ? agencies.rows.find((a) => a.id === id) : null;
    return row ? publicOperator(mapAgency(row)) : null;
  } catch (e) {
    rethrowIfProgrammerError(e);
    console.warn(`[email] couldn't work out the operator for departure ${departureId}:`, e.message);
    return null;
  }
}
