// Date requests, referral codes and the agency widget: asking for a date that is not on sale, and who sent the traveller
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { cleanRefCode } from "../../shared/ref-code.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { emitDepartureSync } from "../autoura-sync.js";
import { holdForConfirmation, dateRequestHoldAvailable, confirmBookingUrl } from "../booking-confirmation.js";
import { pool, withTransaction, withDepartureWrites } from "../db/index.js";
import { isoDate } from "../db/mappers.js";
import { departureStarted, seatsTotal } from "../domain.js";
import { sendEmailInBackground, confirmBookingEmail, departureRequestApprovedEmail, departureRequestDeclinedEmail } from "../email.js";
import { pendingGoAheads, alertPayload } from "../goahead-alert.js";
import { partnerPageFor, confirmLink, throughPartner } from "../partner.js";
import { routeContext } from "../route-context.js";

const {
  app, writeLimiter, bookingAttemptLimiter, h, requireTurnstile, parse, publicDepartureRequestSchema,
  verifiedPhoneFor, createDateRequest, forPartner, announceDateRequest, presentDeparture,
  agencyDepartureRequestSchema, AppError, notifyOps, loadDeparture,
} = routeContext();

// ---- Traveler-initiated departure requests (addendum Phase A) --------------
// A traveler picks tour + date + contact; the departure lands as
// `pending_review` with the traveler's seed pledge attached. Admin approves it
// into `open` (or declines -> cancelled). No payment is taken in Phase A.

