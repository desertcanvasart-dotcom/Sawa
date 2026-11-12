// A traveller's own booking: looking it up, confirming it, the group link, the waitlist and cancelling, plus the public tour and date reads
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { emitDepartureSync, unavailableDates } from "../autoura-sync.js";
import { heldByCode, isExpired, MAX_RESENDS, heldByToken, markRefused, resendLink, confirmBookingUrl, cancelHeld } from "../booking-confirmation.js";
import { partyForBooking, JOINABLE_STATUSES, partiesAvailable, partyLinkFor, partyView } from "../booking-parties.js";
import { BRAND } from "../brand.js";
import { fixBookingTerms } from "../cancellation-tiers.js";
import { releaseUnpaidAgencyBookings } from "../commissions.js";
import { pool, withTransaction } from "../db/index.js";
import { isoDate, mapPledge } from "../db/mappers.js";
import { refreshStatus } from "../departure-status.js";
import { bookingLookupView, bookingClosed, MAX_GROUP_SIZE, seatsTotal, computePledgePricing, goAheadSeatsFor } from "../domain.js";
import { sendEmailInBackground, operatorApplicationEmail, operatorApplicationReceiptEmail, operatorApplicationText, confirmBookingEmail, sendEmail } from "../email.js";
import { catalogueV2Enabled } from "../features.js";
import { partnerJoinUrl, confirmLink } from "../partner.js";
import { bookingPayView, acceptBookingTerms, acceptSellerChangeOffer, joinWaitlist, waitlistOffer, claimWaitlistOffer, completeWaitlistOffer } from "../pay-at-goahead.js";
import { paymentsByPledge, paymentSummary, STAGE_LABEL, isMissingPaymentsTable } from "../payments.js";
import { stampBookingPrice } from "../pool-settlement.js";
import { buildHead } from "../seo.js";
import { tourPath } from "../slug.js";
import { routeContext } from "../route-context.js";

const {
  app, writeLimiter, h, parse, operatorApplicationSchema, AppError, placePublicBooking, createDateRequest,
  announceDateRequest, forPartner, loadDeparture, loadProduct, manifestFields, heldForWaitlist,
  requireCompleteBooking, newPledgeId, insertPledge, uniqueBookingCode, publicBootstrapPayload,
} = routeContext();

