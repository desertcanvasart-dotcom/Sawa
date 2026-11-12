// Making a booking: an agency's pledge, phone verification, group requests, the public booking and cancelling one
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { cleanRefCode } from "../../shared/ref-code.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole, isPlatform } from "../auth.js";
import { emitDepartureSync } from "../autoura-sync.js";
import { holdForConfirmation, holdBooking, markConfirmed, confirmBookingUrl } from "../booking-confirmation.js";
import { integrityAvailable, recordSignals, detectCluster } from "../booking-integrity.js";
import { partyToJoin, joinParty } from "../booking-parties.js";
import { reduceSignals } from "../booking-signals.js";
import { fixBookingTerms } from "../cancellation-tiers.js";
import { routeBooking, ensureOpenDeparture } from "../catalogue-departures.js";
import { recordAgencyBooking, releaseUnpaidAgencyBookings } from "../commissions.js";
import { withTransaction, pool } from "../db/index.js";
import { mapPledge } from "../db/mappers.js";
import { refreshStatus } from "../departure-status.js";
import { seatsTotal, bookingClosed, computePledgePricing, goAheadSeatsFor, MAX_GROUP_SIZE, bookingLookupView } from "../domain.js";
import { sendEmailInBackground, opsNewBookingEmail, opsRecipient, opsGroupRequestEmail, confirmBookingEmail, payAtGoAheadBookingEmail, bookingConfirmationEmail } from "../email.js";
import { catalogueV2Enabled } from "../features.js";
import { operatorFor } from "../operator-lookup.js";
import { throughPartner, partnerPageFor, confirmLink, rememberPartnerPage } from "../partner.js";
import { bookingPayView } from "../pay-at-goahead.js";
import { phoneVerificationEnabled, normalizePhone, phoneTokenValid, startVerification, checkVerification, issuePhoneToken } from "../phone-verify.js";
import { stampBookingPrice } from "../pool-settlement.js";
import { routeContext } from "../route-context.js";

const {
  app, h, parse, pledgeSchema, manifestFields, loadDeparture, AppError, heldForWaitlist, loadProduct,
  requireCompleteBooking, newPledgeId, insertPledge, uniqueBookingCode, payNowIfGoingAhead, presentDeparture,
  portalLink, writeLimiter, requireTurnstile, bookingAttemptLimiter, publicBookingSchema,
} = routeContext();

