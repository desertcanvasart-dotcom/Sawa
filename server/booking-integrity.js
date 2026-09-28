// Reservation integrity (migration 057), behind catalogue_v2: cluster flags.
// Never refuses a booking.
//
// Three or more single-seat reservations on one departure within 6 hours that
// share a device fingerprint, an IP range or a phone country code are flagged
// for staff, with the reason. Staff mark a flag "confirmed group" (the
// bookings are linked as a party), "suspicious" (its seats don't count towards
// GoAhead until reviewed) or clear it. (Email confirmation, once part of this,
// is live for every direct booking: server/booking-confirmation.js, 058.)
//
// Privacy (decided 28 Sep 2026): only a salted hash of the device fingerprint,
// the IP address cut to its /24 (IPv6: /48) and the phone's country calling
// code are stored, and they are deleted after 30 days (the reason values on a
// flag are blanked at the same time).
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError } from "./catalogue.js";
import { refreshStatus } from "./departure-status.js";
import { deviceHash, ipPrefix, phoneCountryCode } from "./booking-signals.js";

export { deviceHash, ipPrefix, phoneCountryCode };

export const CLUSTER_MIN = 3;
export const CLUSTER_WINDOW_HOURS = 6;
export const SIGNAL_RETENTION_DAYS = 30;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));

// Whether migration 057 is applied. Asked before any query that needs it, so
// a missing table never aborts the surrounding transaction.
export async function integrityAvailable(db) {
  return (await db.query("SELECT to_regclass('booking_flags') IS NOT NULL AS ok")).rows[0].ok === true;
}

// ---------------------------------------------------------------- signals
// What is stored (see booking-signals.js), and how each shows on a flag.
const KINDS = [
  { key: "device_hash", kind: "device", show: () => "same device" },
  { key: "ip_prefix", kind: "ip", show: (v) => v },
  { key: "phone_cc", kind: "phone_cc", show: (v) => v },
];

// Inside the booking's transaction: what the booking came with, already
// reduced (reduceSignals). `at`: when the form was submitted, for a booking
// made later from the email link (058), so the 6-hour window is the form's.
export async function recordSignals(c, { pledgeId, departureId, seats, signals, at = null }) {
  if (!signals) return;
  await c.query(
    `INSERT INTO booking_signals (pledge_id, departure_id, seats, device_hash, ip_prefix, phone_cc, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (pledge_id) DO NOTHING`,
    [pledgeId, departureId, seats, signals.deviceHash || null, signals.ipPrefix || null, signals.phoneCc || null, at]);
}

// After a booking: does it complete a cluster? Flags it (or grows the open
// flag it overlaps). Returns the flag, or null. Never refuses anything.
export async function detectCluster(c, { pledgeId }) {
  const me = (await c.query("SELECT * FROM booking_signals WHERE pledge_id = $1", [pledgeId])).rows[0];
  if (!me || Number(me.seats) !== 1) return null;
  const hits = [];
  for (const k of KINDS) {
    const v = me[k.key];
    if (!v) continue;
    const r = await c.query(
      // The window is compared in SQL: a JS Date drops the microseconds.
      `SELECT s.pledge_id FROM booking_signals s JOIN pledges p ON p.id = s.pledge_id
         JOIN booking_signals me ON me.pledge_id = $3
        WHERE s.departure_id = $1 AND s.seats = 1 AND p.status <> 'cancelled' AND s.${k.key} = $2
          AND s.created_at >= me.created_at - make_interval(hours => $4) AND s.created_at <= me.created_at
        ORDER BY s.created_at, s.pledge_id`, [me.departure_id, v, pledgeId, CLUSTER_WINDOW_HOURS]);
    if (r.rows.length >= CLUSTER_MIN) hits.push({ kind: k.kind, value: k.show(v), count: r.rows.length, members: r.rows.map((x) => x.pledge_id) });
  }
  if (!hits.length) return null;
  const members = [...new Set(hits.flatMap((h) => h.members))];
  const reasons = hits.map(({ kind, value, count }) => ({ kind, value, count, windowHours: CLUSTER_WINDOW_HOURS }));
  const overlap = (await c.query(
    `SELECT * FROM booking_flags WHERE departure_id = $1 AND pledge_ids && $2::text[] ORDER BY id DESC FOR UPDATE`, [me.departure_id, members])).rows;
  const live = overlap.find((f) => f.state === "open" || f.state === "suspicious");
  if (live) {
    const ids = [...new Set([...live.pledge_ids, ...members])];
    const merged = [...(live.reasons || []).filter((r) => !reasons.some((n) => n.kind === r.kind && n.value === r.value)), ...reasons];
    return (await c.query(
      "UPDATE booking_flags SET pledge_ids = $2, reasons = $3, updated_at = now() WHERE id = $1 RETURNING *", [live.id, ids, JSON.stringify(merged)])).rows[0];
  }
  // Already reviewed with exactly these bookings: nothing new to look at.
  if (overlap.some((f) => members.every((id) => f.pledge_ids.includes(id)))) return null;
  return (await c.query(
    "INSERT INTO booking_flags (departure_id, pledge_ids, reasons) VALUES ($1, $2, $3) RETURNING *",
    [me.departure_id, members, JSON.stringify(reasons)])).rows[0];
}