// Public: an operator applies to be verified and list (site/verify.html).
//
// Open like the public booking route, behind the same stricter write limiter.
// The row is written first and the two emails are sent afterwards, deliberately
// in that order: an application must survive an email outage, and email delivery
// runs in "log" mode until RESEND_API_KEY is set. The applicant gets a reference
// back so a lost email is still traceable.
app.post("/api/operator-applications", writeLimiter, h(async (req, res) => {
  const input = parse(operatorApplicationSchema, req.body);
  const reference = `OP-${randomBytes(3).toString("hex").toUpperCase()}`;
  await pool.query(
    `INSERT INTO operator_applications
       (reference, company, contact_name, city, email, phone, licence, regions, about)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [reference, input.company, input.contactName, input.city, input.email,
     input.phone || null, input.licence, input.regions || null, input.about || null]
  );
  await logAudit(req, {
    action: "operator_application.create", entity: "operator_application", entityId: reference,
    detail: { company: input.company, city: input.city },
  });
  const payload = { ...input, reference };
  sendEmailInBackground(operatorApplicationEmail({ to: BRAND.email, ...payload }));
  sendEmailInBackground(operatorApplicationReceiptEmail({ to: input.email, ...payload }));
  res.status(201).json({ reference, copy: operatorApplicationText(input) });
}));

// Public: look up a booking by its code to see GoAhead status. No auth, no PII.
app.get("/api/public/bookings/:code", h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const r = await pool.query(
    `SELECT p.id AS pledge_id, p.booking_code, p.seats, p.status AS pledge_status,
            p.booking_total, p.deposit_due, p.balance_due, p.balance_due_date,
            d.id AS dep_id, d.route, d.date, d.start_date, d.end_date, d.city,
            d.status AS dep_status, d.min_seats,
            (SELECT COALESCE(SUM(seats), 0) FROM pledges WHERE departure_id = d.id AND status <> 'cancelled') AS seats_booked,
            tp.title AS product_title, tp.id AS product_id, tp.type AS product_type, tp.city AS product_city
       FROM pledges p
       JOIN departures d ON d.id = p.departure_id
       LEFT JOIN tour_products tp ON tp.id = d.tour_product_id
      WHERE UPPER(p.booking_code) = UPPER($1)
      LIMIT 1`,
    [code]
  );
  if (!r.rows.length) {
    const held = await heldByCode(pool, code);
    if (!held) throw new AppError(404, "Booking not found.");
    return res.json({ booking: await heldBookingView(held) });
  }
  const b = r.rows[0];
  const goAhead = Number(b.min_seats) || 4;
  const seatsBooked = Number(b.seats_booked) || 0;

  // LL3.1 / LL3.2 — the whole answer comes from domain.js, so it can be tested
  // without a database. The date's own status is the first thing asked there.
  const view = bookingLookupView({
    departureStatus: b.dep_status,
    pledgeStatus: b.pledge_status,
    seatsBooked,
    goAhead,
  });

  const fmt = (s) => {
    if (!s) return "";
    const d = s instanceof Date ? s : new Date(`${s}T12:00:00`);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  };
  // A day tour has a start_date and no end_date, and this read
  // `start ? start + " – " + end : date`, so it rendered "Sat, Aug 29, 2026 – "
  // with a dangling dash for every single-day booking. Found while checking the
  // states above; it is the same response object, so it is corrected here.
  const startLabel = fmt(b.start_date) || fmt(b.date);
  const endLabel = fmt(b.end_date);
  const dateLabel = endLabel && endLabel !== startLabel ? `${startLabel} – ${endLabel}` : startLabel;

  // Where "other dates on this route" actually goes. The cancellation email
  // offers the whole board, which is the weakest version of the offer: someone
  // who wanted the pyramids at dawn is handed everything Sawa sells.
  const routePath = b.product_id
    ? tourPath({ id: b.product_id, title: b.product_title, type: b.product_type, city: b.product_city })
    : null;

  // 043 — where payment stands, and the open link if there is one: the same
  // link the traveller was emailed, reached with the same booking code.
  let payment = null;
  try {
    const rows = (await paymentsByPledge(pool, [b.pledge_id])).get(b.pledge_id) || [];
    const s = paymentSummary({
      pledge: {
        status: b.pledge_status, bookingTotal: b.booking_total != null ? Number(b.booking_total) : 0,
        depositDue: b.deposit_due != null ? Number(b.deposit_due) : 0, balanceDueDate: isoDate(b.balance_due_date),
      },
      payments: rows, goAhead: ["minimum_reached", "supplier_confirmed"].includes(b.dep_status),
    });
    payment = {
      stage: s.stage, label: STAGE_LABEL[s.stage], paid: s.paid, outstanding: s.outstanding, total: s.total,
      open: s.open ? { kind: s.open.kind, amount: s.open.amount, dueAt: s.open.dueAt, linkUrl: s.open.linkUrl, overdue: s.open.overdue } : null,
    };
  } catch (e) {
    if (!isMissingPaymentsTable(e)) throw e;
  }

  // Model phase 4: a pay-at-GoAhead booking shows its full-price request and
  // the cancellation terms it was made under (an agency's traveler accepts
  // that same version here).
  let payAtGoAhead = null;
  if (catalogueV2Enabled()) {
    try {
      payAtGoAhead = await bookingPayView(pool, { pledgeId: b.pledge_id });
    } catch (e) {
      if (e?.code !== "42P01" && e?.code !== "42703") throw e;
    }
  }

  // Group bookings: the booking's "Join my group" link, once it has one, and
  // whether it can start one.
  let group = null;
  if (catalogueV2Enabled() && payAtGoAhead && b.pledge_status !== "cancelled") {
    const party = await partyForBooking(pool, b.pledge_id);
    // Shared from a partner's page, the link brings friends to that page.
    if (party?.url) party.url = await partnerJoinUrl(pool, b.booking_code, party.url);
    group = party || (JOINABLE_STATUSES.includes(b.dep_status) && await partiesAvailable(pool) ? { url: null } : null);
  }

  // "Nothing was charged" isn't true of a pay-at-GoAhead booking canceled
  // after it paid, and a released seat has its own reason.
  const payReq = payAtGoAhead?.request;
  if (view.state === "booking_cancelled" && payReq?.state === "paid") {
    view.note = "This booking was canceled. Any refund due under your cancellation terms is made to the card you paid with.";
  } else if (view.state === "booking_cancelled" && payReq?.state === "released") {
    view.note = "This seat was released because payment wasn't received by the deadline. Nothing was charged.";
  }

  res.json({ booking: {
    code: b.booking_code,
    tourTitle: b.product_title || b.route,
    payment: payAtGoAhead ? null : payment,
    payAtGoAhead,
    group,
    city: b.city || "",
    dateLabel,
    seats: Number(b.seats),
    seatsBooked,
    goAhead,
    routePath,
    ...view,
  } });
}));

// A booking held for email confirmation (058), as the booking page shows it.
// It isn't a booking yet, so it shows no seat count and no payment.
const HELD_VIEW = {
  unconfirmed: { statusLabel: "Waiting for your confirmation", statusTone: "pending",
    note: "Check your email to confirm your booking. It's made when you click the link, and lapses if it isn't confirmed within 24 hours." },
  expired: { statusLabel: "Not confirmed", statusTone: "cancelled",
    note: "This booking wasn't confirmed within 24 hours, so it lapsed. Nothing was charged. You can book again while places remain." },
  cancelled: { statusLabel: "Canceled", statusTone: "cancelled", note: "This booking was canceled before it was confirmed. Nothing was charged." },
  refused: { statusLabel: "Not booked", statusTone: "cancelled", note: "We couldn't make this booking when it was confirmed. Nothing was charged." },
};
async function heldBookingView(held, now = Date.now()) {
  const state = isExpired(held, now) ? "expired" : held.status;
  const d = held.departure_id != null ? (await pool.query(
    `SELECT d.route, d.date, d.start_date, d.city, tp.title FROM departures d LEFT JOIN tour_products tp ON tp.id = d.tour_product_id WHERE d.id = $1`,
    [held.departure_id])).rows[0] || {}
    // A date request for a new day (060): the tour and the day asked for.
    : { ...((await pool.query("SELECT title, city FROM tour_products WHERE id = $1", [held.tour_product_id])).rows[0] || {}), date: held.request_date };
  const day = d.start_date || d.date;
  const dateLabel = day ? new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${isoDate(day)}T12:00:00Z`)) : "";
  const v = HELD_VIEW[state] || HELD_VIEW.unconfirmed;
  return {
    code: held.booking_code, tourTitle: d.title || d.route || "", city: d.city || "", dateLabel, seats: Number(held.seats),
    state: `held_${state}`, ...v, ...(state === "refused" && held.refused_reason ? { note: `${v.note} ${held.refused_reason}` } : {}),
    confirmed: false, showProgress: false, canCancel: state === "unconfirmed",
    confirmation: { state, resendsLeft: state === "unconfirmed" ? Math.max(0, MAX_RESENDS - Number(held.resends)) : 0 },
  };
}

// The "Confirm my booking" link (058). A POST, made by the page behind the
// link, so a mail client that prefetches links can't confirm for anyone. The
// booking is made now, through the same checks as the booking form.
app.post("/api/public/booking-confirmations/:token", writeLimiter, h(async (req, res) => {
  const held = await heldByToken(pool, String(req.params.token || ""));
  if (!held) throw new AppError(404, "This link isn't valid. If you asked for a new email, use the link in the newest one.");
  if (held.status === "confirmed") return res.json({ state: "already", code: held.booking_code });
  if (held.status !== "unconfirmed" || isExpired(held)) return res.json({ state: isExpired(held) ? "expired" : held.status, code: held.booking_code });
  if (held.kind === "date_request") return confirmHeldDateRequest(req, res, held);
  let out;
  try {
    out = await placePublicBooking(req, { departureId: Number(held.departure_id), confirmation: held });
  } catch (e) {
    if (e?.alreadyConfirmed) return res.json({ state: "already", code: held.booking_code });
    if (!(e?.status >= 400 && e.status < 500)) throw e;
    // The date changed while the booking waited (full, closed, canceled).
    await markRefused(pool, { id: held.id, reason: e.message });
    await logAudit(req, { action: "booking.hold_refused", entity: "booking", entityId: held.booking_code, detail: { reason: e.message } });
    return res.status(409).json({ state: "refused", code: held.booking_code, error: `We couldn't make this booking: ${e.message} Nothing was charged.` });
  }
  await logAudit(req, out.audit);
  if (out.flagAudit) await logAudit(req, out.flagAudit);
  await logAudit(req, { action: "booking.email_confirmed", entity: "pledge", entityId: out.json.booking.id, detail: { bookingCode: held.booking_code } });
  res.json({ state: "confirmed", code: held.booking_code });
}));

// A held date request (060), confirmed: made now through createDateRequest's
// checks. A group that formed on that day meanwhile is not joined silently:
// the traveler is sent to book on it.
async function confirmHeldDateRequest(req, res, held) {
  const input = { ...(held.payload?.input || {}), ignoreMatches: true };
  const refuse = async (reason) => {
    await markRefused(pool, { id: held.id, reason });
    await logAudit(req, { action: "departure_request.hold_refused", entity: "booking", entityId: held.booking_code, detail: { reason } });
    return res.status(409).json({ state: "refused", code: held.booking_code, error: `We couldn't make this request: ${reason} Nothing was charged.` });
  };
  let result;
  try {
    result = await createDateRequest(input, req, {}, { confirmation: held });
  } catch (e) {
    if (e?.alreadyConfirmed) return res.json({ state: "already", code: held.booking_code });
    if (!(e?.status >= 400 && e.status < 500)) throw e;
    return refuse(e.message);
  }
  if (result.exactDay) return refuse("A group formed on that day while your request waited. Book a place on it from the tour page.");
  await announceDateRequest(req, input, result, { confirmedEmail: true });
  await logAudit(req, { action: "booking.email_confirmed", entity: "pledge", entityId: result.booking.id, detail: { bookingCode: held.booking_code, dateRequest: true } });
  res.json({ state: "confirmed", code: held.booking_code });
}

// Send the confirmation email again: a new link, at most 3 times.
app.post("/api/public/bookings/:code/resend-confirmation", writeLimiter, h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  const r = await resendLink(pool, { code });
  if (r.error === 404) throw new AppError(404, "Booking not found.");
  if (r.error === 409) throw new AppError(409, "This booking isn't waiting for confirmation any more.");
  if (r.error === 429) throw new AppError(429, `The confirmation email has already been sent again ${MAX_RESENDS} times. Email hello@sawa.tours and we'll confirm it for you.`);
  const d = r.row.departure_id != null
    ? (await pool.query("SELECT route, date, start_date, end_date FROM departures WHERE id = $1", [r.row.departure_id])).rows[0] || {}
    : { route: (await pool.query("SELECT title FROM tour_products WHERE id = $1", [r.row.tour_product_id])).rows[0]?.title, date: r.row.request_date };
  const input = r.row.payload?.input || {};
  sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
    to: r.row.email, customerName: input.customerName, route: d.route,
    dateLabel: d.start_date ? `${isoDate(d.start_date)} – ${isoDate(d.end_date)}` : isoDate(d.date), seats: Number(r.row.seats),
    bookingCode: r.row.booking_code, url: confirmLink(confirmBookingUrl(r.token), r.token, input.pageUrl), dateRequest: r.row.kind === "date_request",
  }), { pageUrl: input.pageUrl, bookingCode: r.row.booking_code }));
  await logAudit(req, { action: "booking.hold_resend", entity: "booking", entityId: r.row.booking_code, detail: { resends: r.row.resends } });
  res.json({ sent: true, resendsLeft: Math.max(0, MAX_RESENDS - r.row.resends) });
}));

