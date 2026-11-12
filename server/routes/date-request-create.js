// Making a date request: the one function every way of asking for a new date goes through, and its announcement
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. It registers no routes: it holds what the date-request routes and the
// booking-confirmation link both call, and hands those two functions back to
// app.js, which passes them on. Anything app.js defines for itself arrives
// through the route context it fills first; see server/route-context.js.
import { operatingDayError } from "../../shared/operating-days.js";
import { cleanRefCode } from "../../shared/ref-code.js";
import { minLeadDaysFor, maxHorizonDaysFor } from "../../shared/request-window.js";
import { logAudit } from "../audit.js";
import { unavailableDates } from "../autoura-sync.js";
import { holdBooking, markConfirmed } from "../booking-confirmation.js";
import { withTransaction, pool } from "../db/index.js";
import { mapPledge } from "../db/mappers.js";
import { seatsTotal, computePledgePricing, defaultDepositFor } from "../domain.js";
import { sendEmailInBackground, departureRequestReceivedEmail } from "../email.js";
import { rememberPartnerPage } from "../partner.js";
import { routeContext } from "../route-context.js";

const {
  AppError, uniqueBookingCode, loadProduct, loadDeparture, newPledgeId, insertPledge, presentDeparture,
  NEAR_MATCH_WINDOW_DAYS, forPartner, notifyOps,
} = routeContext();

