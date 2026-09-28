// Merging duplicate departures (migration 055; live, legacy flow).
//
// A real case (27 Sep 2026): eleven travelers of one group booked the same tour
// and day separately, and each booking made its own date, so the site listed
// the day many times. The root cause is fixed in createDateRequest (an exact
// product and day now joins the date that exists); this tool cleans up the
// duplicates already made.
//
// Admin picks the date to keep and the duplicates (same product, same day).
// Everything moves to the kept date: the bookings (with their travelers'
// details and payments, which hang off the booking), the cost lines, Sawa's
// profit-share adjustments, and the ops notes. The seat count and GoAhead are
// worked out again. The duplicates are closed, point at the kept date (their
// old links redirect there) and leave the site. Each moved traveler gets one
// email. Everything is in the audit log, and a merge can be reverted within
// 24 hours.
//
// Refused: a different product or day; a catalog departure (settled by the
// rate card, one per product and day by construction); a canceled or closed
// date; a result bigger than the kept date's maximum group; a duplicate
// already settled (its cost sheet final or a loss decided) or paid out (in a
// Wednesday run); a kept date already paid out. When the duplicates are run
// by different agencies, admin chooses who runs the kept date, and sees the
// effect on the old profit split first.
import { pool, withDepartureWrites } from "./db/index.js";
import { mapPledge } from "./db/mappers.js";
import { refreshStatus } from "./departure-status.js";
import { settleDeparture } from "./settlement.js";
import { paymentsByPledge } from "./payments.js";
import { directOperatorId } from "./domain.js";
import { DIRECT_BOOKINGS_OPERATOR } from "./brand.js";
import { operatorOf, loadOperatorInputs } from "./operator-lookup.js";

export const REVERT_WINDOW_HOURS = 24;
const LIVE_STATES = ["pending_review", "open", "minimum_reached", "supplier_confirmed"];