// Model phase 4: the traveler of an agency booking accepts the cancellation
// terms the agency booked under (never the current ones). The version id is
// the one the booking page showed; any other is refused.
app.post("/api/public/bookings/:code/accept-terms", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const result = await acceptBookingTerms(pool, { code, versionId: req.body?.versionId });
  await logAudit(req, { action: "booking.accept_terms", entity: "booking", entityId: code.toUpperCase(), detail: { tierVersionId: result.versionId } });
  res.json(result);
}));

// Group bookings: the booking's "Join my group" link. The first request starts
// the party with this booking as its lead; later ones return the same link.
app.post("/api/public/bookings/:code/party", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const link = await partyLinkFor(pool, { code });
  await logAudit(req, { action: link.created ? "party.create" : "party.link_view", entity: "party", entityId: link.partyId, detail: { bookingCode: code.toUpperCase() } });
  res.json({ group: { url: await partnerJoinUrl(pool, code, link.url), seatsLeft: link.seatsLeft } });
}));

// What a "Join my group" link shows: the date, the lead's first name and the
// seats left. Booking goes through the ordinary booking route with the token.
app.get("/api/public/parties/:token", h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const v = await partyView(pool, { token: String(req.params.token || "") });
  const dep = await loadDeparture(pool, v.departureId);
  const product = dep?.tourProductId ? await loadProduct(pool, dep.tourProductId) : null;
  const closed = !dep || !JOINABLE_STATUSES.includes(dep.status) || bookingClosed(dep, product);
  res.json({
    group: { leadFirstName: v.leadFirstName, seats: v.groupSeats },
    departure: dep ? {
      id: dep.id, title: product?.title || dep.route, city: dep.city || "", date: dep.startDate || dep.date, endDate: dep.endDate || null,
      path: product ? tourPath(product) : null,
    } : null,
    seatsLeft: closed ? 0 : v.seatsLeft,
    bookable: !closed && v.seatsLeft > 0,
  });
}));

