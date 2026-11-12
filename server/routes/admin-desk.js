// The admin desk: the audit trail, the dashboard numbers, every booking on the platform, and linking bookings into a party
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { partiesAvailable, linkParty, unlinkParty } from "../booking-parties.js";
import { pool, withDepartureWrites } from "../db/index.js";
import { refreshStatus } from "../departure-status.js";
import { departureActionBuckets, seatsTotal } from "../domain.js";
import { catalogueV2Enabled } from "../features.js";
import { routeContext } from "../route-context.js";

const {
  app, h, AppError, loadDeparture, parse,
} = routeContext();

// Admin: recent audit trail (who did what, when).
app.get("/api/admin/audit", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const r = await pool.query(
    `SELECT actor_email, actor_role, action, entity, entity_id, detail, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ entries: r.rows });
}));

// Admin: dashboard overview stats (platform staff).
app.get("/api/admin/stats", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const [deps, pledges, products, agencies] = await Promise.all([
    pool.query(`SELECT id, status, date, start_date, time, type, route, min_seats, max_seats FROM departures`),
    // status is needed to exclude cancelled bookings — without it these totals
    // counted cancelled seats as booked and cancelled bookings as revenue, and
    // seatsByDep (below) mis-drove readyToConfirm / atRisk. The Bookings tab
    // already excluded them, so Overview and Bookings disagreed on the same
    // figures. Same rule as domain.js seatsTotal().
    pool.query(`SELECT departure_id, seats, booking_total, deposit_due, source, created_at, status FROM pledges`),
    pool.query(`SELECT id, type, active, status FROM tour_products`),
    pool.query(`SELECT id FROM agencies WHERE status='active'`),
  ]);
  const pendingListings = products.rows.filter((p) => p.status === "pending").length;
  // Requests for a group larger than the online maximum, not yet answered (0 before migration 062).
  // Reviews sent by travelers, waiting to be published (0 before migration 069).
  let pendingReviews = 0;
  try {
    pendingReviews = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM customer_reviews WHERE status = 'submitted'`)).rows[0]?.n) || 0;
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }
  let pendingGroupRequests = 0;
  try {
    pendingGroupRequests = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM group_requests WHERE status = 'new'`)).rows[0]?.n) || 0;
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }

  const livePledges = pledges.rows.filter((p) => p.status !== "cancelled");
  const seatsByDep = new Map();
  let totalSeats = 0, totalRevenue = 0, totalDeposits = 0;
  const bookingsCount = livePledges.length;
  const cancelledCount = pledges.rows.length - bookingsCount;
  const now = new Date();
  const weekAhead = new Date(now); weekAhead.setDate(now.getDate() + 7);
  let bookingsThisWeek = 0;
  for (const p of livePledges) {
    seatsByDep.set(p.departure_id, (seatsByDep.get(p.departure_id) || 0) + Number(p.seats));
    totalSeats += Number(p.seats);
    totalRevenue += Number(p.booking_total || 0);
    totalDeposits += Number(p.deposit_due || 0);
    if (p.created_at && new Date(p.created_at) >= new Date(now.getTime() - 7 * 864e5)) bookingsThisWeek++;
  }

  // PP3 — the bucketing lives in domain.js so it can be tested; see the note
  // there for what it used to count.
  const { forming, awaiting, readyToConfirm, confirmed, atRisk, departed } =
    departureActionBuckets(deps.rows, (id) => seatsByDep.get(id) || 0, now.getTime());

  res.json({
    totals: {
      departures: deps.rows.length,
      dayTours: products.rows.filter((p) => p.type === "day_tour").length,
      packages: products.rows.filter((p) => p.type === "package").length,
      activeProducts: products.rows.filter((p) => p.active !== false).length,
      agencies: agencies.rows.length,
      bookings: bookingsCount,
      cancelledBookings: cancelledCount,
      bookingsThisWeek,
      seatsPooled: totalSeats,
      revenue: totalRevenue,
      depositsDue: totalDeposits,
    },
    pendingListings,
    pendingGroupRequests,
    pendingReviews,
    departureStatus: { forming, awaiting, readyToConfirm, confirmed, atRisk, departed },
  });
}));

// Admin: all bookings across the platform (platform staff).
app.get("/api/admin/bookings", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  // Return the true row count alongside the page. The dashboard was computing
  // its "Booking value" / "Seats booked" KPIs from whatever this returned and
  // labelling them as platform totals, so past the limit the headline figures
  // silently became "the most recent N" — and appeared to fall as older
  // bookings dropped out of the window.
  const totalRows = await pool.query(`SELECT COUNT(*)::int AS n FROM pledges`);
  // Group bookings (catalogue_v2, migration 056): which party a booking is in.
  const parties = catalogueV2Enabled() && await partiesAvailable(pool);
  const r = await pool.query(
    `SELECT p.id, p.departure_id, p.agency, p.agency_id, p.seats, p.customers, p.customer_email,
            p.customer_phone, p.status, p.price_per_person, p.deposit_percent,
            p.booking_total, p.deposit_due, p.balance_due, p.balance_due_date, p.source,
            p.booking_code, p.rooming_type, p.accommodation_tier_name, p.created_at,${parties ? " p.party_id," : ""}
            d.route, d.date, d.start_date, d.end_date, d.type, d.city, d.time, d.status AS departure_status
       FROM pledges p JOIN departures d ON d.id = p.departure_id
      ORDER BY p.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ total: totalRows.rows[0].n, limit, bookings: r.rows.map((b) => ({
    id: b.id, departureId: b.departure_id, route: b.route, type: b.type, city: b.city, time: b.time,
    date: b.start_date || b.date, endDate: b.end_date, departureStatus: b.departure_status,
    agency: b.agency, agencyId: b.agency_id, seats: Number(b.seats), customers: b.customers,
    customerEmail: b.customer_email, customerPhone: b.customer_phone, status: b.status || "confirmed",
    pricePerPerson: b.price_per_person != null ? Number(b.price_per_person) : null,
    depositPercent: b.deposit_percent != null ? Number(b.deposit_percent) : null,
    roomingType: b.rooming_type, accommodationTierName: b.accommodation_tier_name,
    bookingTotal: b.booking_total != null ? Number(b.booking_total) : null,
    depositDue: b.deposit_due != null ? Number(b.deposit_due) : null,
    balanceDue: b.balance_due != null ? Number(b.balance_due) : null,
    balanceDueDate: b.balance_due_date, source: b.source, bookingCode: b.booking_code,
    ...(b.party_id != null ? { partyId: Number(b.party_id) } : {}),
    createdAt: b.created_at instanceof Date ? b.created_at.toISOString() : b.created_at,
  })) });
}));

