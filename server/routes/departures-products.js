// Departures and tour products: publishing a date, saving and reviewing a tour, pricing and confirming a departure
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { normalizeDuration, durationShapeError, cutoffUnitError } from "../../shared/booking-policy.js";
import { operatingDayError } from "../../shared/operating-days.js";
import { requestWindowError } from "../../shared/request-window.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { emitDepartureSync } from "../autoura-sync.js";
import { loadCatalogueTourInfo } from "../catalogue-tour-pricing.js";
import { withTransaction, pool, withDepartureWrites } from "../db/index.js";
import { mapAgency, mapProduct } from "../db/mappers.js";
import { capacityError, defaultDepositFor, computePledgePricing, MAX_GROUP_SIZE, validatePriceTiers, operatorSelectable, goAheadSeatsFor, seatsTotal } from "../domain.js";
import { sendEmailInBackground, bookingConfirmationEmail, opsNewListingEmail, opsRecipient, listingApprovedEmail, listingRejectedEmail, goAheadEmail } from "../email.js";
import { operatorFor } from "../operator-lookup.js";
import { throughPartner } from "../partner.js";
import { cleanItinerary, cleanHtml } from "../sanitize.js";
import { routeContext } from "../route-context.js";

const {
  app, h, AppError, loadProduct, loadDeparture, uniqueBookingCode, insertPledge, newPledgeId, presentDeparture,
  portalLink,
} = routeContext();

// Admin publishes a departure from a product (platform staff only).
app.post("/api/admin/departures", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  // A departure is instantiated by its first committed traveller — that is the
  // core of the model, and it applies to ops too. Admin date creation exists
  // for bookings that arrive by phone or WhatsApp, so it records that booking;
  // it must not mint empty inventory that sits on the itinerary pages as
  // fiction. (Decided 2026-08-08; the traveler-initiated addendum says the
  // same for the public flow.)
  const t = body.firstTraveler || {};
  const travelerName = String(t.name || "").trim();
  const travelerEmail = String(t.email || "").trim();
  const travelerPhone = String(t.phone || "").trim();
  const travelerSeats = Number(t.seats || 1);
  if (!travelerName) {
    throw new AppError(422, "A date is created by its first booking — record the traveler's name.");
  }
  if (!travelerEmail && !travelerPhone) {
    throw new AppError(422, "Record how to reach the first traveler — an email or a phone number.");
  }
  if (!Number.isInteger(travelerSeats) || travelerSeats < 1) {
    throw new AppError(422, "Seats must be a whole number of at least 1.");
  }
  const result = await withTransaction(async (c) => {
    const product = await loadProduct(c, body.tourProductId);
    if (!product) throw new AppError(404, "Tour product not found.");

    // Same tour, same day (27 Sep 2026): a booking that arrives by phone joins
    // the date that already exists; a second listing of one day is refused.
    const sameDay = (await c.query(
      `SELECT id, status FROM departures
        WHERE tour_product_id = $1 AND COALESCE(start_date, date) = $2::date
          AND status IN ('pending_review', 'open', 'minimum_reached', 'supplier_confirmed')
        ORDER BY id LIMIT 1`, [product.id, body.startDate || body.date])).rows[0];
    if (sameDay) {
      throw Object.assign(new AppError(409, `This tour already has a date on that day (departure ${sameDay.id}, ${sameDay.status.replace(/_/g, " ")}). Add the booking to it instead.`), { existingDepartureId: Number(sameDay.id) });
    }

    // Operating days. The traveller-request route has refused an ineligible day
    // since it was written; THIS path never checked, so a Tuesday sailing could
    // be published on a Mon/Sat cruise — and the site would advertise a date it
    // refuses to let a traveller request. Two paths, one rule, and only one of
    // them enforced it.
    //
    // It has not bitten: no restricted product has a departure today. That is
    // precisely when it is cheapest to close — all three Nile cruises run on
    // fixed weekdays, so the first cruise date published is the first chance to
    // get it wrong.
    const dayProblem = operatingDayError(product, body.date || body.startDate);
    if (dayProblem) throw new AppError(422, dayProblem);

    // This endpoint lets a departure override the listing's capacity, so the
    // contract limit has to be checked here too — not only on the listing.
    const depMinSeats = Number(body.minSeats || product.minSeats);
    const depMaxSeats = Number(body.maxSeats || product.maxSeats);
    const capacityProblem = capacityError(depMinSeats, depMaxSeats);
    if (capacityProblem) throw new AppError(422, capacityProblem);

    if (travelerSeats > depMaxSeats) {
      throw new AppError(422, `This date holds at most ${depMaxSeats} travelers.`);
    }

    const isPkg = product.type === "package";
    const startDate = body.startDate || body.date || "2026-05-25";
    let endDate = body.endDate || null;
    if (isPkg && !endDate && product.nights) {
      const e = new Date(`${startDate}T12:00:00`);
      e.setDate(e.getDate() + Number(product.nights));
      endDate = e.toISOString().slice(0, 10);
    }
    const id = (await c.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;

    await c.query(
      `INSERT INTO departures
        (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
         city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
         quality, status, notes, deposit_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,'open',$20,$21)`,
      [
        id, product.type, product.id, product.title, startDate,
        isPkg ? startDate : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, body.time || product.defaultTime,
        product.city, product.guide, product.vehicle,
        depMinSeats, depMaxSeats,
        Number(body.baseCost || product.baseCost || 0), Number(body.publishedRate || product.publishedRate),
        Number(body.breakPrice || product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality, product.description,
        Number(product.depositPercent || defaultDepositFor(product)),
      ]
    );

    // The first booking, in the same transaction: the date and its traveller
    // exist together or not at all.
    const fresh = await loadDeparture(c, id);
    const pricing = computePledgePricing(fresh, product, {
      seats: travelerSeats, roomingType: t.roomingType, accommodationTier: t.accommodationTier,
    });
    const bookingCode = await uniqueBookingCode(c);
    await insertPledge(c, id, {
      id: newPledgeId(id),
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: travelerSeats,
      customers: travelerName,
      customerEmail: travelerEmail || null,
      customerPhone: travelerPhone || null,
      source: "admin",
      bookingCode,
      createdByUserId: req.user.id,
      ...pricing,
    });
    return { departure: await loadDeparture(c, id), bookingCode, pricing };
  });
  const departure = result.departure;
  emitDepartureSync(departure.id);
  await logAudit(req, {
    action: "departure.create_with_booking", entity: "departure", entityId: String(departure.id),
    detail: { tourProductId: body.tourProductId, date: departure.startDate || departure.date, seats: travelerSeats, source: "admin" },
  });
  if (travelerEmail) {
    sendEmailInBackground(operatorFor(departure.id).then((operator) => bookingConfirmationEmail({
      to: travelerEmail, customerName: travelerName, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      seats: travelerSeats, depositDue: result.pricing.depositDue, balanceDue: result.pricing.balanceDue,
      balanceDueDate: result.pricing.balanceDueDate, bookingCode: result.bookingCode,
      product: departure, operator,
    })));
  }
  res.status(201).json({ departure: presentDeparture(departure, req.user), bookingCode: result.bookingCode });
}));

