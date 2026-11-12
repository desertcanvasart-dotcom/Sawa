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
import { partnerPageUrl, withWidgetParam } from "../shared/partner-page.js";
import { rethrowIfProgrammerError } from "./errors.js";

const NAME = `COALESCE(a.name, r.name) AS name`;
const PARTNER = `referrals r LEFT JOIN agencies a ON a.id = r.agency_id`;

// Migration 070 (agencies.website, pledges.partner_page_url) is applied by
// hand. Until it is, a query naming those columns fails with 42703; the
// partner's NAME must still be found, so the lookup falls back to the query
// without them and remembers which one this database answers.
let has070 = null;
const missingColumn = (e) => e?.code === "42703";
async function with070(q, withCols, withoutCols) {
  if (has070 !== false) {
    try { const r = await withCols(); has070 = true; return r; }
    catch (e) { if (!missingColumn(e)) throw e; has070 = false; }
  }
  return withoutCols();
}
export const forget070 = () => { has070 = null; };   // for tests

// `key` names the booking one of four ways, whichever the caller has:
//   { refCode }              the partner code itself (a booking being made;
//                            `pageUrl` and `bookingCode` ride along, checked)
//   { pledgeId }             the booking's id
//   { bookingCode }          the traveler's booking code
//   { departureId, email }   a traveler on a date (letters sent per address)
//
// Answers { name, pageUrl, bookingCode }: the partner, the page on the
// partner's own site the booking was made on (null unless 070 is applied and
// the page passed the check in shared/partner-page.js), and the booking's code.
export async function partnerOf(db, key = {}) {
  const q = db || pool;
  const none = { name: "", pageUrl: null, bookingCode: null };
  try {
    if (key.refCode != null) {
      const code = cleanRefCode(key.refCode);
      if (!code) return none;
      const row = (await with070(q,
        () => q.query(`SELECT ${NAME}, a.website FROM ${PARTNER} WHERE r.code = $1 AND r.active`, [code]),
        () => q.query(`SELECT ${NAME} FROM ${PARTNER} WHERE r.code = $1 AND r.active`, [code]))).rows[0];
      if (!row?.name) return none;
      return { name: row.name, pageUrl: partnerPageUrl(key.pageUrl, row.website), bookingCode: key.bookingCode || null };
    }
    const where = key.pledgeId != null ? ["p.id = $1", [String(key.pledgeId)]]
      : key.bookingCode ? ["UPPER(p.booking_code) = UPPER($1)", [String(key.bookingCode)]]
      : key.departureId != null && key.email ? ["p.departure_id = $1 AND LOWER(p.customer_email) = LOWER($2)", [key.departureId, String(key.email)]]
      : null;
    if (!where) return none;
    const sql = (cols) =>
      `SELECT ${NAME}, p.booking_code${cols} FROM pledges p JOIN referrals r ON r.code = p.ref_code AND r.active LEFT JOIN agencies a ON a.id = r.agency_id
        WHERE ${where[0]} AND p.ref_code IS NOT NULL ORDER BY p.created_at DESC LIMIT 1`;
    const row = (await with070(q,
      () => q.query(sql(", p.partner_page_url, a.website"), where[1]),
      () => q.query(sql(""), where[1]))).rows[0];
    if (!row?.name) return none;
    // Checked again on the way out: the agency may have changed its website
    // since the booking, and a stored address is only as good as today's rule.
    return { name: row.name, pageUrl: partnerPageUrl(row.partner_page_url, row.website), bookingCode: row.booking_code || null };
  } catch (e) {
    // The email still goes, without the line: a failed lookup must never cost
    // a traveler their GoAhead or their payment link.
    rethrowIfProgrammerError(e);
    console.warn(`[email] partner not looked up — ${e.message}`);
    return none;
  }
}
export const partnerName = async (db, key) => (await partnerOf(db, key)).name;

// The page a new booking may link back to: the address the widget reported,
// if it is on the website this partner registered. null otherwise.
export const partnerPageFor = async (db, refCode, pageUrl) => (pageUrl ? (await partnerOf(db, { refCode, pageUrl })).pageUrl : null);

// Kept with the booking, so every later email about it can link back too.
export async function rememberPartnerPage(db, bookingCode, pageUrl) {
  if (!bookingCode || !pageUrl || has070 === false) return false;
  try {
    return (await (db || pool).query(
      "UPDATE pledges SET partner_page_url = $2 WHERE UPPER(booking_code) = UPPER($1)", [String(bookingCode), pageUrl])).rowCount > 0;
  } catch (e) {
    rethrowIfProgrammerError(e);
    console.warn(`[email] partner page not kept with ${bookingCode} — ${e.message}`);
    return false;
  }
}

// "Confirm my booking": on the partner's page when there is one, else Sawa's.
export const confirmLink = (sawaUrl, token, pageUrl) => (pageUrl ? withWidgetParam(pageUrl, "sawa-confirm", token) : sawaUrl);

// Every link to Sawa's own booking page for this code -> the partner's page,
// with the widget told which booking to open. Applied to a finished message so
// no template has to know; the code is the booking's own, so this cannot
// rewrite a link to anyone else's booking.
export function linkBookingToPartnerPage(message, { pageUrl, bookingCode } = {}) {
  if (!message || !pageUrl || !bookingCode) return message;
  const code = encodeURIComponent(bookingCode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`https?://[^\\s"'<>]+/booking/${code}(?![\\w%-])`, "gi");
  const target = withWidgetParam(pageUrl, "sawa-booking", bookingCode);
  const swap = (part, encode) => (part ? part.replace(link, encode ? target.replace(/&/g, "&amp;") : target) : part);
  return { ...message, html: swap(message.html, true), text: swap(message.text, false) };
}

// A built message (or a promise of one), with the partner's line and the
// partner's page when the booking has them. `skip` for a copy addressed to the
// agency itself.
export async function throughPartner(db, key, message, { skip = false } = {}) {
  const built = await message;
  if (skip) return built;
  const partner = await partnerOf(db, key);
  return linkBookingToPartnerPage(withPartner(built, partner.name), partner);
}