// The seller changed after the traveler paid (the first operator failed and
// Sawa reassigned): for 48 hours the traveler may cancel with a full refund.
// The booking code is the credential, as for the terms above.
app.post("/api/public/bookings/:code/seller-change/cancel", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const result = await acceptSellerChangeOffer(pool, { code, by: "traveler", send: sendEmail });
  await logAudit(req, { action: "booking.seller_change_cancel", entity: "booking", entityId: code.toUpperCase(),
    detail: { offerId: result.offerId, refundEur: result.refund, paidEur: result.paid } });
  res.json({ canceled: true, refundEur: result.refund, refund: result.refundRecord });
}));

// Model phase 4: the waitlist for a full departure, and the offer a waiting
// traveler gets when a seat is released.
const waitlistSchema = z.object({
  name: z.string().trim().min(1, "Your name is required.").max(160),
  email: z.string().trim().email("A valid email is required.").max(200),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  seats: z.coerce.number().int().min(1).max(MAX_GROUP_SIZE),
});
app.post("/api/public/departures/:id/waitlist", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const input = parse(waitlistSchema, req.body);
  const entry = await joinWaitlist(pool, {
    legacyDepartureId: Number(req.params.id), name: input.name, email: input.email, phone: input.phone || null, seats: input.seats,
  });
  await logAudit(req, { action: "waitlist.join", entity: "departure", entityId: Number(req.params.id), detail: { seats: input.seats, position: entry.position } });
  res.status(201).json({ waitlist: { position: entry.position, seats: entry.seats } });
}));