// Shared upsert used by both the admin editor and the agency listing editor.
// `review` carries the approval state to write: { status, agencyId, submittedBy, reviewedBy }.
// Exported for upsert-execution.test.js, which EXECUTES it against a stub
// client — the only kind of test that catches an out-of-scope identifier.
// Two consecutive production breaks in this one function shipped under a
// green suite (#163's arity, then the #162 scope error): reading the SQL as
// text catches the first class, only execution catches the second.
export async function upsertTourProduct(c, body, review) {
  const title = String(body.title || "").trim();
  if (!title) throw new AppError(422, "Title is required.");
  const type = body.type === "package" ? "package" : "day_tour";
  const id = body.id ||
    `${type === "package" ? "pkg" : "tour"}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}_${Date.now().toString(36)}`;
  const publishedRate = Number(body.publishedRate || 0);
  const now = new Date().toISOString();
  const reviewedAt = review.status === "approved" ? now : null;
  // Operating weekdays (0=Sun … 6=Sat): dedupe, bound, and treat "all 7" as
  // unrestricted (null) so the traveler picker stays a free calendar.
  const opDays = Array.isArray(body.operatingDays)
    ? [...new Set(body.operatingDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : null;
  const operatingDays = opDays && opDays.length > 0 && opDays.length < 7 ? JSON.stringify(opDays) : null;

  // The contract limit, checked before anything is written. The DB carries the
  // same rule as a constraint; this exists to say why in words an operator can
  // act on rather than surfacing a constraint violation.
  const capacityProblem = capacityError(
    Number(body.minSeats || 4),
    Number(body.maxSeats || MAX_GROUP_SIZE)
  );
  if (capacityProblem) throw new AppError(422, capacityProblem);

  // The type and the duration must describe the same trip. Minya shipped as a
  // `package` reading "1 day · 15 hours" and nothing objected — so it carried a
  // package's deposit, balance date, cancellation schedule and 30-day
  // confirmation deadline for months, and the only visible symptom was an odd
  // duration string. Same shape as the capacity check above: refused in words an
  // operator can act on, before anything is written.
  //
  // This block (and the window check below) lived here from #151 until #162
  // moved it into the admin-departures route by accident — where `type` does
  // not exist, and where `blankNum` was declared while the INSERT below kept
  // using it. Every listing save threw ReferenceError from then on, and the
  // green suite never noticed because nothing executes this function.
  // upsert-execution.test.js now does.
  // Read what was typed generously ("8 hours" → "Full day · about 8 hours")
  // and store it in the house format; only what can't be read is refused.
  if (typeof body.duration === "string") body.duration = normalizeDuration(type, body.duration);
  const durationProblem = durationShapeError(type, body.duration);
  if (durationProblem) throw new AppError(422, durationProblem);

  // The request window, if this listing sets one. Mirrors the CHECK in 037 so
  // the operator is told what is wrong in words rather than meeting a
  // constraint violation.
  const windowProblem = requestWindowError(body.requestMinLeadDays, body.requestMaxHorizonDays);
  if (windowProblem) throw new AppError(422, windowProblem);
  const blankNum = (v) => (v === "" || v == null ? null : Number(v));

  // The cutoff's unit (038). The hours stay canonical; the unit is how the
  // operator said it, and "days" over a number that is not whole days is
  // refused here in words rather than by the CHECK constraint.
  const cutoffHours = Number.isFinite(Number(body.bookingCutoffHours)) ? Number(body.bookingCutoffHours) : 24;
  const cutoffUnit = body.bookingCutoffUnit === "days" ? "days"
    : body.bookingCutoffUnit === "hours" ? "hours" : null;
  const cutoffProblem = cutoffUnitError(cutoffHours, cutoffUnit);
  if (cutoffProblem) throw new AppError(422, cutoffProblem);

  // Optional per-headcount pricing. Rejected loudly rather than silently
  // dropped: a table the operator believes is saved but isn't would quietly
  // sell every seat at the interpolated price instead.
  const tierCheck = validatePriceTiers(body.priceTiers, {
    minSeats: Number(body.minSeats || 4),
    maxSeats: Number(body.maxSeats || MAX_GROUP_SIZE),
  });
  if (tierCheck.error) throw new AppError(422, tierCheck.error);
  const priceTiers = tierCheck.tiers ? JSON.stringify(tierCheck.tiers) : null;
  await c.query(
    `INSERT INTO tour_products
      (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
       min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
       description, included, not_included, itinerary, accommodation_tiers,
       overview_html, policies_html, what_to_bring, meeting_point, pickup_note, booking_cutoff_hours, images,
       meeting_points, status, agency_id, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason, operating_days, price_tiers,
       request_min_lead_days, request_max_horizon_days, booking_cutoff_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
     ON CONFLICT (id) DO UPDATE SET
       operating_days=EXCLUDED.operating_days, price_tiers=EXCLUDED.price_tiers,
       request_min_lead_days=EXCLUDED.request_min_lead_days,
       request_max_horizon_days=EXCLUDED.request_max_horizon_days,
       booking_cutoff_unit=EXCLUDED.booking_cutoff_unit,
       type=EXCLUDED.type, title=EXCLUDED.title, city=EXCLUDED.city, cities=EXCLUDED.cities,
       nights=EXCLUDED.nights, duration=EXCLUDED.duration,
       guide=EXCLUDED.guide, vehicle=EXCLUDED.vehicle, min_seats=EXCLUDED.min_seats,
       max_seats=EXCLUDED.max_seats, published_rate=EXCLUDED.published_rate,
       break_price=EXCLUDED.break_price, deposit_percent=EXCLUDED.deposit_percent,
       description=EXCLUDED.description, included=EXCLUDED.included, not_included=EXCLUDED.not_included,
       itinerary=EXCLUDED.itinerary, accommodation_tiers=EXCLUDED.accommodation_tiers,
       overview_html=EXCLUDED.overview_html, policies_html=EXCLUDED.policies_html,
       what_to_bring=EXCLUDED.what_to_bring, meeting_point=EXCLUDED.meeting_point,
       pickup_note=EXCLUDED.pickup_note, booking_cutoff_hours=EXCLUDED.booking_cutoff_hours,
       images=EXCLUDED.images, meeting_points=EXCLUDED.meeting_points,
       status=EXCLUDED.status,
       -- Staff editing a listing (saved straight to approved) keep who submitted
       -- it and when: overwriting them made an agency's listing read as staff's,
       -- and a tour staff added read as the operating company's request.
       submitted_at=CASE WHEN EXCLUDED.status = 'approved' AND tour_products.submitted_by IS NOT NULL THEN tour_products.submitted_at ELSE EXCLUDED.submitted_at END,
       submitted_by=CASE WHEN EXCLUDED.status = 'approved' AND tour_products.submitted_by IS NOT NULL THEN tour_products.submitted_by ELSE EXCLUDED.submitted_by END,
       reviewed_by=EXCLUDED.reviewed_by,
       reviewed_at=EXCLUDED.reviewed_at, rejection_reason=EXCLUDED.rejection_reason,
       -- The operator. Argument order matters and used to be the other way
       -- round: existing-wins meant a product could never be REASSIGNED, and an
       -- admin had no way to attach one at all — only an agency self-submitting
       -- ever set it, from its own session.
       -- New-value-wins with a NULL fallback gives both: an edit that supplies
       -- an operator sets it, and an edit that says nothing leaves it alone.
       -- The no-wipe property the old order existed for is preserved, because
       -- EXCLUDED.agency_id is NULL on every path that does not mean to change it.
       -- Clearing is the one exception, and it is explicit ($43): an admin who
       -- picks "Not assigned" used to see the old company come straight back.
       agency_id=CASE WHEN $43::boolean THEN NULL ELSE COALESCE(EXCLUDED.agency_id, tour_products.agency_id) END`,
    [
      id, type, title, body.city || "Cairo",
      type === "package" ? JSON.stringify(body.cities || [body.city || "Cairo"]) : null,
      type === "package" ? Number(body.nights || 3) : null,
      body.duration || (type === "package" ? `${Number(body.nights || 3) + 1} days · ${body.nights || 3} nights` : "Full day · about 4 hours"),
      body.defaultTime || "08:00", body.guide || "Licensed Egyptologist",
      body.vehicle || (type === "package" ? "Private van + flights" : "Van, 12 seats"),
      Number(body.minSeats || 4), Number(body.maxSeats || MAX_GROUP_SIZE),
      Number(body.baseCost || 0), publishedRate,
      Number(body.breakPrice || Math.round(publishedRate * 0.8)), Number(body.quality || 4.7),
      Number(body.depositPercent || (type === "package" ? 20 : 10)), body.description || "",
      JSON.stringify(body.included || []), JSON.stringify(body.notIncluded || []),
      type === "package" ? JSON.stringify(cleanItinerary(body.itinerary || [])) : null,
      type === "package" ? JSON.stringify(body.accommodationTiers || []) : null,
      cleanHtml(body.overviewHtml) || null, cleanHtml(body.policiesHtml) || null,
      JSON.stringify(body.whatToBring || []), body.meetingPoint || null,
      body.pickupNote || null, cutoffHours,
      JSON.stringify(body.images || []),
      JSON.stringify(Array.isArray(body.meetingPoints) ? body.meetingPoints : []),
      review.status, review.agencyId || null, review.submittedBy || null, now,
      review.reviewedBy || null, reviewedAt, null, operatingDays, priceTiers,
      blankNum(body.requestMinLeadDays), blankNum(body.requestMaxHorizonDays), cutoffUnit,
      review.clearAgency === true,
    ]
  );
  return loadProduct(c, id);
}

// The "Edit day tour" page: whether this tour is a catalogue product (flag on)
// and, if so, its catalogue values and the published rate card's tiers.
app.get("/api/admin/tour-products/:id/catalogue", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  res.json(await loadCatalogueTourInfo(req.params.id));
}));