export class MergeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const day = (r) => {
  const v = r.start_date || r.date;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
};
const has = async (db, table) => (await db.query("SELECT to_regclass($1) AS t", [`public.${table}`])).rows[0].t != null;
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// The departures and what hangs off them, read for a check or a merge.
async function readDepartures(db, ids, { lock = false } = {}) {
  const rows = (await db.query(
    `SELECT * FROM departures WHERE id = ANY($1::int[]) ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [ids])).rows;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const pledges = (await db.query(
    "SELECT * FROM pledges WHERE departure_id = ANY($1::int[]) ORDER BY created_at ASC, id ASC", [ids])).rows;
  const catalogue = (await has(db, "catalogue_departures")) ? new Set((await db.query(
    "SELECT legacy_departure_id AS id FROM catalogue_departures WHERE legacy_departure_id = ANY($1::int[])", [ids])).rows.map((r) => Number(r.id))) : new Set();
  const settled = new Set(), paidOut = new Set();
  if (await has(db, "departure_settlements")) {
    for (const r of (await db.query(
      "SELECT departure_id FROM departure_settlements WHERE departure_id = ANY($1::int[]) AND (costs_final_at IS NOT NULL OR loss_decided_at IS NOT NULL)", [ids])).rows) settled.add(Number(r.departure_id));
    for (const r of (await db.query("SELECT DISTINCT departure_id FROM payout_lines WHERE departure_id = ANY($1::int[])", [ids])).rows) paidOut.add(Number(r.departure_id));
  }
  return { rows, byId, pledges, catalogue, settled, paidOut };
}

const liveSeats = (pledges, depId) => pledges
  .filter((p) => Number(p.departure_id) === depId && p.status !== "cancelled")
  .reduce((n, p) => n + (Number(p.seats) || 0), 0);

// Every reason the merge can't go ahead, in plain words. Empty when it can.
function problemsOf({ keptId, duplicateIds, data }) {
  const out = [];
  const kept = data.byId.get(keptId);
  if (!kept) return ["The departure to keep wasn't found."];
  if (!duplicateIds.length) return ["Choose at least one duplicate to merge into it."];
  if (duplicateIds.includes(keptId)) out.push("The departure to keep can't also be a duplicate.");
  const all = [keptId, ...duplicateIds];
  for (const id of duplicateIds) {
    const d = data.byId.get(id);
    if (!d) { out.push(`Departure ${id} wasn't found.`); continue; }
    if (d.tour_product_id !== kept.tour_product_id) out.push(`Departure ${id} is a different tour.`);
    if (day(d) !== day(kept)) out.push(`Departure ${id} is on a different day (${day(d)}).`);
    if (d.merged_into_id) out.push(`Departure ${id} has already been merged.`);
    if (data.settled.has(id)) out.push(`Departure ${id} is already settled (its cost sheet is final or a loss was decided).`);
    if (data.paidOut.has(id)) out.push(`Departure ${id} has already been paid out in a Wednesday run.`);
  }
  for (const id of all) {
    const d = data.byId.get(id);
    if (!d) continue;
    if (!LIVE_STATES.includes(d.status)) out.push(`Departure ${id} is ${d.status}; only live dates can be merged.`);
    if (data.catalogue.has(id)) out.push(`Departure ${id} is a catalog departure; the catalog makes one per tour and day, so it is never merged here.`);
  }
  if (data.paidOut.has(keptId)) out.push(`The departure to keep (${keptId}) has already been paid out in a Wednesday run.`);
  // A date still awaiting review can be kept only if every duplicate is too:
  // otherwise open bookings would vanish from the site into a date nobody approved.
  if (kept.status === "pending_review" && duplicateIds.some((id) => data.byId.get(id) && data.byId.get(id).status !== "pending_review")) {
    out.push("Keep a date that is open (or going ahead): this one is still awaiting review, and some duplicates are already open.");
  }
  const seats = all.reduce((n, id) => n + liveSeats(data.pledges, id), 0);
  const max = Number(kept.max_seats) || 0;
  if (max && seats > max) out.push(`Together they hold ${seats} travelers; the kept date takes at most ${max}.`);
  return out;
}

// Who runs each date now (the U01 rule, or an earlier choice), and the choice
// admin must make when they differ.
async function operatorsOf(db, ids) {
  const out = [];
  for (const id of ids) {
    const op = await operatorOf(id, db);
    out.push({ departureId: id, agencyId: op?.id || null, name: op?.row?.name || null });
  }
  return out;
}

// The old profit split (044): headcount shares by agency, per date as they are
// and for the merged date. Figures as of now, on the money collected so far.
async function splitOf(db, ids, data) {
  const pledges = data.pledges.filter((p) => ids.includes(Number(p.departure_id)));
  const payments = (await has(db, "booking_payments")) ? await paymentsByPledge(db, pledges.map((p) => p.id)) : new Map();
  const costs = (await has(db, "departure_costs")) ? (await db.query(
    "SELECT * FROM departure_costs WHERE departure_id = ANY($1::int[])", [ids])).rows.map((r) => ({
    departureId: Number(r.departure_id), state: r.state, kind: r.kind || "cost", amount: Number(r.amount),
    approvedAmount: r.approved_amount != null ? Number(r.approved_amount) : null })) : [];
  const adjustments = (await has(db, "settlement_adjustments")) ? (await db.query(
    "SELECT * FROM settlement_adjustments WHERE departure_id = ANY($1::int[])", [ids])).rows.map((r) => ({
    departureId: Number(r.departure_id), agencyId: r.agency_id || null, amount: Number(r.amount) })) : [];
  const agencies = (await db.query("SELECT id, name FROM agencies")).rows;
  const inputs = await loadOperatorInputs(db);
  const ctx = { directAgencyId: directOperatorId(agencies, DIRECT_BOOKINGS_OPERATOR), referralAgencies: inputs.referralAgencies };
  const name = (id) => (id ? agencies.find((a) => a.id === id)?.name || id : "Sawa");
  const view = (s) => ({
    revenue: s.revenue, gross: s.gross, sawa: s.sawa.total, loss: s.loss,
    shares: s.shares.map((x) => ({ agencyId: x.agencyId, name: name(x.agencyId), seats: x.seats, pct: Math.round(x.pct * 1000) / 10, total: x.total })),
  });
  const before = ids.map((id) => {
    const mine = pledges.filter((p) => Number(p.departure_id) === id);
    const s = settleDeparture({
      pledges: mine.map((p) => mapPledge(p)), paymentsByPledge: payments,
      costs: costs.filter((c) => c.departureId === id), adjustments: adjustments.filter((a) => a.departureId === id), ...ctx,
    });
    return { departureId: id, ...view(s) };
  });
  const after = view(settleDeparture({
    pledges: pledges.map((p) => mapPledge(p)), paymentsByPledge: payments, costs, adjustments, ...ctx,
  }));
  // Per agency, what the separate dates would pay in total, against the merged date.
  const agenciesSeen = new Set([...before.flatMap((b) => b.shares.map((x) => x.agencyId)), ...after.shares.map((x) => x.agencyId)]);
  const byAgency = [...agenciesSeen].map((agencyId) => ({
    agencyId, name: name(agencyId),
    before: round2(before.reduce((n, b) => n + (b.shares.find((x) => x.agencyId === agencyId)?.total || 0), 0)),
    after: round2(after.shares.find((x) => x.agencyId === agencyId)?.total || 0),
  }));
  return { before, after, byAgency, sawaBefore: round2(before.reduce((n, b) => n + b.sawa, 0)), sawaAfter: after.sawa };
}

// What the merge would do, without doing it.
export async function mergePreview(db = pool, { keptId, duplicateIds }) {
  keptId = Number(keptId);
  duplicateIds = [...new Set((duplicateIds || []).map(Number).filter(Boolean))];
  const ids = [keptId, ...duplicateIds];
  const data = await readDepartures(db, ids);
  const problems = problemsOf({ keptId, duplicateIds, data });
  const kept = data.byId.get(keptId);
  const operators = kept ? await operatorsOf(db, ids.filter((id) => data.byId.has(id))) : [];
  const distinct = [...new Set(operators.map((o) => o.agencyId).filter(Boolean))];
  const seats = ids.reduce((n, id) => n + liveSeats(data.pledges, id), 0);
  return {
    ok: problems.length === 0, problems,
    kept: kept ? { id: keptId, route: kept.route, day: day(kept), status: kept.status, minSeats: Number(kept.min_seats), maxSeats: Number(kept.max_seats) } : null,
    departures: ids.filter((id) => data.byId.has(id)).map((id) => ({
      id, status: data.byId.get(id).status, seats: liveSeats(data.pledges, id),
      bookings: data.pledges.filter((p) => Number(p.departure_id) === id && p.status !== "cancelled").length,
      operator: operators.find((o) => o.departureId === id) || null,
    })),
    seatsAfter: seats,
    goAheadAfter: kept ? seats >= Math.max(1, Number(kept.min_seats) || 4) : false,
    operators, needsOperatorChoice: distinct.length > 1, operatorChoices: distinct.map((id) => ({ agencyId: id, name: operators.find((o) => o.agencyId === id)?.name || id })),
    split: kept && !problems.length ? await splitOf(db, ids, data) : null,
  };
}

// Merge. Returns the merge record and the bookings moved (for the emails,
// which the caller sends once the transaction has committed).
export async function mergeDepartures({ keptId, duplicateIds, operatorAgencyId = null, by }) {
  keptId = Number(keptId);
  duplicateIds = [...new Set((duplicateIds || []).map(Number).filter(Boolean))];
  const ids = [keptId, ...duplicateIds].sort((a, b) => a - b);
  return withDepartureWrites(async (c, touch) => {
    // Locked in id order, the same order every writer takes.
    const data = await readDepartures(c, ids, { lock: true });
    const problems = problemsOf({ keptId, duplicateIds, data });
    if (problems.length) throw new MergeError(409, problems.join(" "));
    const operators = await operatorsOf(c, ids);
    const distinct = [...new Set(operators.map((o) => o.agencyId).filter(Boolean))];
    if (distinct.length > 1 && !distinct.includes(operatorAgencyId)) {
      throw new MergeError(422, "These dates are run by different agencies. Choose who runs the kept date.");
    }
    const kept = data.byId.get(keptId);
    const moved = data.pledges.filter((p) => duplicateIds.includes(Number(p.departure_id)));
    // Bookings still awaiting review move onto an open date: approving the date
    // they were on is what the merge amounts to.
    const approve = kept.status !== "pending_review";
    const costs = (await has(c, "departure_costs")) ? (await c.query("SELECT id, departure_id FROM departure_costs WHERE departure_id = ANY($1::int[])", [duplicateIds])).rows : [];
    const adjustments = (await has(c, "settlement_adjustments")) ? (await c.query("SELECT id, departure_id FROM settlement_adjustments WHERE departure_id = ANY($1::int[])", [duplicateIds])).rows : [];
    // Bookings still waiting for their email confirmation (migration 058) move
    // too: their link then makes the booking on the kept date, instead of
    // failing with "book on that one".
    const held = (await has(c, "booking_confirmations")) ? (await c.query(
      "SELECT id, departure_id FROM booking_confirmations WHERE departure_id = ANY($1::int[]) AND status = 'unconfirmed'", [duplicateIds])).rows : [];
    const snapshot = {
      kept: { status: kept.status, notes: kept.notes, operatorAgencyOverride: kept.operator_agency_override || null },
      duplicates: duplicateIds.map((id) => ({ id, status: data.byId.get(id).status })),
      pledges: moved.map((p) => ({ id: p.id, from: Number(p.departure_id), status: p.status })),
      costs: costs.map((r) => ({ id: Number(r.id), from: Number(r.departure_id) })),
      adjustments: adjustments.map((r) => ({ id: Number(r.id), from: Number(r.departure_id) })),
      held: held.map((r) => ({ id: Number(r.id), from: Number(r.departure_id) })),
    };
    await c.query("UPDATE pledges SET departure_id = $1 WHERE departure_id = ANY($2::int[])", [keptId, duplicateIds]);
    if (approve) await c.query("UPDATE pledges SET status = 'confirmed' WHERE id = ANY($1::text[]) AND status = 'pending'", [moved.map((p) => p.id)]);
    if (costs.length) await c.query("UPDATE departure_costs SET departure_id = $1 WHERE departure_id = ANY($2::int[])", [keptId, duplicateIds]);
    if (adjustments.length) await c.query("UPDATE settlement_adjustments SET departure_id = $1 WHERE departure_id = ANY($2::int[])", [keptId, duplicateIds]);
    if (held.length) await c.query("UPDATE booking_confirmations SET departure_id = $1 WHERE id = ANY($2::int[])", [keptId, held.map((r) => Number(r.id))]);
    const extraNotes = duplicateIds.map((id) => data.byId.get(id)).filter((d) => String(d.notes || "").trim())
      .map((d) => `Merged from departure ${d.id}: ${String(d.notes).trim()}`);
    await c.query(
      "UPDATE departures SET notes = $2, operator_agency_override = $3 WHERE id = $1",
      [keptId, [kept.notes, ...extraNotes].filter((x) => String(x || "").trim()).join("\n") || null,
        distinct.length > 1 ? operatorAgencyId : kept.operator_agency_override || null]);
    await c.query("UPDATE departures SET status = 'closed', merged_into_id = $1 WHERE id = ANY($2::int[])", [keptId, duplicateIds]);
    await refreshStatus(c, keptId);
    for (const id of ids) touch(id);
    const rec = (await c.query(
      `INSERT INTO departure_merges (kept_departure_id, merged_departure_ids, snapshot, operator_agency_id, moved_bookings, merged_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [keptId, duplicateIds, JSON.stringify(snapshot), distinct.length > 1 ? operatorAgencyId : null, moved.length, by || null])).rows[0];
    const keptNow = (await c.query("SELECT * FROM departures WHERE id = $1", [keptId])).rows[0];
    return {
      merge: { id: Number(rec.id), keptId, duplicateIds, movedBookings: moved.length, operatorAgencyId: rec.operator_agency_id, mergedAt: rec.merged_at },
      kept: { id: keptId, route: keptNow.route, day: day(keptNow), status: keptNow.status, tourProductId: keptNow.tour_product_id },
      moved: moved.filter((p) => p.status !== "cancelled").map((p) => ({
        id: p.id, email: p.customer_email || null, name: p.customers || null, bookingCode: p.booking_code || null, from: Number(p.departure_id),
      })),
    };
  });
}

// Undo a merge within 24 hours: the bookings, cost lines and adjustments go
// back to the dates they came from, which reopen as they were; the kept date's
// notes, operator and status are restored. Refused once the kept date is
// settled or paid out, or once a moved booking has been moved again.
export async function revertMerge({ mergeId, by, now = Date.now() }) {
  return withDepartureWrites(async (c, touch) => {
    const m = (await c.query("SELECT * FROM departure_merges WHERE id = $1 FOR UPDATE", [mergeId])).rows[0];
    if (!m) throw new MergeError(404, "Merge not found.");
    if (m.reverted_at) throw new MergeError(409, "This merge has already been reverted.");
    if (now - new Date(m.merged_at).getTime() > REVERT_WINDOW_HOURS * 3600000) {
      throw new MergeError(409, `A merge can be reverted only within ${REVERT_WINDOW_HOURS} hours.`);
    }
    const keptId = Number(m.kept_departure_id);
    const dupIds = m.merged_departure_ids.map(Number);
    const ids = [keptId, ...dupIds].sort((a, b) => a - b);
    const data = await readDepartures(c, ids, { lock: true });
    if (data.settled.has(keptId) || data.paidOut.has(keptId)) {
      throw new MergeError(409, "The kept date has been settled or paid out since the merge, so it can't be reverted.");
    }
    const snap = m.snapshot;
    const stray = snap.pledges.filter((p) => {
      const now2 = data.pledges.find((x) => x.id === p.id);
      return !now2 || Number(now2.departure_id) !== keptId;
    });
    if (stray.length) throw new MergeError(409, `Booking${stray.length === 1 ? "" : "s"} ${stray.map((p) => p.id).join(", ")} moved again since the merge, so it can't be reverted.`);
    for (const p of snap.pledges) {
      await c.query("UPDATE pledges SET departure_id = $2 WHERE id = $1", [p.id, p.from]);
      if (p.status === "pending") await c.query("UPDATE pledges SET status = 'pending' WHERE id = $1 AND status = 'confirmed'", [p.id]);
    }
    for (const r of snap.costs || []) await c.query("UPDATE departure_costs SET departure_id = $2 WHERE id = $1", [r.id, r.from]);
    for (const r of snap.adjustments || []) await c.query("UPDATE settlement_adjustments SET departure_id = $2 WHERE id = $1", [r.id, r.from]);
    for (const r of snap.held || []) await c.query("UPDATE booking_confirmations SET departure_id = $2 WHERE id = $1", [r.id, r.from]);
    for (const d of snap.duplicates) {
      await c.query("UPDATE departures SET status = $2, merged_into_id = NULL WHERE id = $1", [d.id, d.status]);
    }
    await c.query("UPDATE departures SET notes = $2, operator_agency_override = $3, status = $4 WHERE id = $1",
      [keptId, snap.kept.notes, snap.kept.operatorAgencyOverride, snap.kept.status]);
    for (const id of ids) { await refreshStatus(c, id); touch(id); }
    await c.query("UPDATE departure_merges SET reverted_at = $2, reverted_by = $3 WHERE id = $1", [mergeId, new Date(now), by || null]);
    return { mergeId: Number(mergeId), keptId, restored: dupIds, bookings: snap.pledges.length };
  });
}

// One email to each moved traveler, once the merge has committed: same tour,
// same day, the booking unchanged, and the booking page. Returns how many were
// sent, and records it on the merge.
export async function emailMovedTravelers(db, out, { send, template, base = "" }) {
  const root = String(base || "").replace(/\/$/, "");
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${out.kept.day}T12:00:00Z`));
  let emailed = 0;
  for (const p of out.moved) {
    if (!p.email) continue;
    const res = await send(template({
      to: p.email, name: p.name, route: out.kept.route, dateLabel, bookingCode: p.bookingCode,
      url: p.bookingCode ? `${root}/booking/${encodeURIComponent(p.bookingCode)}` : root,
    })).catch((e) => ({ ok: false, error: e.message }));
    if (res?.ok !== false) emailed += 1;
  }
  await db.query("UPDATE departure_merges SET emailed = $2 WHERE id = $1", [out.merge.id, emailed]);
  return emailed;
}

// Where an old link to a merged date should go: follows a chain of merges.
export async function mergedTarget(db, departureId) {
  let id = Number(departureId);
  for (let i = 0; i < 5; i++) {
    const r = (await db.query("SELECT merged_into_id FROM departures WHERE id = $1", [id]).catch(() => ({ rows: [] }))).rows[0];
    if (!r?.merged_into_id) return i === 0 ? null : id;
    id = Number(r.merged_into_id);
  }
  return id;
}

// Recent merges, for the admin list (revert while within the window).
export async function listMerges(db = pool, { limit = 50 } = {}) {
  if (!(await has(db, "departure_merges"))) return [];
  return (await db.query("SELECT * FROM departure_merges ORDER BY merged_at DESC LIMIT $1", [limit])).rows.map((m) => ({
    id: Number(m.id), keptId: Number(m.kept_departure_id), duplicateIds: m.merged_departure_ids.map(Number),
    movedBookings: m.moved_bookings, emailed: m.emailed, operatorAgencyId: m.operator_agency_id,
    mergedBy: m.merged_by, mergedAt: m.merged_at, revertedAt: m.reverted_at, revertedBy: m.reverted_by,
    revertibleUntil: new Date(new Date(m.merged_at).getTime() + REVERT_WINDOW_HOURS * 3600000).toISOString(),
  }));
}