app.get("/api/public/waitlist/:token", h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  res.json(await waitlistOffer(pool, { token: String(req.params.token || "") }));
}));

// The waiting traveler books the held seats. The departure is going ahead, so
// the booking is asked to pay at once; a seat freed by a paid cancellation is
// resold, and that traveler's retained fee is returned.
app.post("/api/public/waitlist/:token/book", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const manifest = manifestFields(req.body);
  const result = await withTransaction(async (c) => {
    const { entry, departure: cat } = await claimWaitlistOffer(c, { token: String(req.params.token || "") });
    const dep = await loadDeparture(c, cat.legacyDepartureId, { forUpdate: true });
    if (!dep || dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (seatsTotal(dep.pledges) + await heldForWaitlist(c, dep.id, entry.seats) + entry.seats > dep.maxSeats) {
      throw new AppError(409, "The held seats are no longer available. Please contact us.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    const phone = String(req.body?.customerPhone || entry.phone || "").trim() || null;
    await requireCompleteBooking(c, dep.id, manifest, entry.seats, phone);
    const pricing = computePledgePricing(dep, product, { seats: entry.seats, roomingType: req.body?.roomingType, accommodationTier: req.body?.accommodationTier });
    const pledgeId = newPledgeId(dep.id);
    await insertPledge(c, dep.id, {
      id: pledgeId, agencyId: "direct_customer", agency: "Direct traveler", seats: entry.seats, customers: entry.name,
      customerEmail: entry.email, customerPhone: phone, source: "public", bookingCode: await uniqueBookingCode(c), manifest, ...pricing,
    });
    await fixBookingTerms(c, { pledgeId, by: "traveller" });
    await stampBookingPrice(c, { pledgeId });
    const done = await completeWaitlistOffer(c, { entryId: entry.id, pledgeId, departure: cat });
    const saved = (await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId])).rows[0];
    return { booking: mapPledge(saved), departureId: dep.id, request: done.request };
  });
  await logAudit(req, { action: "waitlist.book", entity: "pledge", entityId: result.booking.id, detail: { departureId: result.departureId } });
  emitDepartureSync(result.departureId);
  res.status(201).json({ booking: { code: result.booking.bookingCode, seats: result.booking.seats } });
}));