// Admin creates / updates a tour product (platform staff only). Admin edits are
// auto-approved — a platform admin publishing a tour needs no second sign-off.
app.post("/api/admin/tour-products", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  // Only an active, listed operator may be attached. Keeping the company a
  // listing already has is allowed, so an unrelated edit never fails on it.
  if (body.agencyId) {
    const cur = body.id ? (await pool.query(`SELECT agency_id FROM tour_products WHERE id=$1`, [body.id])).rows[0] : null;
    if (cur?.agency_id !== body.agencyId) {
      const a = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [body.agencyId])).rows[0];
      const o = (await pool.query(`SELECT status FROM operators WHERE agency_id=$1`, [body.agencyId])).rows[0];
      if (!operatorSelectable(a && mapAgency(a), o)) throw new AppError(422, "That company can't be the operating company: it must be an active, publicly listed operator.");
    }
  }
  const product = await withTransaction((c) =>
    upsertTourProduct(c, body, {
      status: "approved", submittedBy: req.user.id, reviewedBy: req.user.id,
      // Platform staff assigning the operating company. An agency submitting
      // its own listing still gets its own id from the session below — this
      // is the only path where the operator is a CHOICE.
      agencyId: body.agencyId || null,
      // "Not assigned": the editor sends agencyId: null. A caller that leaves
      // the key out changes nothing, as before.
      clearAgency: Object.hasOwn(body, "agencyId") && !body.agencyId,
    }));
  // DIR-1 — the agency route audits `listing.submit`; this one writes a listing
  // straight to `approved` and audited nothing. The path with LESS review had
  // less record.
  await logAudit(req, {
    action: "listing.create", entity: "tour_product", entityId: product.id,
    detail: { title: product.title, status: "approved", platform: true },
  });
  res.status(201).json({ product });
}));

