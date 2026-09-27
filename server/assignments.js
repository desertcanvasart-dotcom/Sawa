// Assignment and manifest (model phase 2).
//
//   GoAhead → assign to the operator on the published roster for that product
//   and date → portal notice + email → the operator acknowledges within 12
//   hours. No roster entry, or no acknowledgement: an admin alert; a missed
//   acknowledgement is also a strike, and an admin may reassign to another
//   active operator approved for the product.
//
//   The manifest updates live until the cut-off and is frozen there. An
//   operator sees only departures assigned to it; every view is logged; access
//   ends 90 days after the departure.
//
// No money moves: the expected operator amount is shown, never paid.
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CatalogueError, todayIn, departureInstants, mapCatalogueProduct } from "./catalogue.js";
import { rosteredOperator } from "./roster.js";
import { rosterEligibility, addStrike, notifyOperator, operatorRecipients } from "./operators.js";
import { rateById, lockRatesForSoldDepartures } from "./rates.js";
import { ACK_HOURS, MANIFEST_ACCESS_DAYS, expectedOperatorAmount, roomsFor } from "../shared/operators.js";
import { shiftDate } from "../shared/catalogue.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const HOUR_MS = 3600000;
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
const portalUrl = () => `${site()}/portal`;
const when = (ms) => new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date(ms)) + " Cairo time";
const dateLabel = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${ymd(d)}T12:00:00Z`));

export function mapAssignment(r) {
  return {
    id: Number(r.id), departureId: Number(r.departure_id), operatorId: Number(r.operator_id), state: r.state, source: r.source,
    assignedBy: r.assigned_by, assignedAt: r.assigned_at, ackDueAt: r.ack_due_at, acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by, expiredAt: r.expired_at, replacedAt: r.replaced_at,
    manifestAccessRevokedAt: r.manifest_access_revoked_at,
  };
}

async function departureContext(c, departureId) {
  const r = await c.query(
    `SELECT cd.*, s.seats_sold, c.*, cd.id AS dep_id, cd.status AS dep_status, c.id AS product_id_,
            sv.version AS spec_version, t.default_time, t.nights
       FROM catalogue_departures cd
       JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
       JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN catalogue_spec_versions sv ON sv.id = cd.spec_version_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE cd.id = $1`, [departureId]);
  const row = r.rows[0];
  if (!row) throw new CatalogueError(404, "Departure not found.");
  const product = mapCatalogueProduct({ ...row, id: row.product_id_, status: row.status });
  return {
    id: Number(row.dep_id), date: ymd(row.date), status: row.dep_status, seatsSold: Number(row.seats_sold) || 0,
    legacyDepartureId: row.legacy_departure_id, rateVersionId: row.rate_version_id == null ? null : Number(row.rate_version_id),
    runBelowMinimum: row.run_below_minimum, specVersion: row.spec_version, startTime: row.default_time, nights: row.nights || 0,
    product,
  };
}

async function alertAdmin(c, { departure, kind, detail = {}, send }) {
  const ins = await c.query(
    `INSERT INTO catalogue_admin_alerts (departure_id, kind, detail) VALUES ($1, $2, $3)
     ON CONFLICT (departure_id, kind) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
    [departure.id, kind, JSON.stringify(detail)]);
  if (!ins.rows.length || !send) return;
  const { catalogueAdminAlertEmail, opsRecipient } = await import("./email.js");
  const res = await send(catalogueAdminAlertEmail({
    to: opsRecipient(), kind, title: departure.product.title, dateLabel: dateLabel(departure.date), detail, portalUrl: portalUrl(),
  })).catch((e) => ({ ok: false, error: e.message }));
  if (res?.ok) await c.query("UPDATE catalogue_admin_alerts SET emailed_at = now() WHERE id = $1", [ins.rows[0].id]);
}