// Public: a traveller releases their own seat, using the code from their email.
//
// WHY A SECOND CANCEL ROUTE, AND WHY THIS ONE IS THE ADVERTISED ONE
//
// `DELETE /api/public/departures/:id/bookings/:pledgeId` already existed, and
// nothing durable ever pointed at it. Its handle lived in a React `useState`,
// so the cancel button vanished on the first page refresh: in practice a
// traveller could cancel in the tab they booked in, for as long as they left it
// open, and never again. The confirmation email carried no link at all.
//
// That route cannot become the link, for two reasons:
//
//   1. The pledge id is `pl_<departureId>_<time36><6 hex>` — 24 bits of
//      randomness behind a guessable timestamp. Acceptable for a handle nobody
//      is given; thin for an unauthenticated destructive action about to be
//      mailed to every customer. The booking code is 8 characters from a
//      31-character alphabet, ~8.5e11 combinations, and is ALREADY the key for
//      the lookup route above and already in the traveller's inbox.
//   2. It DELETEs the row, so the code stops resolving and the lookup page
//      answers "no booking found" to someone who just cancelled. Marking the
//      pledge `cancelled` lands in `booking_cancelled`, a state domain.js
//      already computes and already has copy for: "This booking was cancelled.
//      Nothing was charged for it."
//
// Cancelled rather than deleted also keeps the seat release honest: every seat
// count in the system reads `status <> 'cancelled'`, so the seat is genuinely
// returned to the departure while the record survives for ops and audit.
//
// Idempotent by design. A traveller who clicks the link twice, or whose mail
// client prefetches it, gets the same 200 and the same state rather than a 404
// telling them something went wrong.
app.post("/api/public/bookings/:code/cancel", writeLimiter, h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  // A booking still waiting for its email confirmation (058) isn't in
  // pledges yet: canceling it just drops the hold.
  const held = await heldByCode(pool, code);
  if (held && !held.pledge_id) {
    if (await cancelHeld(pool, { code })) {
      await logAudit(req, { action: "booking.hold_cancel", entity: "booking", entityId: held.booking_code });
    }
    return res.json({ cancelled: true });
  }

  const result = await withTransaction(async (c) => {
    // The pledge and its departure are read under the departure's lock, because
    // whether this cancel is allowed depends on a seat count that another
    // booking may be changing in the same instant.
    const found = await c.query(
      `SELECT p.id, p.status AS pledge_status, p.departure_id
         FROM pledges p WHERE UPPER(p.booking_code) = UPPER($1) LIMIT 1`,
      [code]
    );
    if (!found.rows.length) throw new AppError(404, "Booking not found.");
    const pledge = found.rows[0];

    const dep = await loadDeparture(c, pledge.departure_id, { forUpdate: true });
    if (!dep) throw new AppError(404, "Booking not found.");

    const view = bookingLookupView({
      departureStatus: dep.status,
      pledgeStatus: pledge.pledge_status,
      seatsBooked: seatsTotal(dep.pledges),
      goAhead: goAheadSeatsFor(dep),
    });

    // Already cancelled, either by the traveller or with the whole date. Report
    // it as done rather than as an error — see the idempotency note above.
    if (view.state === "booking_cancelled" || view.state === "date_cancelled") {
      return { alreadyDone: true, departureId: dep.id };
    }
    if (!view.canCancel) {
      // Terms §13.2, and the wording matters: the default schedule is SAWA'S,
      // not the operator's. An Operating Partner's own schedule applies "only
      // if it was clearly disclosed before reservation". Saying "the operator's
      // policy" hands off a term Sawa sets, to a traveller who is already
      // unhappy and is about to go looking for it.
      throw new AppError(409,
        "This date has reached GoAhead, so our cancellation schedule applies — see section 13 of the Terms. "
        + "Email hello@sawa.tours with your booking code and we'll take it from there.");
    }

    await c.query(`UPDATE pledges SET status='cancelled' WHERE id=$1`, [pledge.id]);
    if (catalogueV2Enabled()) {
      await c.query(`UPDATE pledges SET cancelled_at = now(), cancelled_reason = 'traveler' WHERE id = $1`, [pledge.id]);
      // A widget booking belongs to an agency: canceled before payment, nothing is owed for it.
      await releaseUnpaidAgencyBookings(c, { pledgeIds: [pledge.id] });
    }
    // The seat is released, so the departure may fall back below its minimum —
    // the same recomputation the pledge-id route does.
    await refreshStatus(c, dep.id);
    return { alreadyDone: false, pledgeId: pledge.id, departureId: dep.id };
  });

  if (!result.alreadyDone) {
    emitDepartureSync(result.departureId);
    // Unauthenticated, so the actor is "public" — the booking code is the only
    // thing that proved anything, and it is deliberately NOT logged in full.
    await logAudit(req, {
      action: "booking.cancel", entity: "pledge", entityId: result.pledgeId,
      detail: { departureId: result.departureId, source: "public", via: "booking_code" },
    });
  }
  res.json({ cancelled: true });
}));