// Agency submits / edits a tour listing. It goes to 'pending' and stays offline
// until a platform admin approves it. Editing an approved listing sends it back
// to pending (re-approval required).
app.post("/api/agency/tour-products", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const body = req.body || {};
  if (!req.user.agencyId) throw new AppError(403, "Your account is not linked to an agency.");
  let agencyName = null;
  const product = await withTransaction(async (c) => {
    if (body.id) {
      // Locked so the owner can't change between this check and the write.
      const owner = await c.query(`SELECT agency_id FROM tour_products WHERE id=$1 FOR UPDATE`, [body.id]);
      if (!owner.rows.length) throw new AppError(404, "Listing not found.");
      // Only a listing this agency owns. A Sawa-owned listing has no agency, and
      // used to pass this check: any agency could overwrite it, take it offline
      // and become its operator (docs/security/agency-listing-takeover.md).
      if (owner.rows[0].agency_id !== req.user.agencyId) {
        throw new AppError(403, "You can only edit your own listings.");
      }
    }
    const saved = await upsertTourProduct(c, body, { status: "pending", agencyId: req.user.agencyId, submittedBy: req.user.id });
    agencyName = (await c.query(`SELECT name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0]?.name || null;
    return saved;
  });
  await logAudit(req, { action: "listing.submit", entity: "tour_product", entityId: product.id, detail: { title: product.title } });
  sendEmailInBackground(opsNewListingEmail({
    to: opsRecipient(), title: product.title, agencyName, isEdit: Boolean(body.id), portalLink: portalLink(),
  }));
  res.status(201).json({ product });
}));

// Agency lists its own submissions (all statuses).
app.get("/api/agency/tour-products", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM tour_products WHERE agency_id=$1 ORDER BY submitted_at DESC NULLS LAST, id`,
    [req.user.agencyId]
  );
  res.json({ products: r.rows.map(mapProduct) });
}));

// Resolve the best notification address for a listing's owning agency.
async function listingOwnerContact(product) {
  if (product.submittedBy) {
    const u = await pool.query(`SELECT email, full_name FROM app_users WHERE id=$1`, [product.submittedBy]);
    if (u.rows[0]?.email) return u.rows[0];
  }
  if (product.agencyId) {
    const o = await pool.query(
      `SELECT email, full_name FROM app_users WHERE agency_id=$1 AND role='agency_owner' AND status='active' LIMIT 1`,
      [product.agencyId]
    );
    if (o.rows[0]?.email) return o.rows[0];
  }
  return null;
}

// Admin approves a pending listing -> goes live, agency notified by email.
app.post("/api/admin/tour-products/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const product = await withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE tour_products SET status='approved', reviewed_by=$1, reviewed_at=now(), rejection_reason=NULL, active=true WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!r.rows.length) throw new AppError(404, "Listing not found.");
    return mapProduct(r.rows[0]);
  });
  await logAudit(req, { action: "listing.approve", entity: "tour_product", entityId: product.id, detail: { title: product.title } });
  const contact = await listingOwnerContact(product);
  if (contact?.email) {
    sendEmailInBackground(listingApprovedEmail({ to: contact.email, fullName: contact.full_name, title: product.title }));
  }
  res.json({ product, notified: !!contact?.email });
}));