// ---- Making a date request ---------------------------------------------------
//
// Shared by the routes that take a request and by the confirmation link that
// replays a held one, so it is its own module and both are handed it.
//
// A new date, started by someone outside Sawa — a traveller on the public site
// or an operator from their dashboard. Both go through the same rules (window,
// operating days, blackouts, join-first) and land in the same place: a
// `pending_review` date with one `pending` booking, waiting on Date requests.
// Returns { nearMatches } when open dates already exist close by.
//
// A traveler's request is held for email confirmation (migration 060) with
// `hold`: every check below runs, then nothing is written but the held
// request. The "Confirm my booking" link replays it with `confirmation`,
// through the same checks, keeping its booking code.
export async function createDateRequest(input, req, requester = {}, { hold = false, confirmation = null } = {}) {

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const picked = new Date(`${input.date}T12:00:00`);
  if (isNaN(picked)) throw new AppError(422, "A valid date is required.");
  const daysOut = Math.round((picked - today) / 86400000);
  // The window is checked INSIDE the transaction below, once the product is
  // loaded — it is per product now, and this ran before anything knew which
  // tour was being requested.

  // Operator blackouts (Autoura capacity feed): the weekly pattern may allow
  // this weekday, but not THIS date if the operation is dark. Checked before
  // the transaction — it may involve an HTTP fetch (cached 10 min).
  const blocked = await unavailableDates();
  if (blocked.has(input.date)) {
    throw new AppError(422, "That day isn't available operationally — please pick another date.");
  }

  return withTransaction(async (c) => {
    // Two clicks on the same link make one request.
    if (confirmation) {
      const still = (await c.query("SELECT status FROM booking_confirmations WHERE id = $1 FOR UPDATE", [confirmation.id])).rows[0];
      if (still?.status !== "unconfirmed") throw Object.assign(new AppError(409, "This booking is already confirmed."), { alreadyConfirmed: true });
    }
    const holdRequest = async (departureId) => ({
      product,
      held: await holdBooking(c, {
        kind: "date_request", departureId, tourProductId: product.id, requestDate: input.date,
        bookingCode: await uniqueBookingCode(c), email: input.customerEmail, seats: input.seats, payload: { input },
      }),
    });
    const product = await loadProduct(c, input.tourProductId);
    if (!product || product.active === false || product.status !== "approved") {
      throw new AppError(404, "Tour not found.");
    }

    // The request window, per product. A Nile cruise sold six months ahead and a
    // Cairo day tour sold three weeks ahead want different answers, and until
    // now both got 3/90 from a constant.
    const minLead = minLeadDaysFor(product);
    const maxHorizon = maxHorizonDaysFor(product);
    if (daysOut < minLead) {
      throw new AppError(422, `${product.title} needs at least ${minLead} day${minLead === 1 ? "" : "s"} of notice.`);
    }
    if (daysOut > maxHorizon) {
      throw new AppError(422, `${product.title} can be requested up to ${maxHorizon} days ahead.`);
    }

    // Operating days: a Nile cruise that sails Mondays must not accept a
    // Tuesday request, whatever the client sent. One rule, in shared/, so the
    // admin route below and the date picker cannot drift from this one.
    const dayProblem = operatingDayError(product, input.date);
    if (dayProblem) throw new AppError(422, dayProblem);

    // F02 — the new date is created with the product's maxSeats, so the request
    // that seeds it cannot be bigger. The schema allowed 20 against a 12-seat
    // ceiling (and less on smaller tours), leaving an over-capacity date behind.
    const capacity = Number(product.maxSeats);
    if (Number.isFinite(capacity) && capacity > 0 && input.seats > capacity) {
      throw new AppError(422, `${product.title} takes up to ${capacity} traveler${capacity === 1 ? "" : "s"} per date.`);
    }

    // Same tour, same day (27 Sep 2026): eleven travelers of one group booked
    // the same tour and day separately, and each made a new date — the check
    // below saw only `open` dates, so a date still in review (or already going
    // ahead) was invisible, and the traveler could always press "request my
    // date anyway". An exact day now joins the date that exists, whatever the
    // traveler chose:
    //   - a date awaiting review: this booking joins the request (pending, like
    //     the first), and is approved or declined with it;
    //   - an open or going-ahead date: 409 exact_day, and the client books it
    //     through the normal booking route (its checks, pricing and emails).
    // Only when every such date is full is a second date for that day made.
    // Two requests for the same new day at the same moment: FOR UPDATE below
    // locks rows that exist, and a day with no date yet has none, so both
    // would insert one. Serialize on the tour and day instead; the second
    // request waits, then sees the first one's date and joins it.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('departure-day'), hashtext($1::text || ':' || $2::text))", [product.id, input.date]);
    const merged = (await c.query("SELECT to_regclass('public.departure_merges') AS t")).rows[0].t != null;
    const sameDay = await c.query(
      `SELECT id, status FROM departures
        WHERE tour_product_id = $1 AND COALESCE(start_date, date) = $2::date
          AND status IN ('pending_review', 'open', 'minimum_reached', 'supplier_confirmed')
          ${merged ? "AND merged_into_id IS NULL" : ""}
        ORDER BY (status = 'pending_review'), id FOR UPDATE`,
      [product.id, input.date]);
    const bookable = [];
    for (const row of sameDay.rows) {
      const d = await loadDeparture(c, row.id);
      if (!d || seatsTotal(d.pledges) + input.seats > d.maxSeats) continue;
      if (d.status === "pending_review") {
        if (bookable.length) continue;
        if (hold) return holdRequest(d.id);
        const joinPricing = computePledgePricing(d, product, input);
        const joinRef = requester.agencyId ? "" : cleanRefCode(input.refCode);
        if (joinRef) await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [joinRef]);
        const joinId = newPledgeId(d.id);
        await insertPledge(c, d.id, {
          id: joinId,
          agencyId: requester.agencyId || "direct_customer",
          agency: requester.agencyName || "Direct traveler",
          seats: input.seats, customers: input.customerName, customerEmail: input.customerEmail,
          customerPhone: input.customerPhone || null,
          source: requester.agencyId ? "agency_request" : "public_request",
          createdByUserId: requester.userId || null,
          bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c), refCode: joinRef || null,
          ...joinPricing, status: "pending",
        });
        if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId: joinId });
        const joined = await loadDeparture(c, d.id);
        const savedJoin = await c.query(`SELECT * FROM pledges WHERE id=$1`, [joinId]);
        return { departure: joined, booking: mapPledge(savedJoin.rows[0]), joinedRequest: true };
      }
      bookable.push(presentDeparture(d, req.user));
    }
    if (bookable.length) return { exactDay: bookable };

    // Join-first rule: surface bookable departures for the same tour within
    // the match window. The client may reject these near dates (ignoreMatches)
    // — a different day is a real choice — but never the same day (above).
    if (!input.ignoreMatches) {
      const win = await c.query(
        `SELECT id FROM departures
         WHERE tour_product_id = $1 AND status IN ('open', 'minimum_reached', 'supplier_confirmed')
           AND COALESCE(start_date, date) BETWEEN ($2::date - $3::int) AND ($2::date + $3::int)
           ${merged ? "AND merged_into_id IS NULL" : ""}
         ORDER BY COALESCE(start_date, date) ASC`,
        [product.id, input.date, NEAR_MATCH_WINDOW_DAYS]
      );
      const matches = [];
      for (const row of win.rows) {
        const d = await loadDeparture(c, row.id);
        if (d && seatsTotal(d.pledges) < d.maxSeats) matches.push(presentDeparture(d, req.user));
      }
      if (matches.length > 0) {
        return { nearMatches: matches };
      }
    }

    if (hold) return holdRequest(null);
    const isPkg = product.type === "package";
    let endDate = null;
    if (isPkg && product.nights) {
      const e = new Date(`${input.date}T12:00:00`);
      e.setDate(e.getDate() + Number(product.nights));
      endDate = e.toISOString().slice(0, 10);
    }
    const id = (await c.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;
    await c.query(
      `INSERT INTO departures
        (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
         city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
         quality, status, notes, deposit_percent, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,'pending_review',$20,$21,$22)`,
      [
        id, product.type, product.id, product.title, input.date,
        isPkg ? input.date : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, product.defaultTime,
        product.city, product.guide, product.vehicle,
        Number(product.minSeats), Number(product.maxSeats),
        Number(product.baseCost || 0), Number(product.publishedRate),
        Number(product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality,
        requester.agencyId
          ? `Operator request (${requester.agencyName})${input.note ? `: ${input.note}` : " awaiting review."}`
          : input.note ? `Traveler request: ${input.note}` : "Traveler-requested date awaiting review.",
        Number(product.depositPercent || defaultDepositFor(product)),
        requester.agencyId ? "agency" : "traveler",
      ]
    );

    const dep = await loadDeparture(c, id);
    const pricing = computePledgePricing(dep, product, input);
    // A traveller's request made through a partner's widget is credited to
    // that partner, the same as a booking on an existing date. An operator's
    // own request is theirs already and carries no code.
    const refCode = requester.agencyId ? "" : cleanRefCode(input.refCode);
    if (refCode) await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [refCode]);
    const pledgeId = newPledgeId(id);
    await insertPledge(c, id, {
      id: pledgeId,
      agencyId: requester.agencyId || "direct_customer",
      agency: requester.agencyName || "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone || null,
      source: requester.agencyId ? "agency_request" : "public_request",
      createdByUserId: requester.userId || null,
      bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c),
      refCode: refCode || null,
      ...pricing,
      // Nobody has approved this date yet, so the booking is not confirmed
      // either. It still holds its seats (every count reads `<> 'cancelled'`);
      // approve moves it to `confirmed`, decline to `cancelled`. Before this it
      // took the column default and every request read "confirmed" in admin.
      status: "pending",
    });
    if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId });
    const departure = await loadDeparture(c, id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]) };
  });
}

// A traveler's request is made (at once, or from its confirmation link): the
// audit line, the traveler's "request received" email, and ops.
export async function announceDateRequest(req, input, result, { confirmedEmail = false } = {}) {
  await logAudit(req, {
    action: result.joinedRequest ? "departure_request.join" : "departure_request.create", entity: "departure", entityId: String(result.departure.id),
    detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "public", joinedExisting: !!result.joinedRequest, ...(confirmedEmail ? { confirmedEmail: true } : {}) },
  });
  const d = result.departure;
  sendEmailInBackground(forPartner(input.refCode, departureRequestReceivedEmail({
    to: input.customerEmail, customerName: input.customerName, route: d.route,
    dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date,
    seats: input.seats, bookingCode: result.booking.bookingCode,
  }), { pageUrl: input.pageUrl, bookingCode: result.booking.bookingCode }));
  await rememberPartnerPage(pool, result.booking.bookingCode, input.pageUrl);
  notifyOps(d, result.booking, input, { isRequest: true });
}