// ---- Referrals / affiliate tracking -----------------------------------------

// Public: count a click-through from a partner widget. Fire-and-forget.
// Dates travelers must not start a departure on (operator blackouts, via the
// Autoura capacity feed). Public and cache-friendly: dates only, no reasons.
// Public: one product in full, for a page that arrived holding the sliced copy.
//
// sliceBootstrapForRoute strips itinerary, inclusions and the rest from every
// product except the route's own, so a client-side click from the catalogue to
// a tour renders DetailPending skeletons and swaps in the real content when the
// background refresh lands — a visible second version of the page. This lets
// that page fetch just the part it is missing instead of waiting on the whole
// 135KB catalogue.
//
// Served from the same memoised anonymous payload the page was built from, so
// it costs no query, cannot disagree with the inlined copy, and carries the
// same redaction. Never buildBootstrap(req.user) here — see renderPage.
app.get("/api/public/tour-products/:id", h(async (req, res) => {
  const payload = await publicBootstrapPayload();
  const product = (payload.tourProducts || []).find((p) => String(p.id) === String(req.params.id));
  if (!product) throw new AppError(404, "Tour not found.");
  // Matches the inlined payload's own freshness: detail fields are edited by
  // operators, not by bookings, so this does not carry live seat counts.
  res.set("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  res.json({ product });
}));

// E01 — the <head> facts for a route, for the SPA to apply after a client-side
// navigation. The same buildHead() the server renders pages with, so a title
// can't differ between a direct load and a click. Only paths that buildHead
// serves; portal, API and static /site pages never reach here.
app.get("/api/public/route-head", h(async (req, res) => {
  const path = String(req.query.path || "");
  if (!/^\/[A-Za-z0-9\-/_.%]*$/.test(path) || path.length > 300 || /^\/(api|admin|agency|portal|embed)(\/|$)/.test(path)) {
    throw new AppError(422, "Invalid path.");
  }
  const { meta, notFound } = await buildHead(path);
  res.set("Cache-Control", path.startsWith("/blog") ? "no-store" : "public, max-age=60, s-maxage=300");
  res.json({ ...meta, notFound });
}));

app.get("/api/public/unavailable-dates", h(async (_req, res) => {
  const blocked = await unavailableDates();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ dates: [...blocked].sort() });
}));