// Admin rejects a pending listing with a reason -> stays offline, agency notified.
app.post("/api/admin/tour-products/:id/reject", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw new AppError(422, "A reason for the rejection is required.");
  const product = await withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE tour_products SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    if (!r.rows.length) throw new AppError(404, "Listing not found.");
    return mapProduct(r.rows[0]);
  });
  await logAudit(req, { action: "listing.reject", entity: "tour_product", entityId: product.id, detail: { title: product.title, reason } });
  const contact = await listingOwnerContact(product);
  if (contact?.email) {
    sendEmailInBackground(listingRejectedEmail({ to: contact.email, fullName: contact.full_name, title: product.title, reason }));
  }
  res.json({ product, notified: !!contact?.email });
}));

// Admin updates pricing; cascades to that product's departures (platform staff only).
app.post("/api/admin/tour-products/:id/pricing", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const result = await withDepartureWrites(async (c, touch) => {
    const product = await loadProduct(c, req.params.id);
    if (!product) throw new AppError(404, "Tour product not found.");
    const publishedRate = Number(body.publishedRate || product.publishedRate);
    const breakPrice = Number(body.breakPrice || product.breakPrice);
    if (!(publishedRate > 0) || !(breakPrice > 0)) throw new AppError(422, "Prices must be positive numbers.");
    if (breakPrice > publishedRate) throw new AppError(422, "Break price cannot be higher than the GoAhead price.");

    await c.query(`UPDATE tour_products SET published_rate=$1, break_price=$2 WHERE id=$3`, [publishedRate, breakPrice, product.id]);
    // TT1 — this reprices EVERY departure of the product, and the mirror's
    // payload carries priceFrom. It has never told Autoura about a price change.
    const repriced = await c.query(
      `UPDATE departures SET published_rate=$1, break_price=$2 WHERE tour_product_id=$3 RETURNING id`,
      [publishedRate, breakPrice, product.id]
    );
    for (const row of repriced.rows) touch(row.id);
    const updated = await loadProduct(c, product.id);
    const deps = await c.query(`SELECT id FROM departures WHERE tour_product_id=$1 ORDER BY id`, [product.id]);
    const departures = [];
    for (const row of deps.rows) departures.push(await loadDeparture(c, row.id));
    return {
      product: updated, departures, repriced: repriced.rows.length,
      was: { publishedRate: product.publishedRate, breakPrice: product.breakPrice },
    };
  });
  // DIR-1 — a price change, across every date of the product at once, with no
  // record of who made it or what it was before. The highest-value audit row in
  // this file after the access changes.
  await logAudit(req, {
    action: "product.pricing", entity: "tour_product", entityId: req.params.id,
    detail: {
      from: result.was,
      to: { publishedRate: result.product.publishedRate, breakPrice: result.product.breakPrice },
      departuresRepriced: result.repriced,
    },
  });
  res.json({ product: result.product, departures: result.departures.map((d) => presentDeparture(d, req.user)) });
}));