app.post("/api/public/departure-requests", writeLimiter, bookingAttemptLimiter, h(async (req, res) => {
  await requireTurnstile(req);
  const input = parse(publicDepartureRequestSchema, req.body);
  input.pageUrl = (await partnerPageFor(pool, input.refCode, input.pageUrl)) || undefined;
  input.customerPhone = verifiedPhoneFor(input);
  delete input.turnstileToken;
  delete input.phoneToken;
  const hold = await holdForConfirmation(pool) && await dateRequestHoldAvailable(pool);
  const result = await createDateRequest(input, req, {}, { hold });

  if (result.exactDay) {
    // The same tour already runs that day: book on it, never beside it.
    return res.status(409).json({
      error: "This tour already has a group on that day. Join it instead.",
      code: "near_matches", exactDay: true,
      nearMatches: result.exactDay,
    });
  }
  if (result.nearMatches) {
    // Not an error for the traveler — the UI offers these to join instead.
    return res.status(409).json({
      error: "Open departures already exist near this date.",
      code: "near_matches",
      nearMatches: result.nearMatches,
    });
  }
  if (result.held) {
    // Held until the traveler confirms their email (060): not a request yet.
    const code = result.held.row.booking_code;
    sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: result.product.title,
      dateLabel: input.date, seats: input.seats, bookingCode: code,
      url: confirmLink(confirmBookingUrl(result.held.token), result.held.token, input.pageUrl), dateRequest: true,
    }), { pageUrl: input.pageUrl, bookingCode: code }));
    await logAudit(req, { action: "departure_request.hold", entity: "booking", entityId: code,
      detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "public", joins: result.held.row.departure_id ?? null } });
    return res.status(202).json({ confirmationRequired: true, booking: { bookingCode: code, seats: input.seats, customers: input.customerName, status: "unconfirmed" } });
  }
  await announceDateRequest(req, input, result);
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// An operator requests a new date from their dashboard. Until 24 Sep 2026 an
// operator could only join dates Sawa had already published; a tour with none
// was greyed out. The old POST /api/departures, which opened a date directly
// with placeholder values and no review, is gone — this is the only way in.
app.post("/api/agency/departure-requests", requireAuth, requireRole("agency_owner", "agency_agent"), writeLimiter, h(async (req, res) => {
  const body = parse(agencyDepartureRequestSchema, req.body);
  if (!req.user.agencyId) throw new AppError(403, "Your account is not linked to an agency.");
  const agency = (await pool.query(`SELECT id, name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
  if (!agency) throw new AppError(403, "Your account is not linked to an agency.");
  const input = { ...body, customerName: (body.customers || "Customer details pending").trim() };
  const result = await createDateRequest(input, req, { agencyId: agency.id, agencyName: agency.name, userId: req.user.id });

  if (result.exactDay) {
    return res.status(409).json({
      error: "This tour already has a date on that day. Join it instead.",
      code: "near_matches", exactDay: true,
      nearMatches: result.exactDay,
    });
  }
  if (result.nearMatches) {
    return res.status(409).json({
      error: "Open departures already exist near this date.",
      code: "near_matches",
      nearMatches: result.nearMatches,
    });
  }
  await logAudit(req, {
    action: result.joinedRequest ? "departure_request.join" : "departure_request.create", entity: "departure", entityId: String(result.departure.id),
    detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "agency", agencyId: agency.id, joinedExisting: !!result.joinedRequest },
  });
  // Sawa's own customers are emailed by Sawa; an operator's customer is the
  // operator's to tell. Ops is told either way.
  notifyOps(result.departure, result.booking, input, { isRequest: true, bookedBy: agency.name });
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// The operator's own date requests, whatever their state. Dates in review are
// withheld from the operator's bootstrap (it shows only what the public may
// see), so without this a request vanished from their view the moment it was
// made.
app.get("/api/agency/departure-requests", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.seats, p.customers, p.customer_email, p.status AS booking_status, p.created_at,
            d.id AS departure_id, d.route, d.date, d.start_date, d.end_date, d.status AS departure_status
       FROM pledges p JOIN departures d ON d.id = p.departure_id
      WHERE p.agency_id = $1 AND p.source = 'agency_request'
      ORDER BY p.created_at DESC LIMIT 100`,
    [req.user.agencyId]
  );
  res.json({ requests: r.rows.map((x) => ({
    id: x.id, seats: Number(x.seats), customers: x.customers, customerEmail: x.customer_email,
    bookingStatus: x.booking_status, departureId: x.departure_id, route: x.route,
    date: isoDate(x.start_date) || isoDate(x.date), endDate: isoDate(x.end_date),
    departureStatus: x.departure_status,
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : x.created_at,
  })) });
}));

// Admin approves a traveler-requested departure into the open pool.
app.post("/api/admin/departure-requests/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    // On 24 Sep 2026 two requests for dates already gone (8 and 20 Sep) were
    // approved from the list, and both travellers — who had cancelled — were
    // emailed "Your date is live". A date that has started cannot be opened.
    if (departureStarted(dep)) {
      throw new AppError(409, "This date has already passed, so it can't be opened. Decline it to clear the request.");
    }
    // F02 — requests created before the size check existed can still hold more
    // than the date seats. Opening one would publish an overbooked date.
    if (seatsTotal(dep.pledges) > dep.maxSeats) {
      throw new AppError(409, `This request holds ${seatsTotal(dep.pledges)} travelers on a date that seats ${dep.maxSeats}. Decline it, or raise the tour's capacity first.`);
    }
    await c.query(`UPDATE departures SET status='open' WHERE id=$1`, [dep.id]);
    // Only `pending` rows: requests made before bookings carried that status are
    // already `confirmed` and stay exactly as the traveller was told.
    await c.query(`UPDATE pledges SET status='confirmed' WHERE departure_id=$1 AND status='pending'`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.approve", entity: "departure", entityId: String(departure.id) });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  // A traveller who withdrew their request is not told their date is live.
  if (seed?.customerEmail && seed.status !== "cancelled") {
    sendEmailInBackground(throughPartner(pool, { pledgeId: seed.id }, departureRequestApprovedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      bookingCode: seed.bookingCode,
    })));
  }
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// DIR-20.3 — the payment-link queue.
//
// The email is the prompt; THIS is the record. An unread email is
// indistinguishable from no departure needing a link, and here that costs
// revenue directly — so the portal must be able to ask the question directly
// rather than trusting an inbox.
//
// Derived from audit_log, which 024 made append-only: a departure cannot be
// removed from this queue by anything except an alert actually being recorded
// against it.
app.get("/api/admin/goahead-queue", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const due = await pendingGoAheads();
  const items = [];
  for (const departure of due) {
    const pledges = (await pool.query(`SELECT * FROM pledges WHERE departure_id = $1`, [departure.id])).rows;
    const agency = (await pool.query(
      `SELECT a.* FROM agencies a JOIN tour_products p ON p.agency_id = a.id WHERE p.id = $1`,
      [departure.tour_product_id])).rows[0] || null;
    items.push({ ...alertPayload({ departure, pledges, agency, portalBase: process.env.APP_URL || "" }),
      confirmedAt: departure.confirmed_at });
  }
  res.json({ waiting: items.length, items });
}));

// Admin declines a traveler-requested departure (with an optional reason).
app.post("/api/admin/departure-requests/:id/decline", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  const departure = await withDepartureWrites(async (c, touch) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    await c.query(`UPDATE departures SET status='cancelled' WHERE id=$1`, [dep.id]);
    await c.query(`UPDATE pledges SET status='cancelled' WHERE departure_id=$1 AND status='pending'`, [dep.id]);
    // TT1 — a declined request moves from pending_review, which is withheld, to
    // cancelled, which is mirrored. Without this the partner never learns the
    // date is off, and nothing else ever corrects it.
    touch(dep.id);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.decline", entity: "departure", entityId: String(departure.id), detail: { reason: reason || null } });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  if (seed?.customerEmail) {
    sendEmailInBackground(throughPartner(pool, { pledgeId: seed.id }, departureRequestDeclinedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      reason: reason || undefined,
    })));
  }
  res.json({ departure: presentDeparture(departure, req.user) });
}));

