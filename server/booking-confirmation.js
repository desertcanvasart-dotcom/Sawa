// A direct booking waits for its email to be confirmed (migration 058; live,
// legacy and catalog departures alike).
//
// The public booking route checks everything it always did, then, instead of
// writing the booking, holds it in booking_confirmations and emails a
// "Confirm my booking" link. The link makes the booking through the same code
// path and checks (the seats may have gone meanwhile; then it says so). Until
// then the booking isn't in `pledges`, so it counts towards nothing and the
// operator never sees it. Unconfirmed after 24 hours, it expires, with no
// email. Agency, staff and waitlist bookings don't come through here.
//
// Before the table exists, or with BOOKING_EMAIL_CONFIRMATION=off, bookings
// are made at once, as before.
import { createHash, randomBytes } from "node:crypto";
import { pool } from "./db/index.js";
import { BRAND } from "./brand.js";

export const CONFIRM_HOURS = 24;
export const MAX_RESENDS = 3;
const HOUR = 3600000;

const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
export const confirmBookingUrl = (token) => `${site()}/confirm-booking/${encodeURIComponent(token)}`;

// On unless BOOKING_EMAIL_CONFIRMATION=off. The test suite's servers
// (NODE_ENV=test) default to off, so the suites written before this rule keep
// booking in one step; the tests of this rule turn it on.
export function confirmationRequired(env = process.env) {
  const v = String(env.BOOKING_EMAIL_CONFIRMATION || "").toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return env.NODE_ENV !== "test";
}

export async function confirmationsAvailable(db = pool) {
  return (await db.query("SELECT to_regclass('booking_confirmations') IS NOT NULL AS ok")).rows[0].ok === true;
}

// Whether this booking should be held for confirmation. Missing table: warn
// once and book at once, so the site never breaks before the migration.
let warnedMissing = false;
export async function holdForConfirmation(db, env = process.env) {
  if (!confirmationRequired(env)) return false;
  if (await confirmationsAvailable(db)) return true;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn("[booking-confirmation] table booking_confirmations not found; apply migration 058. Bookings are made without email confirmation until then.");
  }
  return false;
}

// Whether a booking code is taken by a held booking (codes are shared with
// `pledges`: the confirmed booking keeps its code).
export async function heldCodeTaken(c, code) {
  if (!(await confirmationsAvailable(c))) return false;
  return (await c.query("SELECT 1 FROM booking_confirmations WHERE UPPER(booking_code) = UPPER($1)", [code])).rowCount > 0;
}

// Inside the booking's transaction, after every check passed.
export async function holdBooking(c, { departureId, bookingCode, email, seats, payload, now = Date.now() }) {
  const token = newToken();
  const row = (await c.query(
    `INSERT INTO booking_confirmations (booking_code, departure_id, email, seats, payload, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [bookingCode, departureId, email, seats, JSON.stringify(payload), hash(token), new Date(now + CONFIRM_HOURS * HOUR)])).rows[0];
  return { row, token };
}

// The held booking behind a link, locked. Null for an unknown link.
export async function heldByToken(c, token) {
  return (await c.query("SELECT * FROM booking_confirmations WHERE token_hash = $1 FOR UPDATE", [hash(token)])).rows[0] || null;
}

export async function heldByCode(db, code) {
  if (!(await confirmationsAvailable(db))) return null;
  return (await db.query("SELECT * FROM booking_confirmations WHERE UPPER(booking_code) = UPPER($1)", [code])).rows[0] || null;
}

export const isExpired = (row, now = Date.now()) => row.status === "expired" || (row.status === "unconfirmed" && new Date(row.expires_at).getTime() <= now);

export async function markConfirmed(c, { id, pledgeId }) {
  await c.query("UPDATE booking_confirmations SET status = 'confirmed', pledge_id = $2, confirmed_at = now() WHERE id = $1", [id, pledgeId]);
}

export async function markRefused(db, { id, reason }) {
  await db.query("UPDATE booking_confirmations SET status = 'refused', refused_reason = $2 WHERE id = $1 AND status = 'unconfirmed'", [id, String(reason || "").slice(0, 300)]);
}

// The traveler cancels a booking they never confirmed (the cancel link).
export async function cancelHeld(db, { code }) {
  const r = await db.query(
    "UPDATE booking_confirmations SET status = 'cancelled' WHERE UPPER(booking_code) = UPPER($1) AND status = 'unconfirmed' RETURNING id", [code]);
  return r.rowCount > 0;
}

// Resend the link: a new token (the old link stops working), at most 3 times,
// only while the booking is unconfirmed and not expired.
export async function resendLink(db, { code, now = Date.now() }) {
  const row = await heldByCode(db, code);
  if (!row) return { error: 404 };
  if (row.status !== "unconfirmed" || isExpired(row, now)) return { error: 409, row };
  if (row.resends >= MAX_RESENDS) return { error: 429, row };
  const token = newToken();
  const u = await db.query(
    `UPDATE booking_confirmations SET token_hash = $2, resends = resends + 1
      WHERE id = $1 AND status = 'unconfirmed' AND resends < $3 RETURNING *`, [row.id, hash(token), MAX_RESENDS]);
  if (!u.rowCount) return { error: 429, row };
  return { row: u.rows[0], token };
}

export const PURGE_DAYS = 30;

// Every 15 minutes: unconfirmed bookings older than 24 hours expire. No email.
// A booking that never became one (expired, canceled or refused) is deleted
// 30 days on: it holds a traveler's details and nothing else needs it.
export async function expireUnconfirmed({ db = pool, now = Date.now(), log = () => {} } = {}) {
  if (!(await confirmationsAvailable(db))) return { expired: 0, purged: 0 };
  const r = await db.query(
    "UPDATE booking_confirmations SET status = 'expired' WHERE status = 'unconfirmed' AND expires_at <= $1", [new Date(now)]);
  if (r.rowCount) log(`booking-confirmation: ${r.rowCount} unconfirmed booking${r.rowCount === 1 ? "" : "s"} expired`);
  const p = await db.query(
    "DELETE FROM booking_confirmations WHERE status IN ('expired', 'cancelled', 'refused') AND created_at <= $1",
    [new Date(now - PURGE_DAYS * 24 * HOUR)]);
  return { expired: r.rowCount, purged: p.rowCount };
}
