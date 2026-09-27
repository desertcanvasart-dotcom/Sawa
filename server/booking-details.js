// Booking completeness (model phase 3), behind catalogue_v2.
//
// New bookings on a catalog departure must carry what the operator's manifest
// needs: every traveler's name, a phone number, a pickup point, nationality
// where the product asks for it, and an answer on safety needs ("None" is an
// answer). Bookings that still lack any of it (made before the rule, or by
// staff) get an email with a private link 7 days before the departure and a
// reminder at 3 days; once each.
import { createHash, randomBytes } from "node:crypto";
import { pool } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import { zonedDateTimeToUtc } from "./tz.js";
import {
  missingBookingFields, BOOKING_FIELD_LABELS, COMPLETION_REQUEST_DAYS, COMPLETION_REMINDER_DAYS, SAFETY_NONE,
} from "../shared/settlement-rules.js";

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
const dateLabel = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${ymd(d)}T12:00:00Z`));

// The catalog departure an ordinary departure is sold through, with what its
// product asks for. Null for a legacy departure.
export async function catalogueContextFor(c, legacyDepartureId) {
  const r = await c.query(
    `SELECT cd.id, cd.date, c.type, c.title, c.needs_nationality, t.default_time
       FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE cd.legacy_departure_id = $1`, [legacyDepartureId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    departureId: Number(row.id), date: ymd(row.date), type: row.type, title: row.title,
    needsNationality: row.needs_nationality === true, startTime: row.default_time || "08:00",
  };
}

const clean = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

// The booking's details from a request body, normalized. `safetyNone` (the
// explicit "no needs" answer) is stored as "None".
export function bookingDetailsFrom(body = {}) {
  const names = Array.isArray(body.travelerNames) ? body.travelerNames.map((n) => clean(n, 120)).filter(Boolean).slice(0, 12) : [];
  const safety = body.safetyNone === true ? SAFETY_NONE : clean(body.safetyNeeds, 1000);
  return {
    travelerNames: names,
    phone: clean(body.customerPhone ?? body.phone, 40),
    pickupPoint: clean(body.pickupPoint, 200),
    nationality: clean(body.nationality, 80),
    safetyNeeds: safety,
  };
}

// Under the flag, on a catalog departure: refuse a booking that lacks a
// required field, in words a traveler can act on.
export function assertBookingComplete(details, seats, { needsNationality }) {
  const missing = missingBookingFields({ seats, ...details }, { needsNationality });
  if (!missing.length) return;
  const words = missing.map((k) => BOOKING_FIELD_LABELS[k]);
  const extra = missing.includes("travelerNames") ? ` (${seats} name${seats === 1 ? "" : "s"}, one for each seat)` : "";
  throw new CatalogueError(422, `Please add ${words.join(", ")}${extra}.`);
}

// What a stored booking still lacks.
export function missingForPledge(p, { needsNationality }) {
  return missingBookingFields({
    seats: p.seats, travelerNames: p.traveller_names || [], phone: p.customer_phone,
    pickupPoint: p.pickup_point, nationality: p.nationality, safetyNeeds: p.safety_needs,
  }, { needsNationality });
}

async function recipientFor(c, p) {
  if (p.customer_email) return { to: String(p.customer_email).toLowerCase(), agencyClient: null };
  const agencyOwner = (await c.query(
    `SELECT email FROM app_users WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' ORDER BY created_at LIMIT 1`,
    [p.agency_id])).rows[0];
  return agencyOwner ? { to: String(agencyOwner.email).toLowerCase(), agencyClient: p.customers || "your client" } : null;
}