// Admin: change a booking's status (pending/confirmed/paid/cancelled). One
// booking, in its own transaction, recomputing the departure's status so that
// cancelling (or reinstating) a booking frees or reclaims its seats. Shared by
// the single and the bulk routes.
const BOOKING_STATUS_VALUES = ["pending", "confirmed", "paid", "cancelled"];
async function changeBookingStatus(id, status, cancelledReason) {
  if (!BOOKING_STATUS_VALUES.includes(status)) throw new AppError(422, "Invalid status.");
  await withDepartureWrites(async (c, touch) => {
    const found = await c.query(`SELECT departure_id FROM pledges WHERE id=$1`, [id]);
    if (!found.rows.length) throw new AppError(404, "Booking not found.");
    // F03 — the departure is locked first, the same order every booking takes,
    // and the pledge re-read under that lock. Reinstating a cancelled booking
    // takes its seats back; it used to do so unchecked, so a date whose released
    // seats had since been sold went over capacity.
    const dep = await loadDeparture(c, found.rows[0].departure_id, { forUpdate: true });
    if (!dep) throw new AppError(404, "Booking not found.");
    const cur = await c.query(`SELECT status, seats FROM pledges WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rows.length) throw new AppError(404, "Booking not found.");
    const reinstating = cur.rows[0].status === "cancelled" && status !== "cancelled";
    if (reinstating) {
      if (["cancelled", "closed"].includes(dep.status)) {
        throw new AppError(409, "This date is no longer running, so the booking can't be reinstated on it.");
      }
      const taken = seatsTotal(dep.pledges);   // excludes this (cancelled) booking
      const wanted = Number(cur.rows[0].seats) || 0;
      if (taken + wanted > dep.maxSeats) {
        const left = Math.max(0, dep.maxSeats - taken);
        throw new AppError(409, `Only ${left} seat${left === 1 ? "" : "s"} left on this date; reinstating needs ${wanted}.`);
      }
    }
    await c.query(`UPDATE pledges SET status=$1 WHERE id=$2`, [status, id]);
    // Model phase 3: when and why a booking ended decides the agency's
    // commission (50% when the traveler canceled late and Sawa keeps a fee).
    if (catalogueV2Enabled()) {
      if (status === "cancelled" && cur.rows[0].status !== "cancelled") {
        const reason = cancelledReason === "traveler" ? "traveler" : "admin";
        await c.query(`UPDATE pledges SET cancelled_at = now(), cancelled_reason = $2 WHERE id = $1`, [id, reason]);
      } else if (reinstating) {
        await c.query(`UPDATE pledges SET cancelled_at = NULL, cancelled_reason = NULL WHERE id = $1`, [id]);
      }
    }
    await refreshStatus(c, dep.id);
    // TT1 — both seatsTaken and the departure's own status can move here.
    touch(dep.id);
  });
}

// Admin: delete a booking outright — for test and dummy bookings. Refused for
// a booking with any recorded payment (cancel it instead, so the money trail
// stays); super admin only. The departure's seats are freed.
async function deleteBooking(id) {
  let gone = null;
  await withDepartureWrites(async (c, touch) => {
    const found = await c.query(`SELECT departure_id FROM pledges WHERE id=$1`, [id]);
    if (!found.rows.length) throw new AppError(404, "Booking not found.");
    const dep = await loadDeparture(c, found.rows[0].departure_id, { forUpdate: true });
    const p = (await c.query(`SELECT id, booking_code, departure_id, seats, status FROM pledges WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!p) throw new AppError(404, "Booking not found.");
    const has = async (table) => (await c.query("SELECT to_regclass($1) AS t", [`public.${table}`])).rows[0].t != null;
    const paid = (await has("booking_payments")
      && (await c.query(`SELECT 1 FROM booking_payments WHERE pledge_id=$1 AND state='paid' LIMIT 1`, [id])).rowCount > 0)
      || (await has("payment_requests")
      && (await c.query(`SELECT 1 FROM payment_requests WHERE pledge_id=$1 AND state='paid' LIMIT 1`, [id])).rowCount > 0);
    if (paid) throw new AppError(409, "This booking has a recorded payment, so it can't be deleted. Cancel it instead.");
    if (await has("catalogue_notices")) await c.query(`DELETE FROM catalogue_notices WHERE pledge_id=$1`, [id]);
    await c.query(`DELETE FROM pledges WHERE id=$1`, [id]);
    if (dep) { await refreshStatus(c, dep.id); touch(dep.id); }
    gone = { bookingCode: p.booking_code, departureId: p.departure_id, seats: Number(p.seats), status: p.status };
  });
  return gone;
}