// Agency pledge — identity (agency) comes from the token, never the body.
app.post("/api/departures/:id/pledges", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const input = parse(pledgeSchema, req.body);
  const manifest = manifestFields(req.body);
  let agencyName = null;
  const departure = await withTransaction(async (c) => {
    // Numbered departures (catalogue_v2): the booking goes to the lowest-numbered
    // departure of the date with room for the whole party; a further one is
    // opened if none has room.
    const target = catalogueV2Enabled() ? (await routeBooking(c, { departureId: Number(req.params.id), seats: input.seats })).departureId : Number(req.params.id);
    const dep = await loadDeparture(c, target, { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (dep.mergedIntoId) throw Object.assign(new AppError(409, "This date was joined with another listing of the same tour and day. Book on that one."), { mergedIntoId: dep.mergedIntoId });
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
    if (seatsTotal(dep.pledges) + await heldForWaitlist(c, dep.id) + input.seats > dep.maxSeats) {
      throw new AppError(409, "This pledge exceeds capacity.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const catalogueCtx = await requireCompleteBooking(c, dep.id, manifest, input.seats, input.customerPhone);
    const agency = (await c.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
    const pricing = computePledgePricing(dep, product, input);

    agencyName = agency.name;
    const pledgeId = newPledgeId(dep.id);
    await insertPledge(c, dep.id, {
      id: pledgeId,
      agencyId: agency.id,
      agency: agency.name,
      seats: input.seats,
      customers: (input.customers || "Customer details pending").trim(),
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      createdByUserId: req.user.id,
      // Phase 4: a catalog booking has a code, the payment's reference.
      bookingCode: catalogueCtx ? await uniqueBookingCode(c) : null,
      manifest,
      ...pricing,
    });
    if (catalogueCtx) {
      // Model phase 4: pay at GoAhead. The agency showed its client the
      // cancellation terms before booking (Agency Reseller Agreement 4.2), so
      // the tier version in force now is the one this booking keeps.
      await fixBookingTerms(c, { pledgeId, by: "agency" });
      // Model phase 5: the published EUR rate, and the current tier's price.
      await stampBookingPrice(c, { pledgeId });
      // Model phase 3: the commission (EUR, from the rate version in force) is
      // locked now; an agency on billing is invoiced now.
      await recordAgencyBooking(c, { pledgeId, agency, catalogueDepartureId: catalogueCtx.departureId });
      await payNowIfGoingAhead(c, pledgeId, catalogueCtx.departureId);
      await ensureOpenDeparture(c, dep.id);
    }
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "pledge.create", entity: "departure", entityId: Number(req.params.id), detail: { seats: input.seats, agencyId: req.user.agencyId } });
  notifyOps(departure, {}, { ...input, customerName: input.customers }, { isRequest: false, bookedBy: agencyName || "an operator" });
  emitDepartureSync(departure.id);
  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));


// Tell Sawa about new demand from the public site. Fire-and-forget like the
// traveller's own email: a mail outage must never fail the booking.
export function notifyOps(departure, booking, input, { isRequest, bookedBy }) {
  const d = departure;
  sendEmailInBackground(opsNewBookingEmail({
    to: opsRecipient(), isRequest, route: d.route,
    dateLabel: d.startDate && d.endDate ? `${d.startDate} – ${d.endDate}` : (d.startDate || d.date),
    seats: input.seats, seatsNow: seatsTotal(d.pledges), minSeats: goAheadSeatsFor(d),
    customerName: input.customerName, customerEmail: input.customerEmail, customerPhone: input.customerPhone,
    bookingCode: booking.bookingCode, note: input.note, bookedBy,
    portalLink: portalLink(),
  }));
}

// Public (direct traveller) booking — intentionally open, no auth, but the
// ---- S04 — phone verification for direct travellers -------------------------
// See server/phone-verify.js. Off until Twilio is configured, and then required
// for every direct booking and date request.
const phoneStartSchema = z.object({
  phone: z.string().trim().min(6, "Enter your mobile number.").max(40),
  channel: z.enum(["sms", "whatsapp"]).optional(),
});
const phoneCheckSchema = z.object({
  phone: z.string().trim().min(6).max(40),
  code: z.string().trim().regex(/^\d{4,10}$/, "Enter the code we sent you."),
});
const PHONE_FORMAT_HELP = "Enter your mobile number with its country code, e.g. +44 7700 900123 (Egyptian numbers can start with 01).";

// The traveller's number, normalised, once its token checks out — or, while
// verification is off, whatever they typed, as before.
export function verifiedPhoneFor(input) {
  if (!phoneVerificationEnabled()) return input.customerPhone || null;
  const phone = normalizePhone(input.customerPhone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  if (!phoneTokenValid(input.phoneToken, phone)) {
    throw new AppError(422, "Please confirm your phone number with the code we send you before reserving.");
  }
  return phone;
}

app.post("/api/public/phone-verifications", writeLimiter, h(async (req, res) => {
  if (!phoneVerificationEnabled()) throw new AppError(404, "Phone verification is not in use.");
  const input = parse(phoneStartSchema, req.body);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  const r = await startVerification(phone, input.channel);
  if (!r.ok) {
    // Twilio's own message can name the account or the number's carrier; it is
    // logged for ops and the traveller gets a plain sentence.
    console.warn(`[phone-verify] send failed (${r.status}): ${r.message || "no message"}`);
    throw new AppError(r.status === 400 ? 422 : 502, r.status === 400
      ? "We couldn't send a code to that number. Check it and try again."
      : "We couldn't send a code just now. Please try again in a moment.");
  }
  await logAudit(req, { action: "phone.verify_start", entity: "phone", entityId: phone.slice(0, -4) + "····", detail: { channel: input.channel || "sms" } });
  res.json({ sent: true, phone });
}));

app.post("/api/public/phone-verifications/check", writeLimiter, h(async (req, res) => {
  if (!phoneVerificationEnabled()) throw new AppError(404, "Phone verification is not in use.");
  const input = parse(phoneCheckSchema, req.body);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  if (!(await checkVerification(phone, input.code))) {
    throw new AppError(422, "That code isn't right, or it has expired. Check it, or ask for a new one.");
  }
  await logAudit(req, { action: "phone.verified", entity: "phone", entityId: phone.slice(0, -4) + "····" });
  res.json({ verified: true, phone, phoneToken: issuePhoneToken(phone) });
}));

// stricter write limiter guards this and the public cancel below from abuse.
//
// A direct booking is held until the traveler confirms their email (migration
// 058): every check below runs, then the booking waits in
// booking_confirmations and the traveler gets a "Confirm my booking" link.
// The link calls placePublicBooking again with the held booking, which runs
// the same checks and makes it. Answer 202 while held, 201 once made.
// Parties larger than 8 are not bookable online (29 Sep 2026). The booking form
// stops and offers this instead: a short request that becomes an admin lead.
// No booking is made and no seat is held.
const groupRequestSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(120),
  email: z.string().trim().email("Enter a valid email.").max(200),
  groupSize: z.coerce.number().int().min(MAX_GROUP_SIZE + 1, `A group request is for more than ${MAX_GROUP_SIZE} travelers.`).max(200),
  date: z.string().trim().max(40).optional().nullable(),
  productId: z.string().trim().max(120).optional().nullable(),
  productTitle: z.string().trim().max(200).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
  website: z.string().max(200).optional(), // honeypot: real people leave it empty
});
app.post("/api/public/group-requests", writeLimiter, h(async (req, res) => {
  const input = groupRequestSchema.parse(req.body || {});
  if (input.website) return res.status(202).json({ ok: true }); // a bot: answer as if it worked
  // The same bot check as the booking forms this one sits in: every request
  // here emails the operations inbox.
  await requireTurnstile(req);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : null;
  const product = input.productId
    ? (await pool.query(`SELECT id, title FROM tour_products WHERE id=$1`, [input.productId])).rows[0]
    : null;
  const title = product?.title || input.productTitle || null;
  let stored = true;
  try {
    await pool.query(
      `INSERT INTO group_requests (name, email, group_size, wanted_date, product_id, product_title, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.name, input.email, input.groupSize, wanted, product?.id || null, title, input.note || null]);
  } catch (e) {
    // Migration 062 is applied by hand: before it, the lead still reaches the
    // operations inbox, which is where it is acted on.
    if (e?.code !== "42P01") throw e;
    stored = false;
  }
  await logAudit(req, { action: "group_request.create", entity: "group_request", entityId: null, detail: { groupSize: input.groupSize, product: title, stored } });
  sendEmailInBackground(opsGroupRequestEmail({
    to: opsRecipient(), name: input.name, email: input.email, groupSize: input.groupSize,
    date: wanted || input.date || null, product: title, note: input.note || null, portalLink: portalLink(),
  }));
  res.status(201).json({ ok: true, stored });
}));

app.get("/api/admin/group-requests", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  let rows = [];
  try {
    rows = (await pool.query(`SELECT * FROM group_requests ORDER BY (status = 'new') DESC, created_at DESC LIMIT 200`)).rows;
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }
  res.json({ requests: rows.map((r) => ({
    id: Number(r.id), name: r.name, email: r.email, groupSize: r.group_size,
    wantedDate: r.wanted_date instanceof Date ? r.wanted_date.toISOString().slice(0, 10) : r.wanted_date,
    productId: r.product_id, productTitle: r.product_title, note: r.note, status: r.status,
    createdAt: r.created_at, handledBy: r.handled_by, handledAt: r.handled_at,
  })) });
}));

app.patch("/api/admin/group-requests/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { status } = z.object({ status: z.enum(["new", "contacted", "closed"]) }).parse(req.body || {});
  const row = (await pool.query(
    `UPDATE group_requests SET status=$1, handled_by=$2, handled_at=now() WHERE id=$3 RETURNING id`,
    [status, req.user.id, Number(req.params.id)])).rows[0];
  if (!row) throw new AppError(404, "Request not found.");
  await logAudit(req, { action: "group_request.update", entity: "group_request", entityId: String(row.id), detail: { status } });
  res.json({ ok: true });
}));

app.post("/api/public/departures/:id/bookings", writeLimiter, bookingAttemptLimiter, h(async (req, res) => {
  await requireTurnstile(req);
  const out = await placePublicBooking(req, { departureId: Number(req.params.id), body: req.body });
  await logAudit(req, out.audit);
  if (out.flagAudit) await logAudit(req, out.flagAudit);
  res.status(out.status).json(out.json);
}));

// The partner whose widget a booking came through (server/partner.js): the
// line "Booked through <agency>" on the emails about it.
// `page`: the checked page on the partner's site the booking was made on, so
// "check your booking" in this email opens it there.
export const forPartner = (refCode, message, { pageUrl = null, bookingCode = null } = {}) => throughPartner(pool, { refCode, pageUrl, bookingCode }, message);

export async function placePublicBooking(req, { departureId, body, confirmation = null }) {
  const input = confirmation ? { ...confirmation.payload.input } : parse(publicBookingSchema, body);
  const manifest = confirmation ? confirmation.payload.manifest : manifestFields(body);
  if (!confirmation) input.customerPhone = verifiedPhoneFor(input);
  // Only a page on the partner's registered website survives this; what is
  // kept with a held booking is the checked address, never the browser's.
  if (!confirmation) input.pageUrl = (await partnerPageFor(pool, input.refCode, input.pageUrl)) || undefined;
  // Reservation integrity (catalogue_v2): the form's signals, reduced at once
  // (a hash, a /24, a country code) and kept with a held booking.
  const signals = confirmation ? (confirmation.payload.signals || null) : reduceSignals({
    ip: req.ip, phone: input.customerPhone, device: { userAgent: req.get("user-agent"), language: req.get("accept-language"), hint: input.deviceHint },
  });
  delete input.turnstileToken;
  delete input.phoneToken;
  delete input.deviceHint;
  const hold = !confirmation && await holdForConfirmation(pool);
  const result = await withTransaction(async (c) => {
    // Numbered departures (catalogue_v2): the whole party goes to the
    // lowest-numbered departure of the date that has room for it, and a further
    // departure is opened when none has. A "Join my group" party moves together.
    const routed = catalogueV2Enabled() ? await routeBooking(c, { departureId, seats: input.seats, partyToken: input.partyToken }) : null;
    const dep = await loadDeparture(c, routed ? routed.departureId : departureId, { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    // Two clicks on the same link must make one booking: the held booking is
    // locked after the date, and made only while still unconfirmed.
    if (confirmation) {
      const still = (await c.query("SELECT status FROM booking_confirmations WHERE id = $1 FOR UPDATE", [confirmation.id])).rows[0];
      if (still?.status !== "unconfirmed") throw Object.assign(new AppError(409, "This booking is already confirmed."), { alreadyConfirmed: true });
    }
    // S04 — one live booking per verified number per date. A double-click or a
    // retried request used to make two; a party books its seats in one.
    if (phoneVerificationEnabled() && dep.pledges.some((p) => p.status !== "cancelled" && p.customerPhone === input.customerPhone)) {
      throw new AppError(409, "This phone number already holds a booking on this date. Check your email for its booking code, or reply to it to change the number of seats.");
    }
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (dep.mergedIntoId) throw Object.assign(new AppError(409, "This date was joined with another listing of the same tour and day. Book on that one."), { mergedIntoId: dep.mergedIntoId });
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
    // Group bookings: a booking made through a "Join my group" link joins that
    // party. The party is locked first, so two members joining at once can't
    // both take the last free seats.
    const party = catalogueV2Enabled() && input.partyToken ? await partyToJoin(c, { token: input.partyToken, departureId: dep.id }) : null;
    const free = dep.maxSeats - seatsTotal(dep.pledges) - await heldForWaitlist(c, dep.id);
    if (input.seats > free) {
      throw new AppError(409, party
        ? `Only ${Math.max(0, free)} seat${free === 1 ? " is" : "s are"} left on this date, so the group can't take ${input.seats} more.`
        : "This booking exceeds the remaining seats.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const catalogueCtx = await requireCompleteBooking(c, dep.id, manifest, input.seats, input.customerPhone);
    if (party && !catalogueCtx) throw new AppError(409, "Group links aren't available for this date.");
    if (hold) {
      // Every check passed: hold it for the traveler's confirmation. Nothing
      // is written to pledges, so it counts towards nothing yet.
      const held = await holdBooking(c, {
        departureId: dep.id, bookingCode: await uniqueBookingCode(c), email: input.customerEmail, seats: input.seats,
        payload: { input, manifest, ...(catalogueV2Enabled() ? { signals } : {}) },
      });
      return { held, departure: dep };
    }
    const pricing = computePledgePricing(dep, product, input);
    const refCode = cleanRefCode(input.refCode);
    if (refCode) {
      // Make sure the partner exists so a booking always shows in the report,
      // even if the click-through visit wasn't tracked.
      await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [refCode]);
    }
    const pledgeId = newPledgeId(dep.id);
    const booking = {
      id: pledgeId,
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      source: "public",
      bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c),
      refCode: refCode || null,
      manifest,
      ...pricing,
    };
    await insertPledge(c, dep.id, booking);
    if (catalogueCtx) {
      // Model phase 4: pay at GoAhead. The traveler accepts the Terms here, so
      // the tier version in force now is the one this booking keeps.
      await fixBookingTerms(c, { pledgeId, by: "traveller" });
      // Model phase 5: the published EUR rate, and the current tier's price.
      await stampBookingPrice(c, { pledgeId });
      await payNowIfGoingAhead(c, pledgeId, catalogueCtx.departureId);
    }
    if (party) await joinParty(c, { partyId: party.id, pledgeId });
    if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId });
    // Reservation integrity (catalogue_v2, migration 057): a cluster of
    // single-seat reservations is flagged for staff; it never refuses anything.
    // A booking made from the email link carries the signals of the form it
    // was submitted from, reduced when it was held.
    let flag = null;
    if (catalogueCtx && catalogueV2Enabled() && await integrityAvailable(c)) {
      await recordSignals(c, { pledgeId, departureId: dep.id, seats: input.seats, signals, at: confirmation?.created_at || null });
      flag = await detectCluster(c, { pledgeId });
    }
    // The last seat of the last open departure of the date: open the next.
    if (catalogueCtx && catalogueV2Enabled()) await ensureOpenDeparture(c, dep.id);
    const departure = await loadDeparture(c, dep.id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]), payAtGoAhead: !!catalogueCtx, partyId: party?.id ?? null, flagId: flag?.id ?? null,
      routedTo: routed && routed.routed !== false ? { departureId: dep.id, no: routed.no ?? null, opened: !!routed.opened } : null };
  });
  if (result.held) {
    const d = result.departure;
    const code = result.held.row.booking_code;
    sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats, bookingCode: code,
      url: confirmLink(confirmBookingUrl(result.held.token), result.held.token, input.pageUrl),
    }), { pageUrl: input.pageUrl, bookingCode: code }));
    return { status: 202, audit: { action: "booking.hold", entity: "booking", entityId: code, detail: { departureId, seats: input.seats, source: "public" } }, json: {
      departure: presentDeparture(d, req.user), confirmationRequired: true,
      booking: { bookingCode: code, seats: input.seats, customers: input.customerName, status: "unconfirmed" },
    } };
  }
  const audit = { action: "booking.create", entity: "pledge", entityId: result.booking.id,
    detail: { departureId: result.departure.id, ...(result.routedTo && result.routedTo.departureId !== departureId ? { requestedDepartureId: departureId, departureNo: result.routedTo.no, opened: result.routedTo.opened } : {}), seats: input.seats, source: "public", ...(result.partyId ? { partyId: result.partyId } : {}),
      ...(confirmation ? { confirmedEmail: true } : {}), ...(result.flagId ? { flagId: result.flagId } : {}) } };
  await rememberPartnerPage(pool, result.booking.bookingCode, input.pageUrl);
  const partnerLinks = { pageUrl: input.pageUrl, bookingCode: result.booking.bookingCode };
  const flagAudit = result.flagId ? { action: "booking_flag.raise", entity: "booking_flag", entityId: result.flagId, detail: { pledgeId: result.booking.id } } : null;
  if (input.customerEmail && result.payAtGoAhead) {
    // Model phase 4: nothing is paid until GoAhead, then the full price; the
    // email repeats the cancellation tiers this booking was made under.
    const d = result.departure;
    sendEmailInBackground(bookingPayView(pool, { pledgeId: result.booking.id }).then((view) => payAtGoAheadBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      total: result.booking.bookingTotal, bookingCode: result.booking.bookingCode, terms: view?.terms || null,
    })).then((m) => forPartner(input.refCode, m, partnerLinks)));
  } else if (input.customerEmail) {
    const d = result.departure;
    sendEmailInBackground(operatorFor(d.id).then((operator) => bookingConfirmationEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      depositDue: result.booking.depositDue, balanceDue: result.booking.balanceDue,
      balanceDueDate: result.booking.balanceDueDate, bookingCode: result.booking.bookingCode,
      product: d, operator,
    })).then((m) => forPartner(input.refCode, m, partnerLinks)));
  }
  notifyOps(result.departure, result.booking, input, { isRequest: false });
  // The direct traveller gets their own booking receipt back in full.
  emitDepartureSync(result.departure.id);
  return { status: 201, audit, flagAudit, json: { departure: presentDeparture(result.departure, req.user), booking: result.booking,
    ...(result.routedTo ? { departureNo: result.routedTo.no } : {}) } };
}