async function offer(c, { departure, operatorId, source, by, now, send }) {
  const r = await c.query(
    `INSERT INTO catalogue_assignments (departure_id, operator_id, source, assigned_by, ack_due_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [departure.id, operatorId, source, by, new Date(now + ACK_HOURS * HOUR_MS)]);
  const a = mapAssignment(r.rows[0]);
  const op = (await c.query("SELECT legal_name FROM operators WHERE id = $1", [operatorId])).rows[0];
  const ackBy = when(now + ACK_HOURS * HOUR_MS);
  const body = `${departure.product.title} on ${dateLabel(departure.date)} · specification v${departure.specVersion ?? "—"} · `
    + `${departure.seatsSold} seat${departure.seatsSold === 1 ? "" : "s"} sold so far. Please acknowledge by ${ackBy}.`;
  const recipients = send ? await operatorRecipients(c, operatorId) : [];
  const { operatorAssignmentEmail } = await import("./email.js");
  // Portal notice once; an email to each address the operator has.
  await notifyOperator(c, {
    operatorId, kind: "assignment", title: `New assignment: ${departure.product.title}`, body,
    departureId: departure.id, dedupeKey: `assignment:${a.id}`,
    email: recipients[0] ? operatorAssignmentEmail({
      to: recipients[0], operatorName: op?.legal_name || "", title: departure.product.title, dateLabel: dateLabel(departure.date),
      specVersion: departure.specVersion, seats: departure.seatsSold, ackBy, portalUrl: portalUrl(),
    }) : null,
    send,
  });
  for (const to of recipients.slice(1)) {
    await send(operatorAssignmentEmail({
      to, operatorName: op?.legal_name || "", title: departure.product.title, dateLabel: dateLabel(departure.date),
      specVersion: departure.specVersion, seats: departure.seatsSold, ackBy, portalUrl: portalUrl(),
    })).catch(() => ({ ok: false }));
  }
  return a;
}

// GoAhead events → assignments (or an admin alert). Once per event.
export async function processGoAheadEvents({ db = pool, now = Date.now(), send = null, log = () => {} } = {}) {
  const events = await db.query(
    "SELECT * FROM catalogue_events WHERE type = 'go_ahead' AND processed_at IS NULL ORDER BY id");
  const out = { assigned: 0, alerted: 0 };
  for (const ev of events.rows) {
    const result = await inTx(db, async (c) => {
      const lock = await c.query("SELECT id FROM catalogue_events WHERE id = $1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED", [ev.id]);
      if (!lock.rows.length) return null;
      const departure = await departureContext(c, Number(ev.departure_id));
      const live = await c.query("SELECT 1 FROM catalogue_assignments WHERE departure_id = $1 AND state IN ('offered', 'acknowledged')", [departure.id]);
      let r = null;
      if (!live.rows.length) {
        const rostered = await rosteredOperator(c, departure.product.id, departure.date);
        const ok = rostered ? await rosterEligibility(c, rostered.operatorId, departure.product.id) : { ok: false };
        if (rostered && ok.ok) {
          await offer(c, { departure, operatorId: rostered.operatorId, source: "roster", by: "roster", now, send });
          r = "assigned";
        } else {
          await alertAdmin(c, {
            departure, kind: "no_rostered_operator", send,
            detail: rostered ? { operatorId: rostered.operatorId, reason: ok.reason } : { reason: "No operator on a published roster for this date." },
          });
          r = "alerted";
        }
      }
      await c.query("UPDATE catalogue_events SET processed_at = now() WHERE id = $1", [ev.id]);
      return r;
    });
    if (result === "assigned") out.assigned += 1;
    if (result === "alerted") out.alerted += 1;
  }
  if (out.assigned || out.alerted) log(`assignments: ${out.assigned} assigned, ${out.alerted} need an admin`);
  return out;
}

// Offers not acknowledged in time: expired, a strike, an admin alert.
export async function expireAcknowledgements({ db = pool, now = Date.now(), send = null, log = () => {} } = {}) {
  const due = await db.query(
    "SELECT * FROM catalogue_assignments WHERE state = 'offered' AND ack_due_at <= $1 ORDER BY id", [new Date(now)]);
  let expired = 0;
  for (const row of due.rows) {
    await inTx(db, async (c) => {
      const upd = await c.query(
        "UPDATE catalogue_assignments SET state = 'expired', expired_at = now() WHERE id = $1 AND state = 'offered' RETURNING *", [row.id]);
      if (!upd.rowCount) return;
      expired += 1;
      const departure = await departureContext(c, Number(row.departure_id));
      const op = (await c.query("SELECT legal_name FROM operators WHERE id = $1", [row.operator_id])).rows[0];
      await addStrike(c, {
        operatorId: Number(row.operator_id), kind: "missed_acknowledgement", departureId: departure.id, assignmentId: Number(row.id),
        note: `Not acknowledged within ${ACK_HOURS} hours (due ${new Date(row.ack_due_at).toISOString()}).`, by: "system",
      });
      await notifyOperator(c, {
        operatorId: Number(row.operator_id), kind: "missed_acknowledgement",
        title: `Not acknowledged: ${departure.product.title} on ${dateLabel(departure.date)}`,
        body: `This assignment wasn't acknowledged within ${ACK_HOURS} hours. It counts as a strike, and Sawa may assign the departure to another operator.`,
        departureId: departure.id, dedupeKey: `missed_ack:${row.id}`,
      });
      await alertAdmin(c, { departure, kind: "missed_acknowledgement", send, detail: { operatorId: Number(row.operator_id), operatorName: op?.legal_name } });
    });
  }
  if (expired) log(`assignments: ${expired} not acknowledged in time (strike recorded)`);
  return { expired };
}