// Daily. Bookings on catalog departures 1–7 days out that lack a field get a
// request; at 3 days or fewer, a reminder if the request went out earlier and
// they still lack one. Each once, recorded before sending.
export async function runCompletionRequests({ db = pool, now = Date.now(), send = null, env = process.env, log = () => {} } = {}) {
  if (!catalogueV2Enabled(env)) return { skipped: "catalogue_v2 is off" };
  const today = todayIn(now);
  const rows = (await db.query(
    `SELECT p.*, cd.date AS dep_date, c.title, c.needs_nationality, t.default_time
       FROM pledges p
       JOIN catalogue_departures cd ON cd.legacy_departure_id = p.departure_id
       JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE p.status <> 'cancelled' AND cd.status IN ('open', 'go_ahead')
        AND cd.date > $1::date AND cd.date <= $1::date + $2::int`, [today, COMPLETION_REQUEST_DAYS])).rows;
  const out = { requested: 0, reminded: 0, failed: 0 };
  for (const p of rows) {
    const missing = missingForPledge(p, { needsNationality: p.needs_nationality === true });
    if (!missing.length) continue;
    const date = ymd(p.dep_date);
    const daysLeft = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    const existing = (await db.query("SELECT kind, sent_at, created_at FROM booking_completion_requests WHERE pledge_id = $1", [p.id])).rows;
    const request = existing.find((e) => e.kind === "request");
    let kind = null;
    if (!request) kind = "request";
    else if (daysLeft <= COMPLETION_REMINDER_DAYS && !existing.some((e) => e.kind === "reminder")
      && todayIn(new Date(request.created_at).getTime()) < today) kind = "reminder";
    if (!kind) continue;
    const who = await recipientFor(db, p);
    if (!who) continue;
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(zonedDateTimeToUtc(date, (p.default_time || "08:00").slice(0, 5)));
    const ins = await db.query(
      `INSERT INTO booking_completion_requests (pledge_id, kind, recipient, token_hash, missing, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (pledge_id, kind) DO NOTHING RETURNING id`,
      [p.id, kind, who.to, hashToken(token), JSON.stringify(missing), expires]);
    if (!ins.rows.length) continue;
    const id = ins.rows[0].id;
    if (!send) continue;
    const { bookingDetailsRequestEmail } = await import("./email.js");
    try {
      const res = await send(bookingDetailsRequestEmail({
        to: who.to, travelerName: who.agencyClient ? null : p.customers, agencyClient: who.agencyClient,
        title: p.title, dateLabel: dateLabel(date), missing: missing.map((k) => BOOKING_FIELD_LABELS[k]),
        link: `${site()}/booking-details/${token}`, reminder: kind === "reminder",
      }));
      if (!res?.ok) throw new Error(res?.error || "not accepted");
      await db.query("UPDATE booking_completion_requests SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1", [id]);
      out[kind === "request" ? "requested" : "reminded"] += 1;
    } catch (e) {
      out.failed += 1;
      await db.query("UPDATE booking_completion_requests SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, String(e.message).slice(0, 300)]);
      log(`booking details: request for ${p.id} failed: ${e.message}`);
    }
  }
  if (out.requested || out.reminded) log(`booking details: ${out.requested} requests, ${out.reminded} reminders`);
  return out;
}

async function byToken(c, token, { forUpdate = false } = {}) {
  const r = await c.query(
    `SELECT r.*, p.seats, p.customers, p.customer_phone, p.pickup_point, p.nationality, p.safety_needs, p.traveller_names, p.status AS pledge_status,
            p.departure_id AS legacy_departure_id
       FROM booking_completion_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE r.token_hash = $1 ${forUpdate ? "FOR UPDATE OF p" : ""}`, [hashToken(token)]);
  const row = r.rows[0];
  if (!row || row.pledge_status === "cancelled") throw new CatalogueError(404, "This link isn't valid. Check the latest email from Sawa, or reply to it.");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new CatalogueError(410, "This link has expired: the tour has started.");
  return row;
}

// The page behind the private link.
export async function bookingDetailsByToken(token, db = pool) {
  const row = await byToken(db, token);
  const ctx = await catalogueContextFor(db, row.legacy_departure_id);
  const details = {
    travelerNames: row.traveller_names || [], phone: row.customer_phone, pickupPoint: row.pickup_point,
    nationality: row.nationality, safetyNeeds: row.safety_needs,
  };
  return {
    title: ctx?.title || "", date: ctx?.date || null, dateLabel: ctx ? dateLabel(ctx.date) : "",
    seats: Number(row.seats), needsNationality: !!ctx?.needsNationality, details,
    missing: missingForPledge(row, { needsNationality: !!ctx?.needsNationality }),
  };
}

export async function saveBookingDetailsByToken(token, body, db = pool) {
  const run = async (c) => {
    const row = await byToken(c, token, { forUpdate: true });
    const ctx = await catalogueContextFor(c, row.legacy_departure_id);
    const d = bookingDetailsFrom(body);
    assertBookingComplete(d, Number(row.seats), { needsNationality: !!ctx?.needsNationality });
    await c.query(
      `UPDATE pledges SET traveller_names = $2, customer_phone = $3, pickup_point = $4, nationality = $5, safety_needs = $6 WHERE id = $1`,
      [row.pledge_id, JSON.stringify(d.travelerNames), d.phone, d.pickupPoint, d.nationality, d.safetyNeeds]);
    await c.query("UPDATE booking_completion_requests SET completed_at = COALESCE(completed_at, now()) WHERE pledge_id = $1", [row.pledge_id]);
    return { pledgeId: row.pledge_id };
  };
  if (db !== pool) return run(db);
  const { withTransaction } = await import("./db/index.js");
  return withTransaction(run);
}