// Platform staff remove a pledge outright. Agencies no longer come through
// here: this erases the row and stops only at supplier_confirmed, so an agency
// could walk a seat out of a GoAhead date for free. They use
// POST /api/agency/bookings/:pledgeId/cancel, which follows the Terms.
app.delete("/api/departures/:id/pledges/:pledgeId", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "supplier_confirmed" && !isPlatform(req.user)) {
      throw new AppError(409, "Supplier-confirmed departures need admin cancellation.");
    }
    const found = await c.query(`SELECT * FROM pledges WHERE id=$1 AND departure_id=$2`, [req.params.pledgeId, dep.id]);
    if (!found.rows.length) throw new AppError(404, "Pledge not found.");
    // Tenant check: an agency can only cancel its own pledges.
    if (!isPlatform(req.user) && found.rows[0].agency_id !== req.user.agencyId) {
      throw new AppError(403, "You can only cancel your own agency's bookings.");
    }
    await c.query(`DELETE FROM pledges WHERE id=$1 AND departure_id=$2`, [req.params.pledgeId, dep.id]);
    await refreshStatus(c, dep.id);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "pledge.cancel", entity: "departure", entityId: Number(req.params.id), detail: { pledgeId: req.params.pledgeId } });
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Agency cancels one of its own bookings (or withdraws a date request) from the
// portal's "My bookings".
//
// The DELETE route above predates this and is not what the portal offers: it
// erases the row, so the booking vanishes from the agency's own list and from
// ops' records, and it lets a seat walk out of a date that has reached GoAhead
// for free. This follows the traveller's cancel link instead
// (POST /api/public/bookings/:code/cancel): the pledge is marked `cancelled`, the
// seat is released, and the Terms' boundary is the same — before GoAhead or
// while the date is still under review, free and self-serve; after it, §13.2's
// schedule applies and that goes through Sawa.
//
// Idempotent, like the traveller's route: a double click answers 200.
app.post("/api/agency/bookings/:pledgeId/cancel", requireAuth, requireRole("agency_owner", "agency_agent"), writeLimiter, h(async (req, res) => {
  const pledgeId = String(req.params.pledgeId || "").trim();
  if (!pledgeId) throw new AppError(422, "Booking id required.");

  const result = await withTransaction(async (c) => {
    const found = await c.query(
      `SELECT id, status, departure_id, agency_id FROM pledges WHERE id = $1`,
      [pledgeId]
    );
    // Another agency's booking answers exactly like a missing one — its
    // existence is not this agency's business.
    if (!found.rows.length || found.rows[0].agency_id !== req.user.agencyId) {
      throw new AppError(404, "Booking not found.");
    }
    const pledge = found.rows[0];

    const dep = await loadDeparture(c, pledge.departure_id, { forUpdate: true });
    if (!dep) throw new AppError(404, "Booking not found.");

    const view = bookingLookupView({
      departureStatus: dep.status,
      pledgeStatus: pledge.status,
      seatsBooked: seatsTotal(dep.pledges),
      goAhead: goAheadSeatsFor(dep),
    });
    if (view.state === "booking_cancelled" || view.state === "date_cancelled") {
      return { alreadyDone: true, departureId: dep.id };
    }
    if (!view.canCancel) {
      throw new AppError(409,
        "This date has reached GoAhead, so Sawa's cancellation schedule applies — see section 13 of the Terms. "
        + "Email hello@sawa.tours with the booking and we'll take it from there.");
    }

    await c.query(`UPDATE pledges SET status='cancelled' WHERE id=$1`, [pledge.id]);
    // Model phase 3: a traveler's own cancellation (before GoAhead: no fee).
    if (catalogueV2Enabled()) {
      await c.query(`UPDATE pledges SET cancelled_at = now(), cancelled_reason = 'traveler' WHERE id = $1`, [pledge.id]);
      // Canceled before GoAhead, so before any payment: nothing is owed for it.
      await releaseUnpaidAgencyBookings(c, { pledgeIds: [pledge.id] });
    }
    await refreshStatus(c, dep.id);
    return { alreadyDone: false, departureId: dep.id };
  });

  if (!result.alreadyDone) {
    emitDepartureSync(result.departureId);
    await logAudit(req, {
      action: "booking.cancel", entity: "pledge", entityId: pledgeId,
      detail: { departureId: result.departureId, source: "agency" },
    });
  }
  res.json({ cancelled: true });
}));

// S02 — `DELETE /api/public/departures/:id/bookings/:pledgeId` is gone. It took
// no credential but the pledge id, and the anonymous catalogue published every
// pledge id, so any visitor could cancel any traveller's booking; it also
// erased the row and ignored the GoAhead boundary. A traveller cancels with
// their booking code: POST /api/public/bookings/:code/cancel below.