// Admin confirms go-ahead (platform staff only).
app.post("/api/admin/departures/:id/confirm", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    const required = goAheadSeatsFor(dep);
    if (seatsTotal(dep.pledges) < required) {
      throw new AppError(409, `${required} booked seats are required for go-ahead.`);
    }
    await c.query(`UPDATE departures SET status='supplier_confirmed' WHERE id=$1`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure.confirm", entity: "departure", entityId: departure.id, detail: { route: departure.route } });
  const dateLabel = departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date;
  // MM1 — `status <> 'cancelled'` is the whole point of this line.
  //
  // Without it, a traveller who had cancelled their own booking was still on
  // the list, and was emailed about a date they were no longer on. Same defect
  // class as the booking page telling a cancelled traveller to meet the guide:
  // a message addressed to a named individual, stating something untrue about
  // their booking, which they may act on.
  //
  // The job's own recipient list (jobs/cancel-unconfirmed.js) already filtered
  // correctly. These two — the older code — did not.
  const recips = await pool.query(
    `SELECT DISTINCT customer_email FROM pledges
      WHERE departure_id=$1 AND customer_email IS NOT NULL AND status <> 'cancelled'`,
    [departure.id]
  );
  // Looked up once for all of them, after the response (U01).
  const operator = recips.rows.length ? operatorFor(departure.id) : null;
  for (const row of recips.rows) {
    sendEmailInBackground(throughPartner(pool, { departureId: departure.id, email: row.customer_email },
      operator.then((op) => goAheadEmail({ to: row.customer_email, route: departure.route, dateLabel, operator: op }))));
  }
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));