app.patch("/api/admin/bookings/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const status = req.body?.status;
  await changeBookingStatus(req.params.id, status, req.body?.cancelledReason);
  await logAudit(req, { action: "booking.status", entity: "pledge", entityId: req.params.id, detail: { status } });
  res.json({ ok: true, status });
}));

// Admin: the same for many bookings at once. Each booking is its own
// transaction, so one refusal (a full date, a paid booking) doesn't undo the
// rest; the answer says which went through and why the others didn't.
const bulkBookingsSchema = z.object({
  action: z.enum(["pending", "confirmed", "paid", "cancelled", "delete"]),
  ids: z.array(z.string().trim().min(1).max(100)).min(1, "Select at least one booking.").max(500, "Select at most 500 bookings at once."),
  cancelledReason: z.enum(["traveler", "admin"]).optional(),
});
app.post("/api/admin/bookings/bulk", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const input = parse(bulkBookingsSchema, req.body);
  if (input.action === "delete" && req.user?.role !== "super_admin") throw new AppError(403, "Only a super admin can delete bookings.");
  const done = [], failed = [];
  for (const id of [...new Set(input.ids)]) {
    try {
      if (input.action === "delete") {
        const gone = await deleteBooking(id);
        await logAudit(req, { action: "booking.delete", entity: "pledge", entityId: id, detail: { ...gone, bulk: true } });
      } else {
        await changeBookingStatus(id, input.action, input.cancelledReason);
        await logAudit(req, { action: "booking.status", entity: "pledge", entityId: id, detail: { status: input.action, bulk: true } });
      }
      done.push(id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      failed.push({ id, error: e.message });
    }
  }
  res.json({ action: input.action, done, failed });
}));

// Group bookings (catalogue_v2): staff link bookings on one date into a party,
// or take them out. Seats don't move; the party groups the bookings on the
// operator's manifest under one lead contact.
const partyIdsSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(100)).min(1, "Select at least one booking.").max(60, "Select at most 60 bookings at once."),
});
app.post("/api/admin/parties/link", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const input = parse(partyIdsSchema, req.body);
  const result = await linkParty(pool, { pledgeIds: input.ids, by: req.user?.email || req.user?.id || "staff" });
  await logAudit(req, { action: "party.link", entity: "party", entityId: result.partyId, detail: { departureId: result.departureId, linked: result.linked, created: result.created } });
  res.json(result);
}));
app.post("/api/admin/parties/unlink", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const input = parse(partyIdsSchema, req.body);
  const result = await unlinkParty(pool, { pledgeIds: input.ids, by: req.user?.email || req.user?.id || "staff" });
  await logAudit(req, { action: "party.unlink", entity: "party", entityId: result.parties.join(","), detail: { unlinked: result.unlinked, removedParties: result.removedParties } });
  res.json(result);
}));