// Daily: signals older than 30 days are deleted, and the values on older flags
// blanked (the kind of reason stays, so a decision still reads).
export async function purgeSignals({ db = pool, now = Date.now() } = {}) {
  if (!(await integrityAvailable(db))) return { signalsPurged: 0 };
  const cutoff = new Date(now - SIGNAL_RETENTION_DAYS * DAY);
  const s = await db.query("DELETE FROM booking_signals WHERE created_at < $1", [cutoff]);
  await db.query(
    `UPDATE booking_flags SET reasons = (SELECT COALESCE(jsonb_agg(r - 'value'), '[]'::jsonb) FROM jsonb_array_elements(reasons) r)
      WHERE created_at < $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(reasons) r WHERE r ? 'value')`, [cutoff]);
  return { signalsPurged: s.rowCount };
}

// ---------------------------------------------------------------- staff
// Flags by departure (catalog departure id), for the admin calendar.
export async function flagsByDeparture(db, catalogueDepartureIds) {
  if (!catalogueDepartureIds.length || !(await integrityAvailable(db))) return new Map();
  const r = await db.query(
    `SELECT f.*, cd.id AS catalogue_departure_id,
            (SELECT COALESCE(SUM(p.seats), 0) FROM pledges p WHERE p.id = ANY (f.pledge_ids) AND p.status <> 'cancelled')::int AS seats,
            (SELECT json_agg(json_build_object('id', p.id, 'code', p.booking_code, 'name', p.customers, 'status', p.status) ORDER BY p.created_at)
               FROM pledges p WHERE p.id = ANY (f.pledge_ids)) AS bookings
       FROM booking_flags f JOIN catalogue_departures cd ON cd.legacy_departure_id = f.departure_id
      WHERE cd.id = ANY ($1::bigint[]) AND f.state IN ('open', 'suspicious')
      ORDER BY f.id`, [catalogueDepartureIds]);
  const m = new Map();
  for (const f of r.rows) {
    const k = Number(f.catalogue_departure_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({
      id: f.id, state: f.state, reasons: f.reasons || [], seats: f.seats, bookings: f.bookings || [],
      createdAt: f.created_at, decidedBy: f.decided_by, decidedAt: f.decided_at,
    });
  }
  return m;
}

export const FLAG_DECISIONS = ["confirmed_group", "suspicious", "cleared"];

// Staff decide a flag. "confirmed_group" links its live bookings as a party;
// "suspicious" holds its seats from GoAhead; "cleared" (also the review of a
// suspicious flag) counts them again. The date's status is recomputed.
export async function decideFlag(db, { flagId, decision, by, note = null, linkParty = null }) {
  if (!FLAG_DECISIONS.includes(decision)) throw new CatalogueError(422, "Choose confirmed group, suspicious or cleared.");
  if (!(await integrityAvailable(db))) throw new CatalogueError(503, "Reservation flags need migration 057. Apply it and try again.");
  return inTx(db, async (c) => {
    const pre = (await c.query("SELECT departure_id FROM booking_flags WHERE id = $1", [flagId])).rows[0];
    if (!pre) throw new CatalogueError(404, "Flag not found.");
    await c.query("SELECT id FROM departures WHERE id = $1 FOR UPDATE", [pre.departure_id]);
    const f = (await c.query("SELECT * FROM booking_flags WHERE id = $1 FOR UPDATE", [flagId])).rows[0];
    if (f.state === "confirmed_group" || f.state === "cleared") throw new CatalogueError(409, "This flag has already been decided.");
    if (decision === f.state) throw new CatalogueError(409, "This flag is already marked that way.");
    let party = null;
    if (decision === "confirmed_group") {
      const live = (await c.query("SELECT id FROM pledges WHERE id = ANY ($1::text[]) AND status <> 'cancelled'", [f.pledge_ids])).rows.map((x) => x.id);
      if (live.length >= 2 && linkParty) party = await linkParty(c, { pledgeIds: live, by });
    }
    await c.query(
      "UPDATE booking_flags SET state = $2, decided_by = $3, decided_at = now(), note = $4, updated_at = now() WHERE id = $1",
      [f.id, decision, by, note]);
    await refreshStatus(c, f.departure_id);
    return { flagId: f.id, departureId: Number(f.departure_id), state: decision, from: f.state, partyId: party?.partyId ?? null, bookings: f.pledge_ids };
  });
}
