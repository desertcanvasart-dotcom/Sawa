// The partner a booking came through, for the emails about it.
//
// A traveler who books in an agency's widget booked "with the agency". Every
// email about that booking — GoAhead, the payment link, a cancellation — comes
// from Sawa, so each one says "Booked through <agency>" (withPartner in
// email.js). This module is the one place that answers "which agency", from
// the booking's own partner code (pledges.ref_code), so a template and its
// twenty call sites never work it out differently.
//
// Only widget and referral bookings carry a code. A booking an agency made in
// its own portal does not, and gets no line: its emails go to the agency or to
// a client the agency already speaks for.
import { pool } from "./db/index.js";
import { withPartner } from "./email.js";
import { cleanRefCode } from "../shared/ref-code.js";
import { rethrowIfProgrammerError } from "./errors.js";

const NAME = `COALESCE(a.name, r.name) AS name`;
const PARTNER = `referrals r LEFT JOIN agencies a ON a.id = r.agency_id`;

// `key` names the booking one of four ways, whichever the caller has:
//   { refCode }              the partner code itself
//   { pledgeId }             the booking's id
//   { bookingCode }          the traveler's booking code
//   { departureId, email }   a traveler on a date (letters sent per address)
export async function partnerName(db, key = {}) {
  const q = db || pool;
  try {
    if (key.refCode != null) {
      const code = cleanRefCode(key.refCode);
      if (!code) return "";
      return (await q.query(`SELECT ${NAME} FROM ${PARTNER} WHERE r.code = $1 AND r.active`, [code])).rows[0]?.name || "";
    }
    const where = key.pledgeId != null ? ["p.id = $1", [String(key.pledgeId)]]
      : key.bookingCode ? ["UPPER(p.booking_code) = UPPER($1)", [String(key.bookingCode)]]
      : key.departureId != null && key.email ? ["p.departure_id = $1 AND LOWER(p.customer_email) = LOWER($2)", [key.departureId, String(key.email)]]
      : null;
    if (!where) return "";
    const row = (await q.query(
      `SELECT ${NAME} FROM pledges p JOIN referrals r ON r.code = p.ref_code AND r.active LEFT JOIN agencies a ON a.id = r.agency_id
        WHERE ${where[0]} AND p.ref_code IS NOT NULL ORDER BY p.created_at DESC LIMIT 1`, where[1])).rows[0];
    return row?.name || "";
  } catch (e) {
    // The email still goes, without the line: a failed lookup must never cost
    // a traveler their GoAhead or their payment link.
    rethrowIfProgrammerError(e);
    console.warn(`[email] partner not looked up — ${e.message}`);
    return "";
  }
}

// A built message (or a promise of one), with the partner's line when the
// booking has a partner. `skip` for a copy addressed to the agency itself.
export async function throughPartner(db, key, message, { skip = false } = {}) {
  const built = await message;
  return skip ? built : withPartner(built, await partnerName(db, key));
}