app.post("/api/track/referral", h(async (req, res) => {
  const code = cleanRefCode((req.body || {}).code);
  if (!code) return res.status(204).end();
  await pool.query(
    `INSERT INTO referrals (code, visits) VALUES ($1, 1)
     ON CONFLICT (code) DO UPDATE SET visits = referrals.visits + 1`,
    [code]
  );
  res.status(204).end();
}));

// Public: the display name behind a partner code, for the in-widget booking
// view's "Booked through …" line. Only a named, active partner answers — the
// booking route creates bare rows for any code it is sent, and those have no
// name to show. Nothing else about the partner is returned.
app.get("/api/public/referrals/:code", h(async (req, res) => {
  const code = cleanRefCode(req.params.code);
  if (!code) throw new AppError(404, "Unknown partner.");
  const row = (await pool.query(
    `SELECT COALESCE(a.name, r.name) AS name
       FROM referrals r LEFT JOIN agencies a ON a.id = r.agency_id
      WHERE r.code = $1 AND r.active`, [code])).rows[0];
  if (!row?.name) throw new AppError(404, "Unknown partner.");
  res.set("Cache-Control", "public, max-age=300");
  res.json({ code, name: row.name });
}));

// Admin: per-partner performance (visits, bookings, revenue, commission).
app.get("/api/admin/referrals", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const r = await pool.query(
    `SELECT r.code, r.name, r.commission_percent, r.visits, r.active, r.created_at,
            COUNT(p.id) FILTER (WHERE p.status <> 'cancelled') AS bookings,
            COALESCE(SUM(p.seats) FILTER (WHERE p.status <> 'cancelled'), 0) AS travellers,
            COALESCE(SUM(p.booking_total) FILTER (WHERE p.status <> 'cancelled'), 0) AS revenue
       FROM referrals r
       LEFT JOIN pledges p ON p.ref_code = r.code
      GROUP BY r.code
      ORDER BY revenue DESC, r.visits DESC, r.code`
  );
  res.json({ referrals: r.rows.map((x) => {
    const revenue = Number(x.revenue) || 0;
    const visits = Number(x.visits) || 0;
    const bookings = Number(x.bookings) || 0;
    const commissionPercent = Number(x.commission_percent) || 0;
    return {
      code: x.code, name: x.name || "", commissionPercent, visits, bookings,
      travellers: Number(x.travellers) || 0, revenue, active: x.active !== false,
      conversion: visits ? Math.round((bookings / visits) * 1000) / 10 : 0,
      commission: Math.round(revenue * commissionPercent) / 100,
    };
  }) });
}));

// Agency: fetch (or auto-create) this agency's own referral code + its stats,
// so it can self-serve the tracked widget without the admin.
app.get("/api/agency/widget", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const agencyId = req.user.agencyId;
  if (!agencyId) throw new AppError(403, "This account is not linked to an agency.");
  let row = (await pool.query("SELECT * FROM referrals WHERE agency_id = $1 LIMIT 1", [agencyId])).rows[0];
  if (!row) {
    const ag = (await pool.query("SELECT name FROM agencies WHERE id = $1", [agencyId])).rows[0];
    const base = cleanRefCode(ag?.name) || `agency-${cleanRefCode(agencyId)}`;
    let code = base, n = 1;
    while ((await pool.query("SELECT 1 FROM referrals WHERE code = $1", [code])).rowCount) code = `${base}-${++n}`;
    await pool.query("INSERT INTO referrals (code, name, agency_id) VALUES ($1, $2, $3)", [code, ag?.name || "Agency", agencyId]);
    row = (await pool.query("SELECT * FROM referrals WHERE code = $1", [code])).rows[0];
  }
  const agg = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled') AS bookings,
            COALESCE(SUM(booking_total) FILTER (WHERE status <> 'cancelled'), 0) AS revenue
       FROM pledges WHERE ref_code = $1`, [row.code])).rows[0];
  // 070: shown on the Promote page, beside the snippet that uses it.
  const website = (await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0]?.website || null;
  res.json({
    website,
    code: row.code, name: row.name || "", visits: row.visits || 0,
    bookings: Number(agg.bookings) || 0, revenue: Number(agg.revenue) || 0,
    commissionPercent: Number(row.commission_percent) || 0,
  });
}));

// Admin: create or update a partner code.
app.post("/api/admin/referrals", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const code = cleanRefCode(body.code || body.name);
  if (!code) throw new AppError(422, "A code (or name) is required.");
  const commission = Math.min(100, Math.max(0, Number(body.commissionPercent) || 0));
  await pool.query(
    `INSERT INTO referrals (code, name, commission_percent, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), referrals.name),
       commission_percent = EXCLUDED.commission_percent,
       active = EXCLUDED.active`,
    [code, String(body.name || "").trim(), commission, body.active === false ? false : true]
  );
  await logAudit(req, { action: "referral.upsert", entity: "referral", entityId: code });
  res.status(201).json({ code });
}));