export async function acknowledge(db, { assignmentId, operatorId, by, now = Date.now() }) {
  return inTx(db, async (c) => {
    const r = await c.query("SELECT * FROM catalogue_assignments WHERE id = $1 FOR UPDATE", [assignmentId]);
    const a = r.rows[0];
    if (!a || Number(a.operator_id) !== Number(operatorId)) throw new CatalogueError(404, "Assignment not found.");
    if (a.state === "acknowledged") return mapAssignment(a);
    if (a.state !== "offered") throw new CatalogueError(409, "This assignment is no longer yours to acknowledge. Contact Sawa.");
    if (new Date(a.ack_due_at).getTime() <= now) throw new CatalogueError(409, "The time to acknowledge has passed. Contact Sawa.");
    const upd = await c.query(
      `UPDATE catalogue_assignments SET state = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 RETURNING *`,
      [assignmentId, by]);
    return mapAssignment(upd.rows[0]);
  });
}

// An admin assigns (or reassigns) a departure to another operator. The live
// assignment, if any, is replaced; open alerts for the departure are resolved.
export async function assignByAdmin(db, { departureId, operatorId, by, now = Date.now(), send = null }) {
  return inTx(db, async (c) => {
    const departure = await departureContext(c, departureId);
    if (departure.status !== "go_ahead") throw new CatalogueError(409, "Only a departure that is going ahead can be assigned.");
    const ok = await rosterEligibility(c, operatorId, departure.product.id);
    if (!ok.ok) throw new CatalogueError(422, ok.reason);
    const live = (await c.query(
      "SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND state IN ('offered', 'acknowledged') FOR UPDATE", [departureId])).rows[0];
    if (live && Number(live.operator_id) === Number(operatorId)) throw new CatalogueError(409, "That operator already has this departure.");
    if (live) {
      await c.query("UPDATE catalogue_assignments SET state = 'replaced', replaced_at = now() WHERE id = $1", [live.id]);
      await notifyOperator(c, {
        operatorId: Number(live.operator_id), kind: "unassigned",
        title: `No longer assigned: ${departure.product.title} on ${dateLabel(departure.date)}`,
        body: "Sawa has assigned this departure to another operator.", departureId, dedupeKey: `replaced:${live.id}`,
      });
    }
    const a = await offer(c, { departure, operatorId, source: "admin", by, now, send });
    await c.query(
      "UPDATE catalogue_admin_alerts SET resolved_at = now(), resolved_by = $2 WHERE departure_id = $1 AND resolved_at IS NULL", [departureId, by]);
    return a;
  });
}

// ---------------------------------------------------------------- manifest
// One row per traveler, from the bookings on the departure. Only what the
// operator needs to run it: name, pickup point, a contact number (the lead
// traveler's), nationality where the product's tickets need it, and
// safety-related needs. No email, no price.
export function manifestRows(pledges, { needsNationality = false } = {}) {
  const rows = [];
  for (const p of pledges) {
    const names = Array.isArray(p.traveller_names) ? p.traveller_names.map((n) => String(n || "").trim()).filter(Boolean) : [];
    const lead = String(p.customers || "").trim();
    const seats = Math.max(1, Number(p.seats) || 1);
    for (let i = 0; i < seats; i++) {
      rows.push({
        booking: p.booking_code || String(p.id).slice(-8),
        name: names[i] || (i === 0 ? lead : `${lead || "Guest"}, guest ${i + 1}`),
        lead: i === 0,
        pickupPoint: p.pickup_point || null,
        contactNumber: i === 0 ? (p.customer_phone || null) : null,
        nationality: needsNationality ? (p.nationality || null) : undefined,
        safetyNeeds: i === 0 ? (p.safety_needs || null) : null,
        canceledAfterCutoff: p.status === "cancelled" || undefined,
      });
    }
  }
  return rows;
}

async function livePledges(c, legacyDepartureId) {
  if (!legacyDepartureId) return [];
  return (await c.query(
    "SELECT * FROM pledges WHERE departure_id = $1 AND status <> 'cancelled' ORDER BY created_at, id", [legacyDepartureId])).rows;
}

// At the cut-off, a going-ahead departure's manifest is frozen: from then on
// the band and the per-traveler count are fixed, and late cancellations and
// no-shows still count.
export async function freezeManifests({ db = pool, now = Date.now(), log = () => {} } = {}) {
  const r = await db.query(
    `SELECT cd.id FROM catalogue_departures cd
      WHERE cd.status = 'go_ahead' AND NOT EXISTS (SELECT 1 FROM catalogue_manifests m WHERE m.departure_id = cd.id)
        AND cd.date <= $1::date + 120`, [todayIn(now)]);
  let frozen = 0;
  for (const { id } of r.rows) {
    await inTx(db, async (c) => {
      const d = await departureContext(c, Number(id));
      const { cutoffAt } = departureInstants(d, d.product, { startTime: d.startTime, nights: d.nights });
      if (!(now >= cutoffAt)) return;
      const pledges = await livePledges(c, d.legacyDepartureId);
      const travelers = manifestRows(pledges, { needsNationality: d.product.needsNationality });
      const rooms = roomsFor(pledges.map((p) => ({ seats: p.seats, roomingType: p.rooming_type })));
      const ins = await c.query(
        `INSERT INTO catalogue_manifests (departure_id, seat_count, travelers, rooms) VALUES ($1, $2, $3, $4)
         ON CONFLICT (departure_id) DO NOTHING`,
        [d.id, travelers.length, JSON.stringify(travelers), JSON.stringify(rooms)]);
      frozen += ins.rowCount;
    });
  }
  if (frozen) log(`manifests: ${frozen} frozen at cut-off`);
  return { frozen };
}

// The manifest an operator (or admin) sees. `operatorId` set = an operator:
// only its own live assignment, only within the access window, and the view
// is logged.
export async function manifestFor(db, { departureId, operatorId = null, user = null, now = Date.now() }) {
  return inTx(db, async (c) => {
    const d = await departureContext(c, departureId);
    let assignment = null;
    if (operatorId != null) {
      assignment = (await c.query(
        `SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND operator_id = $2 AND state IN ('offered', 'acknowledged')`,
        [departureId, operatorId])).rows[0];
      if (!assignment) throw new CatalogueError(404, "This departure isn't assigned to you.");
      if (assignment.manifest_access_revoked_at) throw new CatalogueError(410, "Access to this manifest ended 90 days after the departure.");
    }
    const frozen = (await c.query("SELECT * FROM catalogue_manifests WHERE departure_id = $1", [departureId])).rows[0];
    const travelers = frozen ? frozen.travelers
      : manifestRows(await livePledges(c, d.legacyDepartureId), { needsNationality: d.product.needsNationality });
    if (operatorId != null) {
      await c.query(
        `INSERT INTO manifest_access_log (departure_id, operator_id, user_id, user_email, frozen) VALUES ($1, $2, $3, $4, $5)`,
        [departureId, operatorId, user?.id || null, user?.email || null, !!frozen]);
    }
    return {
      departure: { id: d.id, date: d.date, title: d.product.title, code: d.product.code, specVersion: d.specVersion },
      frozen: !!frozen, frozenAt: frozen?.frozen_at || null, seatCount: travelers.length, travelers,
    };
  });
}

// Removes operator access to manifests 90 days after the departure ended.
// (Sawa keeps its own record; retention of that is a separate decision.)
export async function revokeExpiredManifestAccess({ db = pool, now = Date.now() } = {}) {
  const cutoff = shiftDate(todayIn(now), -MANIFEST_ACCESS_DAYS);
  const r = await db.query(
    `UPDATE catalogue_assignments a SET manifest_access_revoked_at = now()
       FROM catalogue_departures cd
       JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE a.departure_id = cd.id AND a.manifest_access_revoked_at IS NULL
        AND (cd.date + COALESCE(t.nights, 0)) < $1::date`, [cutoff]);
  return { revoked: r.rowCount };
}

// ---------------------------------------------------------------- amount
// The expected operator amount for a departure, from its locked rate version
// and its manifest: live before the cut-off, frozen after. Display only.
export async function expectedAmountFor(db, departureId) {
  const d = await departureContext(db, departureId);
  const rate = await rateById(db, d.rateVersionId);
  const frozen = (await db.query("SELECT seat_count, rooms FROM catalogue_manifests WHERE departure_id = $1", [departureId])).rows[0];
  let count;
  let rooms;
  if (frozen) {
    count = Number(frozen.seat_count);
    rooms = frozen.rooms || {};
  } else {
    const pledges = await livePledges(db, d.legacyDepartureId);
    count = pledges.reduce((s, p) => s + (Number(p.seats) || 0), 0);
    rooms = roomsFor(pledges.map((p) => ({ seats: p.seats, roomingType: p.rooming_type })));
  }
  const result = expectedOperatorAmount({ type: d.product.type, rate, bandCount: count, perHeadCount: count, rooms });
  return { ...result, currency: "EGP", rateVersion: rate?.version ?? null, frozen: !!frozen, travelers: count };
}

// ---------------------------------------------------------------- the tick
// Run by the scheduler with the catalogue status job, behind catalogue_v2.
export async function runAssignmentTick({ db = pool, now = Date.now(), send = null, log = () => {} } = {}) {
  const locked = await lockRatesForSoldDepartures(db, now);
  const frozen = await freezeManifests({ db, now, log });
  const assigned = await processGoAheadEvents({ db, now, send, log });
  const expired = await expireAcknowledgements({ db, now, send, log });
  return { ratesLocked: locked, ...frozen, ...assigned, ...expired };
}
