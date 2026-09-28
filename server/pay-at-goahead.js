// Pay at GoAhead ("mode C", model phase 4): catalog departures only, behind
// catalogue_v2. docs/phase4/payments-readiness.md section 9 is the design.
//
//   Booking     no payment; the booking fixes its cancellation-tier version
//               (server/cancellation-tiers.js) and counts toward GoAhead.
//   GoAhead     one request per booking for the full published price (an
//               agency-billed seat: the agency, for its invoice amount),
//               through the payment provider (server/payment-providers/).
//   Deadline    the window from when the link is sent (48 hours by default),
//               capped at the cut-off. A reminder at the halfway point; ops
//               warned 2 hours before a release.
//   Release     unpaid at the deadline: the booking is canceled as `unpaid`,
//               exactly like a cancellation before the cut-off (Operator
//               Supply Agreement 10.1): off the manifest, the band
//               recalculated, the operator not paid for it. The departure
//               stays guaranteed. The seat is offered to the waitlist.
//   Refunds     a paid booking canceled later keeps full price × the tier's
//               retained percentage; the rest is refunded. If a waitlisted
//               traveler takes the seat before the cut-off, the fee is
//               returned too.
//
// Legacy bookings (payment_mode 'legacy_link') never come through here.
import { createHash, randomBytes } from "node:crypto";
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CatalogueError, todayIn, departureInstants, mapCatalogueProduct } from "./catalogue.js";
import { refreshStatus } from "./departure-status.js";
import { cleanLinkUrl } from "./payments.js";
import { activeProvider, providerFor } from "./payment-providers/index.js";
import { tierVersionById, bookingTerms } from "./cancellation-tiers.js";
import {
  DEFAULT_WINDOW_HOURS, WINDOW_HOURS_CHOICES, DEFAULT_OFFER_HOURS, payDeadline, reminderDue, releaseWarningDue,
  releaseDue, extensionError, paymentStanding, nextOffer, offerExpiresAt,
  linkAlertDue, decisionDueAt, tooLateToStart, shortDeadlineError, UNLINKED_DECISIONS, MIN_TRAVELER_HOURS,
  sellerLine, payeeLine, SELLER_PENDING,
} from "../shared/pay-at-goahead.js";
import { tierAt, hoursBeforeStart, refundFor } from "../shared/cancellation-tiers.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
const num = (v) => (v == null ? null : Number(v));
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
const dateLabel = (d) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${ymd(d)}T12:00:00Z`));
const bookingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const mapPayRequest = (r) => ({
  id: Number(r.id), pledgeId: r.pledge_id, departureId: Number(r.departure_id), provider: r.provider, payer: r.payer,
  amountEur: num(r.amount_eur), reference: r.reference, state: r.state, linkUrl: r.link_url || null,
  linkSentAt: iso(r.link_sent_at), emailedTo: r.emailed_to || null, dueAt: iso(r.due_at), dueBoundBy: r.due_bound_by || null,
  originalDueAt: iso(r.original_due_at), extendedAt: iso(r.extended_at), extendedBy: r.extended_by || null, extendReason: r.extend_reason || null,
  reminderSentAt: iso(r.reminder_sent_at), releaseWarnedAt: iso(r.release_warned_at), paidAt: iso(r.paid_at),
  providerReference: r.provider_reference || null, recordedBy: r.recorded_by || null, releasedAt: iso(r.released_at),
  cancelledAt: iso(r.cancelled_at), createdAt: iso(r.created_at),
  // Migration 052: the escalation of a link never made.
  linkAlert6hAt: iso(r.link_alert_6h_at), linkAlert12hAt: iso(r.link_alert_12h_at),
  decisionNeeded: r.decision_needed || null, decisionNeededAt: iso(r.decision_needed_at),
  decision: r.decision || null, decisionReason: r.decision_reason || null, decidedBy: r.decided_by || null, decidedAt: iso(r.decided_at),
});

export const mapRefund = (r) => ({
  id: Number(r.id), requestId: Number(r.request_id), pledgeId: r.pledge_id, kind: r.kind, paidEur: num(r.paid_eur),
  retainedPct: num(r.retained_pct), feeRetainedEur: num(r.fee_retained_eur), amountEur: num(r.amount_eur),
  tierVersionId: num(r.tier_version_id), hoursBefore: num(r.hours_before), state: r.state,
  providerReference: r.provider_reference || null, createdAt: iso(r.created_at), doneAt: iso(r.done_at), doneBy: r.done_by || null,
});

// ---------------------------------------------------------------- settings
export async function payAtGoAheadSettings(db = pool) {
  const r = (await db.query("SELECT value FROM finance_settings WHERE key = 'pay_at_goahead'")).rows[0];
  return { windowHours: Number(r?.value?.windowHours) || DEFAULT_WINDOW_HOURS, offerHours: Number(r?.value?.offerHours) || DEFAULT_OFFER_HOURS };
}

export async function setPayAtGoAheadSettings(db, { windowHours, offerHours, by }) {
  const w = Number(windowHours);
  const o = Number(offerHours);
  if (!WINDOW_HOURS_CHOICES.includes(w)) throw new CatalogueError(422, `The payment window is ${WINDOW_HOURS_CHOICES.join(" or ")} hours.`);
  if (!Number.isInteger(o) || o < 1 || o > 72) throw new CatalogueError(422, "A waitlist offer is held for 1 to 72 hours.");
  const value = { windowHours: w, offerHours: o };
  await db.query(
    `INSERT INTO finance_settings (key, value, updated_by) VALUES ('pay_at_goahead', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(value), by]);
  return value;
}

// ---------------------------------------------------------------- context
// A catalog departure with its product and instants. By catalog id, or by the
// legacy departure the bookings are on.
export async function departureFor(c, { id = null, legacyDepartureId = null }) {
  const r = (await c.query(
    `SELECT cd.*, cd.id AS dep_id, cd.status AS dep_status, c.*, c.id AS product_id_, c.status AS product_status,
            s.seats_sold, t.default_time, t.nights
       FROM catalogue_departures cd
       JOIN catalogue_products c ON c.id = cd.product_id
       JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
      WHERE ${id != null ? "cd.id = $1" : "cd.legacy_departure_id = $1"}`, [id != null ? id : legacyDepartureId])).rows[0];
  if (!r) return null;
  const product = mapCatalogueProduct({ ...r, id: r.product_id_, status: r.product_status });
  const date = ymd(r.date);
  const instants = departureInstants({ date }, product, { startTime: r.default_time, nights: r.nights });
  return {
    id: Number(r.dep_id), date, status: r.dep_status, legacyDepartureId: r.legacy_departure_id,
    seatsSold: Number(r.seats_sold) || 0, maxGroup: Number(product.maxGroup) || 12, product, ...instants,
  };
}

async function heldSeats(c, departureId, now) {
  const r = (await c.query(
    "SELECT COALESCE(SUM(seats), 0)::int AS n FROM departure_waitlist WHERE departure_id = $1 AND state = 'offered' AND offer_expires_at > $2",
    [departureId, new Date(now)])).rows[0];
  return Number(r.n) || 0;
}

// Seats still for general sale on a legacy departure that is a catalog
// departure: capacity less the seats sold and the seats held for waitlist
// offers. null when it isn't a catalog departure.
export async function seatsHeldForWaitlist(c, legacyDepartureId, now = Date.now()) {
  const dep = (await c.query("SELECT id FROM catalogue_departures WHERE legacy_departure_id = $1", [legacyDepartureId])).rows[0];
  return dep ? heldSeats(c, Number(dep.id), now) : 0;
}

async function ensureBookingCode(c, pledgeId) {
  const p = (await c.query("SELECT booking_code FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  if (p?.booking_code) return p.booking_code;
  for (let i = 0; i < 5; i++) {
    const code = [...randomBytes(8)].map((b) => bookingCodeAlphabet[b % bookingCodeAlphabet.length]).join("");
    const hit = await c.query("SELECT 1 FROM pledges WHERE UPPER(booking_code) = $1", [code]);
    if (hit.rowCount) continue;
    await c.query("UPDATE pledges SET booking_code = $2 WHERE id = $1", [pledgeId, code]);
    return code;
  }
  throw new CatalogueError(500, "Could not allocate a booking code.");
}

// Who is asked to pay, and how much: an agency-billed seat is paid by the
// agency (its invoice amount); every other booking by the traveler, for the
// full published price.
//
// Phase 5 (migration 061): a booking that kept a published EUR rate is
// charged the EUR price of the tier the departure is in NOW, at that rate, and
// an agency on billing pays that same full price (its pool share comes on the
// monthly statement). The booking and its invoice are updated to the amount
// asked for.
async function payerFor(c, pledge) {
  const { poolChargeFor } = await import("./pool-settlement.js");
  const charge = pledge.published_eur_rate != null ? await poolChargeFor(c, pledge) : null;
  if (charge) {
    await c.query("UPDATE pledges SET price_per_person = $2, booking_total = $3 WHERE id = $1", [pledge.id, charge.eachEur, charge.totalEur]);
    await c.query(
      "UPDATE agency_invoices SET gross_eur = $2, commission_eur = 0, amount_eur = $2 WHERE pledge_id = $1 AND state = 'due'", [pledge.id, charge.totalEur]);
    pledge = { ...pledge, booking_total: charge.totalEur };
  }
  const invoice = (await c.query("SELECT * FROM agency_invoices WHERE pledge_id = $1 AND state <> 'void'", [pledge.id])).rows[0];
  if (invoice) {
    const owner = (await c.query(
      "SELECT email FROM app_users WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' ORDER BY created_at LIMIT 1",
      [pledge.agency_id])).rows[0];
    return { payer: "agency", amount: Number(invoice.amount_eur), to: owner?.email || null, name: null, invoiceId: Number(invoice.id), tier: charge?.tier ?? null };
  }
  let to = pledge.customer_email || null;
  if (!to && pledge.agency_id && pledge.agency_id !== "direct_customer") {
    to = (await c.query(
      "SELECT email FROM app_users WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' ORDER BY created_at LIMIT 1",
      [pledge.agency_id])).rows[0]?.email || null;
  }
  return { payer: "traveller", amount: Number(pledge.booking_total) || 0, to, name: pledge.customers || null, invoiceId: null, tier: charge?.tier ?? null };
}

// Phase 5 (061): a booking that leaves before paying earns its agency no
// pool share; decided now, as its invoice is voided now. A paid booking that
// cancels waits for the departure's calculation (a late cancellation where a
// fee is kept earns half).
async function voidPoolRow(c, pledgeId, reason) {
  const has = (await c.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_commissions' AND column_name = 'basis'")).rowCount > 0;
  if (!has) return;
  await c.query(
    `UPDATE agency_commissions SET state = 'void', earned_egp = 0, share_factor = 0, state_reason = $2, decided_at = now()
      WHERE pledge_id = $1 AND basis = 'pool' AND state = 'pending'`, [pledgeId, reason]);
}

// ---------------------------------------------------------------- the seller
// The operator assigned at GoAhead sells the departure; Sawa's operating
// company (BRAND.legalName) is its commercial and payment-collection agent
// (decided 27 Sep 2026). The seller is named only once the operator has
// ACKNOWLEDGED the assignment; an offer not yet acknowledged names nobody, and
// the documents say "a licensed Sawa partner". The licence shown is the one
// entered for travelers (migration 053), else the tourism licence on the record.
export async function sellerOf(c, departureId) {
  const r = (await c.query(
    `SELECT o.* FROM catalogue_assignments a JOIN operators o ON o.id = a.operator_id
      WHERE a.departure_id = $1 AND a.state = 'acknowledged' ORDER BY a.id DESC LIMIT 1`, [departureId])).rows[0];
  if (!r) return null;
  return { operatorId: Number(r.id), legalName: r.legal_name, licenceNo: r.traveller_licence_no || r.tourism_license_no || null };
}

export const collectingAgent = () => ({
  name: BRAND.legalName, registrationNo: BRAND.registrationNumber, license: BRAND.agentLicense,
  payee: payeeLine(BRAND.legalName, BRAND.agentLicense),
});

// The two lines every traveler document carries.
export function sellerAndPayee(seller) {
  return { seller: sellerLine(seller), payee: collectingAgent().payee };
}

// ---------------------------------------------------------------- requests
// One request for a booking on a departure that is going ahead AND whose
// operator has acknowledged the assignment (decided 27 Sep 2026): no request,
// and no seller named, before that. Idempotent: a booking with a live request
// (awaiting a link, sent or paid) gets none. The payment deadline (48 hours,
// capped at the cut-off) runs from when the request reaches the payer.
export async function requestPayment(c, { pledgeId, departure, now = Date.now(), send = null, env = process.env }) {
  const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1 FOR UPDATE", [pledgeId])).rows[0];
  if (!pledge || pledge.status === "cancelled" || pledge.payment_mode !== "pay_at_goahead") return null;
  const live = (await c.query("SELECT id FROM payment_requests WHERE pledge_id = $1 AND state IN ('awaiting_link', 'sent', 'paid', 'unsecured')", [pledgeId])).rows[0];
  if (live) return null;
  if (!(now < departure.cutoffAt)) return null;
  if (!(await sellerOf(c, departure.id))) return null;
  const who = await payerFor(c, pledge);
  if (!(who.amount > 0)) return null;
  const reference = await ensureBookingCode(c, pledgeId);
  const provider = activeProvider(env);
  const ins = (await c.query(
    `INSERT INTO payment_requests (pledge_id, departure_id, provider, payer, amount_eur, reference)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [pledgeId, departure.id, provider.name, who.payer, who.amount, reference])).rows[0];
  const request = mapPayRequest(ins);
  const { windowHours } = await payAtGoAheadSettings(c);
  const deadline = payDeadline({ sentAtMs: now, windowHours, cutoffAtMs: departure.cutoffAt });
  const made = await provider.createPaymentRequest(c, {
    request, booking: { id: pledgeId, bookingCode: reference }, amountEur: who.amount, deadlineAt: deadline.dueAt,
  });
  if (made?.linkUrl) return sendLink(c, { requestId: request.id, linkUrl: made.linkUrl, by: provider.name, now, send });
  return request;
}

// The link is out: stamp the deadline (from now, capped at the cut-off),
// email the payer, and date an agency invoice to the deadline.
async function sendLink(c, { requestId, linkUrl, by, now, send, decided = null }) {
  const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
  if (!r) throw new CatalogueError(404, "Payment request not found.");
  if (r.state !== "awaiting_link") throw new CatalogueError(409, "This request already has its link.");
  const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1", [r.pledge_id])).rows[0];
  if (pledge.status === "cancelled") throw new CatalogueError(409, "This booking was canceled.");
  const departure = await departureFor(c, { id: Number(r.departure_id) });
  if (!(now < departure.cutoffAt)) throw new CatalogueError(409, "The cut-off has passed: the manifest is frozen.");
  // The request names its seller: none goes out while a (replacement)
  // operator has yet to acknowledge.
  if (!(await sellerOf(c, departure.id))) {
    throw new CatalogueError(409, "The operator hasn't acknowledged this departure yet. The payment request goes out once they do.");
  }
  const { windowHours } = await payAtGoAheadSettings(c);
  // An admin decision sets its own short deadline; otherwise the window,
  // capped at the cut-off.
  const deadline = decided
    ? { dueAt: decided.dueAtMs, boundBy: "decision", shortWindow: true }
    : payDeadline({ sentAtMs: now, windowHours, cutoffAtMs: departure.cutoffAt });
  // Migration 052: a link made so late that the traveler would have under 12
  // hours starts no deadline. The link is kept, and the seat goes to an admin
  // decision; nothing is emailed yet.
  if (!decided && tooLateToStart(deadline.dueAt, now)) {
    const held = (await c.query(
      `UPDATE payment_requests SET link_url = $2, decision_needed = 'late_link', decision_needed_at = $3 WHERE id = $1 RETURNING *`,
      [requestId, linkUrl, new Date(now)])).rows[0];
    await c.query(
      "UPDATE payment_tasks SET state = 'done', done_at = now(), done_by = $2 WHERE kind = 'create_link' AND request_id = $1 AND state = 'open'",
      [requestId, by]);
    await alertDecisionNeeded(c, { request: held, departure, why: "late_link", send });
    return { ...mapPayRequest(held), heldForDecision: true };
  }
  const who = await payerFor(c, pledge);
  const upd = (await c.query(
    `UPDATE payment_requests SET state = 'sent', link_url = $2, link_sent_at = $3, due_at = $4, original_due_at = $4,
            due_bound_by = $5, emailed_to = $6
      WHERE id = $1 RETURNING *`,
    [requestId, linkUrl, new Date(now), new Date(deadline.dueAt), deadline.boundBy, who.to])).rows[0];
  await c.query(
    "UPDATE payment_tasks SET state = 'done', done_at = now(), done_by = $2 WHERE kind = 'create_link' AND request_id = $1 AND state = 'open'",
    [requestId, by]);
  if (who.invoiceId) {
    await c.query("UPDATE agency_invoices SET due_on = $2 WHERE id = $1 AND state = 'due'", [who.invoiceId, todayIn(deadline.dueAt)]);
  }
  const request = mapPayRequest(upd);
  if (send && who.to) {
    const { payAtGoAheadLinkEmail } = await import("./email.js");
    const parties = sellerAndPayee(await sellerOf(c, departure.id));
    const agencyTraveller = who.payer === "traveller" && pledge.terms_fixed_by === "agency" && !pledge.traveller_terms_accepted_at;
    await send(payAtGoAheadLinkEmail({
      to: who.to, name: who.name, title: departure.product.title, dateLabel: dateLabel(departure.date), amount: request.amountEur,
      dueAt: request.dueAt, url: linkUrl, bookingCode: request.reference, agencyBilled: who.payer === "agency",
      termsLink: agencyTraveller ? `${site()}/booking/${encodeURIComponent(request.reference)}` : null,
      ...parties,
    })).catch(() => ({ ok: false }));
  }
  return { ...request, shortWindow: deadline.shortWindow };
}

// ---------------------------------------------------------------- unlinked seats
async function escalationRecipients(c) {
  const { opsRecipient } = await import("./email.js");
  const admins = (await c.query("SELECT email FROM app_users WHERE role = 'super_admin' AND status = 'active' ORDER BY created_at")).rows.map((r) => r.email);
  return [...new Set([opsRecipient(), ...admins].filter(Boolean).map((e) => String(e).toLowerCase()))];
}

async function alertDecisionNeeded(c, { request, departure, why, send }) {
  if (!send) return;
  const { payAtGoAheadEscalationEmail } = await import("./email.js");
  for (const to of await escalationRecipients(c)) {
    await send(payAtGoAheadEscalationEmail({
      to, level: why, portalUrl: `${site()}/portal`,
      items: [{ reference: request.reference, title: departure.product.title, date: departure.date, amount: Number(request.amount_eur), cutoffAt: new Date(departure.cutoffAt).toISOString() }],
    })).catch(() => ({ ok: false }));
  }
}

// An admin's decision on a seat whose link was never made, or made too late
// (added 27 Sep 2026). A reason is required, and the decision is kept.
//   short_link        the link now, with a short deadline (after now, not after
//                     the cut-off); the release follows it as usual
//   travel_unsecured  the traveler travels; payment is collected later. The
//                     seat is never released and is marked unsecured.
//   cancel            the booking is canceled; nothing was charged, so nothing
//                     is refunded; the traveler gets an apology
export async function decideUnlinkedSeat(db, { requestId, decision, reason, linkUrl = null, dueAt = null, by, now = Date.now(), send = null, env = process.env }) {
  if (!UNLINKED_DECISIONS.includes(decision)) throw new CatalogueError(422, "Choose: send the link now, let the traveler travel unsecured, or cancel.");
  if (!String(reason || "").trim()) throw new CatalogueError(422, "Give the reason for the decision.");
  return inTx(db, async (c) => {
    const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
    if (!r) throw new CatalogueError(404, "Payment request not found.");
    if (r.state !== "awaiting_link") throw new CatalogueError(409, "This seat's payment request isn't waiting for a link.");
    const departure = await departureFor(c, { id: Number(r.departure_id) });
    const record = (state = null) => c.query(
      `UPDATE payment_requests SET decision = $2, decision_reason = $3, decided_by = $4, decided_at = $5,
              decision_needed = COALESCE(decision_needed, 'no_link'), decision_needed_at = COALESCE(decision_needed_at, $5)
              ${state ? ", state = $6" : ""}
        WHERE id = $1`, [requestId, decision, String(reason).trim().slice(0, 500), by, new Date(now), ...(state ? [state] : [])]);
    if (decision === "short_link") {
      const url = cleanLinkUrl(linkUrl || r.link_url);
      if (!url) throw new CatalogueError(422, "Paste the full https:// payment link.");
      const due = Date.parse(dueAt);
      const err = shortDeadlineError({ dueAtMs: due, cutoffAtMs: departure.cutoffAt, now });
      if (err) throw new CatalogueError(422, err);
      await record();
      return sendLink(c, { requestId, linkUrl: url, by, now, send, decided: { dueAtMs: due } });
    }
    if (decision === "travel_unsecured") {
      await record("unsecured");
      await c.query(
        "UPDATE payment_tasks SET state = 'done', done_at = now(), done_by = $2 WHERE kind = 'create_link' AND request_id = $1 AND state = 'open'",
        [requestId, by]);
      return mapPayRequest((await c.query("SELECT * FROM payment_requests WHERE id = $1", [requestId])).rows[0]);
    }
    // cancel
    await record();
    const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1", [r.pledge_id])).rows[0];
    await cancelPayAtGoAheadBooking(c, { pledgeId: r.pledge_id, reason: "admin", by, now, send, env });
    if (send) {
      const who = await payerFor(c, pledge);
      if (who.to) {
        const { payAtGoAheadApologyEmail } = await import("./email.js");
        await send(payAtGoAheadApologyEmail({
          to: who.to, name: who.payer === "traveller" ? pledge.customers : null, title: departure.product.title,
          dateLabel: dateLabel(departure.date), bookingCode: r.reference,
        })).catch(() => ({ ok: false }));
      }
    }
    return mapPayRequest((await c.query("SELECT * FROM payment_requests WHERE id = $1", [requestId])).rows[0]);
  });
}

// For the admin home and Finance: seats booked, going ahead, not paid and
// with no link; those needing a decision; those traveling unsecured.
export async function unlinkedSummary(db = pool) {
  const r = (await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE r.state = 'awaiting_link' AND r.link_url IS NULL)::int AS unlinked_bookings,
       COALESCE(SUM(p.seats) FILTER (WHERE r.state = 'awaiting_link' AND r.link_url IS NULL), 0)::int AS unlinked_seats,
       COALESCE(SUM(p.seats) FILTER (WHERE r.state = 'awaiting_link' AND r.decision_needed IS NOT NULL AND r.decision IS NULL), 0)::int AS needs_decision,
       COALESCE(SUM(p.seats) FILTER (WHERE r.state = 'unsecured'), 0)::int AS unsecured
       FROM payment_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE p.status <> 'cancelled'`)).rows[0];
  return { unlinkedBookings: r.unlinked_bookings, unlinkedSeats: r.unlinked_seats, needsDecision: r.needs_decision, unsecured: r.unsecured };
}

// Ops paste the provider's link (a manual provider).
export async function attachLink(db, { requestId, linkUrl, by, now = Date.now(), send = null }) {
  const url = cleanLinkUrl(linkUrl);
  if (!url) throw new CatalogueError(422, "Paste the full https:// payment link.");
  return inTx(db, (c) => sendLink(c, { requestId, linkUrl: url, by, now, send }));
}

// The payment arrived: ops mark it paid with the provider's reference (a
// webhook later). A released seat can't be marked paid; reinstate it first.
export async function markRequestPaid(db, { requestId, providerReference, by, now = Date.now(), send = null }) {
  return inTx(db, async (c) => {
    const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
    if (!r) throw new CatalogueError(404, "Payment request not found.");
    if (r.state === "paid") return mapPayRequest(r);
    if (r.state === "released") {
      throw new CatalogueError(409, "This seat was released for non-payment. Reinstate the booking in Admin → Bookings first (it checks there is still a seat), then record the payment.");
    }
    if (r.state === "cancelled") throw new CatalogueError(409, "This booking was canceled.");
    let recorded;
    try {
      recorded = await providerFor(r.provider).recordPayment(c, { request: mapPayRequest(r), providerReference, by });
    } catch (e) {
      if (e.status) throw new CatalogueError(e.status, e.message);
      throw e;
    }
    const upd = (await c.query(
      `UPDATE payment_requests SET state = 'paid', paid_at = $2, provider_reference = $3, recorded_by = $4 WHERE id = $1 RETURNING *`,
      [requestId, new Date(now), recorded.providerReference, by])).rows[0];
    if (r.payer === "agency") {
      await c.query("UPDATE agency_invoices SET state = 'paid', paid_at = $2 WHERE pledge_id = $1 AND state = 'due'", [r.pledge_id, new Date(now)]);
    }
    const receipt = await issueReceipt(c, { request: upd, now, send });
    return { ...mapPayRequest(upd), receipt };
  });
}

// The receipt: issued by the collecting agent on behalf of the seller, with
// the seller as it stood when the payment was recorded (migration 053). The
// number is the year and the request id; a receipt reissued after a change of
// seller adds "-2", "-3". Every receipt is kept in payment_receipts.
const hasTable = async (c, name) => (await c.query("SELECT to_regclass($1) AS t", [`public.${name}`])).rows[0].t != null;

function receiptParties(seller) {
  const agent = collectingAgent();
  return {
    issuer: `${agent.name} (Commercial Registration ${agent.registrationNo}, ${agent.license}), collecting agent`,
    onBehalfOf: seller ? `${seller.legalName}${seller.licenceNo ? `, license no. ${seller.licenceNo}` : ""}` : SELLER_PENDING.replace(/^Operated by /, "").replace(/^a /, "the ") + " operating this departure",
    payee: agent.payee,
  };
}

async function recordReceipt(c, { request, seller, receiptNo, now, first }) {
  const upd = await c.query(
    `UPDATE payment_requests SET seller_operator_id = $2, seller_legal_name = $3, seller_licence_no = $4, receipt_no = $5, receipt_issued_at = $6
      WHERE id = $1 ${first ? "AND receipt_no IS NULL" : ""}`,
    [request.id, seller?.operatorId ?? null, seller?.legalName ?? null, seller?.licenceNo ?? null, receiptNo, new Date(now)]);
  if (!upd.rowCount || !(await hasTable(c, "payment_receipts"))) return null;
  return (await c.query(
    `INSERT INTO payment_receipts (request_id, receipt_no, seller_operator_id, seller_legal_name, seller_licence_no, amount_eur, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [request.id, receiptNo, seller?.operatorId ?? null, seller?.legalName ?? null, seller?.licenceNo ?? null, Number(request.amount_eur), new Date(now)])).rows[0];
}

async function issueReceipt(c, { request, now, send }) {
  const hasColumns = (await c.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_requests' AND column_name = 'receipt_no'")).rowCount > 0;
  const seller = await sellerOf(c, Number(request.departure_id));
  const receiptNo = `R-${new Date(now).getUTCFullYear()}-${String(request.id).padStart(6, "0")}`;
  if (hasColumns) await recordReceipt(c, { request, seller, receiptNo, now, first: true });
  const out = {
    receiptNo, issuedAt: new Date(now).toISOString(), amountEur: Number(request.amount_eur), reference: request.reference,
    ...receiptParties(seller), seller,
  };
  if (send && request.emailed_to) {
    const pledge = (await c.query("SELECT customers FROM pledges WHERE id = $1", [request.pledge_id])).rows[0];
    const departure = await departureFor(c, { id: Number(request.departure_id) });
    const { payAtGoAheadReceiptEmail } = await import("./email.js");
    await send(payAtGoAheadReceiptEmail({
      to: request.emailed_to, name: request.payer === "traveller" ? pledge?.customers : null, title: departure.product.title,
      dateLabel: dateLabel(departure.date), amount: out.amountEur, bookingCode: request.reference, receiptNo,
      paidAt: out.issuedAt, issuer: out.issuer, onBehalfOf: out.onBehalfOf,
    })).catch(() => ({ ok: false }));
  }
  return out;
}

// ---------------------------------------------------------------- acknowledgement
// The operator acknowledged the assignment (called by acknowledge(), in its
// transaction). The seller is named from now on, so:
//   1. travelers who paid under a previous seller (it failed, and Sawa
//      reassigned) are told, get a reissued receipt naming the new seller
//      (the original kept, marked superseded), and may cancel with a full
//      refund within 48 hours (never past the start);
//   2. every booking without a request gets one.
export const SELLER_CHANGE_OFFER_HOURS = 48;

export async function onOperatorAcknowledged(c, { departureId, by, now = Date.now(), send = null, env = process.env }) {
  if (!(await hasTable(c, "payment_requests"))) return { requested: 0, sellerChanges: [] };
  const departure = await departureFor(c, { id: departureId });
  const seller = await sellerOf(c, departureId);
  if (!departure || !seller) return { requested: 0, sellerChanges: [] };
  const sellerChanges = await reissueForSellerChange(c, { departure, seller, by, now, send });
  let requested = 0;
  if (departure.status === "go_ahead") {
    const pledges = (await c.query(
      `SELECT id FROM pledges WHERE departure_id = $1 AND payment_mode = 'pay_at_goahead' AND status <> 'cancelled' ORDER BY created_at, id`,
      [departure.legacyDepartureId])).rows;
    for (const p of pledges) if (await requestPayment(c, { pledgeId: p.id, departure, now, send, env })) requested += 1;
  }
  return { requested, sellerChanges };
}

async function reissueForSellerChange(c, { departure, seller, by, now, send }) {
  if (!(await hasTable(c, "seller_change_offers"))) return [];
  const paid = (await c.query(
    `SELECT r.* FROM payment_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE r.departure_id = $1 AND r.state = 'paid' AND p.status <> 'cancelled'
        AND r.receipt_no IS NOT NULL AND r.seller_operator_id IS NOT NULL AND r.seller_operator_id <> $2
      ORDER BY r.id FOR UPDATE OF r`, [departure.id, seller.operatorId])).rows;
  const out = [];
  for (const r of paid) {
    // The receipt being replaced; one issued before the history existed is
    // recorded first, from the request's snapshot.
    let previous = (await c.query(
      "SELECT * FROM payment_receipts WHERE request_id = $1 AND superseded_at IS NULL FOR UPDATE", [r.id])).rows[0];
    if (!previous) {
      previous = (await c.query(
        `INSERT INTO payment_receipts (request_id, receipt_no, seller_operator_id, seller_legal_name, seller_licence_no, amount_eur, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now())) RETURNING *`,
        [r.id, r.receipt_no, r.seller_operator_id, r.seller_legal_name, r.seller_licence_no, Number(r.amount_eur), r.receipt_issued_at])).rows[0];
    }
    const issued = Number((await c.query("SELECT COUNT(*)::int AS n FROM payment_receipts WHERE request_id = $1", [r.id])).rows[0].n);
    const base = /^(R-\d{4}-\d+?)(?:-\d+)?$/.exec(String(r.receipt_no))?.[1] || String(r.receipt_no);
    const receiptNo = `${base}-${issued + 1}`;
    // The old receipt is superseded, the new one issued, and the old one
    // points at it.
    await c.query(
      "UPDATE payment_receipts SET superseded_at = $2, supersede_reason = $3 WHERE id = $1",
      [previous.id, new Date(now), `Seller changed to ${seller.legalName} (operator ${seller.operatorId}).`]);
    const current = await recordReceipt(c, { request: r, seller, receiptNo, now, first: false });
    await c.query("UPDATE payment_receipts SET superseded_by = $2 WHERE id = $1", [previous.id, current.id]);
    const expiresAt = Math.min(now + SELLER_CHANGE_OFFER_HOURS * 3600000, departure.startsAt);
    const offer = (await c.query(
      `INSERT INTO seller_change_offers (request_id, pledge_id, departure_id, from_operator_id, to_operator_id, receipt_id, offered_at, expires_at, emailed_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (request_id, to_operator_id) DO NOTHING RETURNING *`,
      [r.id, r.pledge_id, departure.id, r.seller_operator_id, seller.operatorId, current.id, new Date(now), new Date(expiresAt), r.emailed_to])).rows[0];
    const change = {
      requestId: Number(r.id), bookingCode: r.reference, from: { operatorId: Number(r.seller_operator_id), legalName: r.seller_legal_name },
      to: { operatorId: seller.operatorId, legalName: seller.legalName }, receiptNo, supersededReceiptNo: previous.receipt_no,
      offerId: offer ? Number(offer.id) : null, offerExpiresAt: new Date(expiresAt).toISOString(),
    };
    // Logged in the transaction, so the record can't be lost apart from the change.
    await c.query(
      `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail) VALUES ($1, $2, 'booking.seller_changed', 'booking', $3, $4)`,
      [by || "system", by ? "operator" : null, r.reference, JSON.stringify(change)]);
    if (send && r.emailed_to) {
      const pledge = (await c.query("SELECT customers FROM pledges WHERE id = $1", [r.pledge_id])).rows[0];
      const parties = receiptParties(seller);
      const { payAtGoAheadSellerChangedEmail } = await import("./email.js");
      await send(payAtGoAheadSellerChangedEmail({
        to: r.emailed_to, name: r.payer === "traveller" ? pledge?.customers : null, title: departure.product.title,
        dateLabel: dateLabel(departure.date), bookingCode: r.reference, amount: Number(r.amount_eur),
        previousSeller: r.seller_legal_name, seller: seller.legalName, receiptNo, supersededReceiptNo: previous.receipt_no,
        issuedAt: new Date(now).toISOString(), issuer: parties.issuer, onBehalfOf: parties.onBehalfOf,
        cancelBy: new Date(expiresAt).toISOString(), url: `${site()}/booking/${encodeURIComponent(r.reference)}`,
      })).catch(() => ({ ok: false }));
    }
    out.push(change);
  }
  return out;
}

// The traveler takes the offer: the booking is canceled and everything paid
// is refunded (no tier fee). Only while the offer is open.
export async function acceptSellerChangeOffer(db, { code, by = "traveler", now = Date.now(), send = null, env = process.env }) {
  return inTx(db, async (c) => {
    const pledge = (await c.query("SELECT * FROM pledges WHERE UPPER(booking_code) = UPPER($1)", [String(code || "").trim()])).rows[0];
    if (!pledge) throw new CatalogueError(404, "Booking not found.");
    const offer = (await c.query(
      "SELECT * FROM seller_change_offers WHERE pledge_id = $1 AND state = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [pledge.id])).rows[0];
    if (!offer) throw new CatalogueError(409, "There's no open offer to cancel this booking with a full refund.");
    if (new Date(offer.expires_at).getTime() <= now) {
      await c.query("UPDATE seller_change_offers SET state = 'expired' WHERE id = $1", [offer.id]);
      throw new CatalogueError(409, "The time to cancel with a full refund has passed.");
    }
    const result = await cancelBooking(c, { pledgeId: pledge.id, reason: "operator", fullRefund: true, by, now, send, env });
    await c.query(
      "UPDATE seller_change_offers SET state = 'accepted', accepted_at = $2, refund_id = $3 WHERE id = $1",
      [offer.id, new Date(now), result.refundRecord?.id ?? null]);
    return { ...result, offerId: Number(offer.id) };
  });
}

async function expireSellerChangeOffers(db, { now }) {
  if (!(await hasTable(db, "seller_change_offers"))) return 0;
  return (await db.query("UPDATE seller_change_offers SET state = 'expired' WHERE state = 'open' AND expires_at <= $1", [new Date(now)])).rowCount;
}

// A later deadline for one traveler, with a reason. The first deadline is
// kept (original_due_at); the reminder isn't re-sent, the release warning is
// re-armed for the new deadline.
export async function extendDeadline(db, { requestId, dueAt, reason, by, now = Date.now() }) {
  return inTx(db, async (c) => {
    const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
    if (!r) throw new CatalogueError(404, "Payment request not found.");
    if (r.state !== "sent") throw new CatalogueError(409, "Only a request waiting for payment can be extended.");
    const departure = await departureFor(c, { id: Number(r.departure_id) });
    const next = Date.parse(dueAt);
    const err = extensionError({ currentDueAtMs: new Date(r.due_at).getTime(), newDueAtMs: next, cutoffAtMs: departure.cutoffAt, reason, now });
    if (err) throw new CatalogueError(422, err);
    const upd = (await c.query(
      `UPDATE payment_requests SET due_at = $2, extended_at = $3, extended_by = $4, extend_reason = $5, release_warned_at = NULL
        WHERE id = $1 RETURNING *`,
      [requestId, new Date(next), new Date(now), by, String(reason).trim().slice(0, 500)])).rows[0];
    if (r.payer === "agency") {
      await c.query("UPDATE agency_invoices SET due_on = $2 WHERE pledge_id = $1 AND state = 'due'", [r.pledge_id, todayIn(next)]);
    }
    return mapPayRequest(upd);
  });
}

// ---------------------------------------------------------------- release
// Unpaid at the deadline: released, exactly like a cancellation before the
// cut-off (clause 10.1). Re-checked under lock, so a payment recorded after
// the warning and before the deadline stops it.
async function releaseSeat(c, { requestId, now, send }) {
  const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
  if (!r || !releaseDue(mapPayRequest(r), now)) return null;
  const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1 FOR UPDATE", [r.pledge_id])).rows[0];
  await c.query("UPDATE payment_requests SET state = 'released', released_at = $2 WHERE id = $1", [requestId, new Date(now)]);
  if (pledge.status !== "cancelled") {
    await c.query(
      "UPDATE pledges SET status = 'cancelled', cancelled_reason = 'unpaid', cancelled_at = $2 WHERE id = $1",
      [pledge.id, new Date(now)]);
    await refreshStatus(c, pledge.departure_id);
  }
  await c.query(
    "UPDATE agency_invoices SET state = 'void', void_reason = 'Released: not paid by the deadline.' WHERE pledge_id = $1 AND state = 'due'",
    [pledge.id]);
  await voidPoolRow(c, pledge.id, "Released: not paid by the deadline.");
  const departure = await departureFor(c, { id: Number(r.departure_id) });
  if (send && r.emailed_to) {
    const { payAtGoAheadReleasedEmail } = await import("./email.js");
    await send(payAtGoAheadReleasedEmail({
      to: r.emailed_to, name: r.payer === "traveller" ? pledge.customers : null, title: departure.product.title,
      dateLabel: dateLabel(departure.date), bookingCode: r.reference,
    })).catch(() => ({ ok: false }));
  }
  await offerFreedSeats(c, { departure, sourcePledgeId: pledge.id, now, send });
  return pledge.id;
}

// ---------------------------------------------------------------- cancellation
// What a paid booking's cancellation keeps and refunds, under the tier
// version it was made under.
export async function cancellationQuote(c, { pledgeId, now = Date.now() }) {
  const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  if (!pledge) throw new CatalogueError(404, "Booking not found.");
  if (pledge.payment_mode !== "pay_at_goahead") throw new CatalogueError(409, "This booking is on the deposit-and-balance flow; use Admin → Payments.");
  const departure = await departureFor(c, { legacyDepartureId: pledge.departure_id });
  const version = await tierVersionById(c, pledge.cancellation_tier_version_id);
  const at = pledge.status === "cancelled" && pledge.cancelled_at ? new Date(pledge.cancelled_at).getTime() : now;
  const hours = hoursBeforeStart(departure.startsAt, at);
  const tier = tierAt(version?.rows || [], departure.product.type, hours);
  const paidReq = (await c.query("SELECT * FROM payment_requests WHERE pledge_id = $1 AND state = 'paid'", [pledgeId])).rows[0];
  const paid = paidReq ? Number(paidReq.amount_eur) : 0;
  const money = refundFor({ paidEur: paid, priceEur: Number(pledge.booking_total) || 0, retainedPct: tier?.retainedPct ?? 0 });
  return {
    pledgeId, tierVersion: version?.version ?? null, tierVersionId: version?.id ?? null, hoursBefore: Math.floor(hours),
    retainedPct: tier?.retainedPct ?? 0, priceEur: Number(pledge.booking_total) || 0, ...money,
    request: paidReq ? mapPayRequest(paidReq) : null, departure,
  };
}

async function refundPaid(c, { quote, by, env = process.env }) {
  const req = quote.request;
  if (!req) return null;
  const ins = (await c.query(
    `INSERT INTO payment_refunds (request_id, pledge_id, kind, paid_eur, retained_pct, fee_retained_eur, amount_eur, tier_version_id, hours_before, created_by)
     VALUES ($1, $2, 'cancellation', $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (request_id) WHERE state <> 'cancelled' AND kind = 'cancellation' DO NOTHING RETURNING *`,
    [req.id, quote.pledgeId, quote.paid, quote.retainedPct, quote.fee, quote.refund, quote.tierVersionId, quote.hoursBefore, by])).rows[0];
  if (!ins) return null;
  if (quote.refund > 0) {
    const r = await providerFor(req.provider).refund(c, { refund: mapRefund(ins), request: req, amountEur: quote.refund, env });
    if (r?.done) await c.query("UPDATE payment_refunds SET state = 'done', done_at = now(), done_by = $2, provider_reference = $3 WHERE id = $1", [ins.id, req.provider, r.providerReference]);
  } else {
    // Nothing to return: the whole payment is the fee. Recorded, and done.
    await c.query("UPDATE payment_refunds SET state = 'done', done_at = now(), done_by = $2, provider_reference = 'nothing to refund' WHERE id = $1", [ins.id, by]);
  }
  return mapRefund((await c.query("SELECT * FROM payment_refunds WHERE id = $1", [ins.id])).rows[0]);
}

// A pay-at-GoAhead booking canceled after GoAhead (by Sawa, for the traveler
// or itself). Before payment: the request is canceled, nothing is owed. After:
// the fee is kept under the booking's tier version and the rest refunded
// through the provider. The seat goes to the waitlist before the cut-off.
export async function cancelPayAtGoAheadBooking(db, { pledgeId, reason = "traveler", by, now = Date.now(), send = null, env = process.env }) {
  if (!["traveler", "admin"].includes(reason)) throw new CatalogueError(422, "The reason is the traveler's request, or Sawa's (admin).");
  return inTx(db, (c) => cancelBooking(c, { pledgeId, reason, by, now, send, env }));
}

// fullRefund: the seller changed after payment and the traveler took the
// offer (acceptSellerChangeOffer). The reason is recorded as "operator" (its
// failure), no tier fee is kept, and no agency commission is earned on it.
async function cancelBooking(c, { pledgeId, reason, fullRefund = false, by, now, send, env }) {
  const pledge = (await c.query("SELECT * FROM pledges WHERE id = $1 FOR UPDATE", [pledgeId])).rows[0];
  if (!pledge) throw new CatalogueError(404, "Booking not found.");
  if (pledge.payment_mode !== "pay_at_goahead") throw new CatalogueError(409, "This booking is on the deposit-and-balance flow.");
  if (pledge.status === "cancelled") throw new CatalogueError(409, "This booking is already canceled.");
  await c.query(
    "UPDATE pledges SET status = 'cancelled', cancelled_reason = $2, cancelled_at = $3 WHERE id = $1",
    [pledgeId, reason, new Date(now)]);
  await refreshStatus(c, pledge.departure_id);
  await c.query(
    `UPDATE payment_requests SET state = 'cancelled', cancelled_at = $2, cancel_reason = $3
      WHERE pledge_id = $1 AND state IN ('awaiting_link', 'sent', 'unsecured')`, [pledgeId, new Date(now), `Booking canceled (${reason}).`]);
  await c.query(
    `UPDATE payment_tasks t SET state = 'cancelled', done_at = now(), done_by = $2 FROM payment_requests r
      WHERE t.request_id = r.id AND r.pledge_id = $1 AND t.kind = 'create_link' AND t.state = 'open'`, [pledgeId, by]);
  const tiered = await cancellationQuote(c, { pledgeId, now });
  const quote = fullRefund ? { ...tiered, retainedPct: 0, fee: 0, refund: tiered.paid } : tiered;
  const refund = await refundPaid(c, { quote, by, env });
  if (!quote.request) {
    await c.query("UPDATE agency_invoices SET state = 'void', void_reason = 'Booking canceled before payment.' WHERE pledge_id = $1 AND state = 'due'", [pledgeId]);
    await voidPoolRow(c, pledgeId, "Canceled before payment.");
  }
  await offerFreedSeats(c, { departure: quote.departure, sourcePledgeId: pledgeId, now, send });
  const { departure, ...rest } = quote;
  return { ...rest, refundRecord: refund };
}

// Ops confirm a refund was made in the provider.
export async function completeRefund(db, { refundId, providerReference, by }) {
  const ref = String(providerReference || "").trim();
  if (!ref) throw new CatalogueError(422, "Quote the provider's refund reference.");
  return inTx(db, async (c) => {
    const r = (await c.query("SELECT * FROM payment_refunds WHERE id = $1 FOR UPDATE", [refundId])).rows[0];
    if (!r) throw new CatalogueError(404, "Refund not found.");
    if (r.state === "done") return mapRefund(r);
    if (r.state !== "pending") throw new CatalogueError(409, "This refund was canceled.");
    const upd = (await c.query(
      "UPDATE payment_refunds SET state = 'done', done_at = now(), done_by = $2, provider_reference = $3 WHERE id = $1 RETURNING *",
      [refundId, by, ref.slice(0, 200)])).rows[0];
    await c.query("UPDATE payment_tasks SET state = 'done', done_at = now(), done_by = $2 WHERE refund_id = $1 AND state = 'open'", [refundId, by]);
    return mapRefund(upd);
  });
}

// A booking canceled by any other path (an admin edit, the legacy routes)
// while its request was open or paid: close the request, and refund a paid
// one under its tiers, as of when it was canceled.
async function reconcileCancelled(db, { now, env }) {
  const rows = (await db.query(
    `SELECT r.id, r.pledge_id, r.state FROM payment_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE p.status = 'cancelled' AND (r.state IN ('awaiting_link', 'sent', 'unsecured')
         OR (r.state = 'paid' AND NOT EXISTS (SELECT 1 FROM payment_refunds f WHERE f.request_id = r.id AND f.state <> 'cancelled')))`)).rows;
  let n = 0;
  for (const row of rows) {
    await inTx(db, async (c) => {
      const r = (await c.query("SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE", [row.id])).rows[0];
      if (["awaiting_link", "sent", "unsecured"].includes(r.state)) {
        await c.query("UPDATE payment_requests SET state = 'cancelled', cancelled_at = $2, cancel_reason = 'Booking canceled.' WHERE id = $1", [r.id, new Date(now)]);
        await c.query("UPDATE payment_tasks SET state = 'cancelled', done_at = now(), done_by = 'system' WHERE kind = 'create_link' AND request_id = $1 AND state = 'open'", [r.id]);
      } else if (r.state === "paid") {
        const quote = await cancellationQuote(c, { pledgeId: r.pledge_id, now });
        await refundPaid(c, { quote, by: "system", env });
      }
      n += 1;
    });
  }
  return n;
}

// ---------------------------------------------------------------- waitlist
export const mapWaitlist = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), name: r.name, email: r.email, phone: r.phone || null,
  seats: Number(r.seats), state: r.state, offeredAt: iso(r.offered_at), offerExpiresAt: iso(r.offer_expires_at),
  sourcePledgeId: r.source_pledge_id || null, bookedPledgeId: r.booked_pledge_id || null, createdAt: iso(r.created_at),
});

// A traveler joins a full departure's waitlist.
export async function joinWaitlist(db, { legacyDepartureId, name, email, phone = null, seats, details = {}, now = Date.now() }) {
  return inTx(db, async (c) => {
    const departure = await departureFor(c, { legacyDepartureId });
    if (!departure) throw new CatalogueError(404, "Departure not found.");
    if (!["open", "go_ahead"].includes(departure.status)) throw new CatalogueError(409, "This departure isn't taking bookings.");
    if (!(now < departure.cutoffAt)) throw new CatalogueError(409, "Bookings for this date have closed.");
    const free = departure.maxGroup - departure.seatsSold - await heldSeats(c, departure.id, now);
    if (free >= Number(seats)) throw new CatalogueError(409, "There are seats available: book them directly.");
    const dup = (await c.query(
      "SELECT 1 FROM departure_waitlist WHERE departure_id = $1 AND lower(email) = lower($2) AND state IN ('waiting', 'offered')",
      [departure.id, email])).rows[0];
    if (dup) throw new CatalogueError(409, "You're already on the waitlist for this date.");
    const r = (await c.query(
      `INSERT INTO departure_waitlist (departure_id, name, email, phone, seats, details) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [departure.id, name, String(email).toLowerCase(), phone, seats, JSON.stringify(details || {})])).rows[0];
    const position = Number((await c.query(
      `SELECT COUNT(*)::int AS n FROM departure_waitlist w, departure_waitlist me
        WHERE me.id = $2 AND w.departure_id = $1 AND w.state IN ('waiting', 'offered') AND (w.created_at, w.id) <= (me.created_at, me.id)`,
      [departure.id, r.id])).rows[0].n);
    return { ...mapWaitlist(r), position };
  });
}

// Offer freed seats to the waitlist, first come first served, a party that
// fits. Before the cut-off only; each offer held (12 hours) up to the cut-off.
async function offerFreedSeats(c, { departure, sourcePledgeId = null, now, send }) {
  if (!departure || !(now < departure.cutoffAt) || !["open", "go_ahead"].includes(departure.status)) return 0;
  const sold = Number((await c.query(
    "SELECT COALESCE(SUM(seats), 0)::int AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [departure.legacyDepartureId])).rows[0].n);
  let free = departure.maxGroup - sold - await heldSeats(c, departure.id, now);
  const { offerHours } = await payAtGoAheadSettings(c);
  const entries = (await c.query(
    "SELECT * FROM departure_waitlist WHERE departure_id = $1 AND state = 'waiting' ORDER BY created_at, id FOR UPDATE", [departure.id])).rows.map(mapWaitlist);
  let offered = 0;
  while (free > 0) {
    const e = nextOffer(entries.filter((x) => x.state === "waiting"), free);
    if (!e) break;
    const token = randomBytes(24).toString("base64url");
    const expires = offerExpiresAt({ now, offerHours, cutoffAtMs: departure.cutoffAt });
    await c.query(
      `UPDATE departure_waitlist SET state = 'offered', offered_at = $2, offer_expires_at = $3, offer_token_hash = $4, source_pledge_id = COALESCE($5, source_pledge_id)
        WHERE id = $1`, [e.id, new Date(now), new Date(expires), hashToken(token), sourcePledgeId]);
    e.state = "offered";
    free -= e.seats;
    offered += 1;
    if (send) {
      const { waitlistOfferEmail } = await import("./email.js");
      await send(waitlistOfferEmail({
        to: e.email, name: e.name, title: departure.product.title, dateLabel: dateLabel(departure.date), seats: e.seats,
        expiresAt: new Date(expires).toISOString(), url: `${site()}/waitlist/${token}`,
      })).catch(() => ({ ok: false }));
    }
  }
  return offered;
}

// Offers not taken in time expire; their seats go to the next in line (and
// the seat's source travels with it, so a later resale still counts).
async function expireOffers(db, { now, send }) {
  const due = (await db.query(
    "SELECT id, departure_id FROM departure_waitlist WHERE state = 'offered' AND offer_expires_at <= $1", [new Date(now)])).rows;
  let expired = 0;
  for (const row of due) {
    await inTx(db, async (c) => {
      const upd = (await c.query(
        "UPDATE departure_waitlist SET state = 'expired' WHERE id = $1 AND state = 'offered' RETURNING source_pledge_id", [row.id])).rows[0];
      if (!upd) return;
      expired += 1;
      const departure = await departureFor(c, { id: Number(row.departure_id) });
      await offerFreedSeats(c, { departure, sourcePledgeId: upd.source_pledge_id, now, send });
    });
  }
  return expired;
}

async function offerByTokenRow(c, token, { forUpdate = false, now = Date.now() } = {}) {
  const r = (await c.query(`SELECT * FROM departure_waitlist WHERE offer_token_hash = $1 ${forUpdate ? "FOR UPDATE" : ""}`, [hashToken(token)])).rows[0];
  if (!r) throw new CatalogueError(404, "This offer link isn't valid.");
  if (r.state === "booked") throw new CatalogueError(409, "This offer has already been booked.");
  if (r.state !== "offered" || new Date(r.offer_expires_at).getTime() <= now) throw new CatalogueError(410, "This offer has expired. The seat went to the next traveler on the waitlist.");
  return r;
}

export async function waitlistOffer(db, { token, now = Date.now() }) {
  const r = await offerByTokenRow(db, token, { now });
  const departure = await departureFor(db, { id: Number(r.departure_id) });
  return {
    offer: { name: r.name, email: r.email, phone: r.phone, seats: Number(r.seats), details: r.details || {}, expiresAt: iso(r.offer_expires_at) },
    departure: { legacyDepartureId: departure.legacyDepartureId, title: departure.product.title, date: departure.date, dateLabel: dateLabel(departure.date) },
  };
}

// Lock the offer for booking. Returns what the booking route needs.
export async function claimWaitlistOffer(c, { token, now = Date.now() }) {
  const r = await offerByTokenRow(c, token, { forUpdate: true, now });
  const departure = await departureFor(c, { id: Number(r.departure_id) });
  return { entry: mapWaitlist(r), departure };
}

// The booking is made: the offer is booked, the new booking asked to pay at
// once (the departure is going ahead), and — if the seat came from a paid
// cancellation — the canceling traveler's fee is returned, since the seat was
// resold before the cut-off.
export async function completeWaitlistOffer(c, { entryId, pledgeId, departure, now = Date.now(), send = null, env = process.env }) {
  const e = (await c.query(
    "UPDATE departure_waitlist SET state = 'booked', booked_pledge_id = $2 WHERE id = $1 AND state = 'offered' RETURNING *", [entryId, pledgeId])).rows[0];
  if (!e) throw new CatalogueError(409, "This offer is no longer open.");
  let resale = null;
  if (e.source_pledge_id && now < departure.cutoffAt) resale = await returnFeeOnResale(c, { sourcePledgeId: e.source_pledge_id, seats: Number(e.seats), env });
  const request = departure.status === "go_ahead" ? await requestPayment(c, { pledgeId, departure, now, send, env }) : null;
  return { request, resale };
}

// The canceling traveler's fee, returned in proportion to the seats resold
// (all of it when the whole booking is resold), never more than was kept.
async function returnFeeOnResale(c, { sourcePledgeId, seats, env }) {
  const cancel = (await c.query(
    `SELECT f.*, p.seats AS canceled_seats FROM payment_refunds f JOIN pledges p ON p.id = f.pledge_id
      WHERE f.pledge_id = $1 AND f.kind = 'cancellation' AND f.state <> 'cancelled' AND f.fee_retained_eur > 0 FOR UPDATE OF f`,
    [sourcePledgeId])).rows[0];
  if (!cancel) return null;
  const returned = Number((await c.query(
    "SELECT COALESCE(SUM(amount_eur), 0) AS n FROM payment_refunds WHERE pledge_id = $1 AND kind = 'resale' AND state <> 'cancelled'",
    [sourcePledgeId])).rows[0].n);
  const fee = Number(cancel.fee_retained_eur);
  const share = Math.round(fee * Math.min(1, seats / Math.max(1, Number(cancel.canceled_seats))) * 100) / 100;
  const amount = Math.min(share, Math.round((fee - returned) * 100) / 100);
  if (!(amount > 0)) return null;
  const req = (await c.query("SELECT * FROM payment_requests WHERE id = $1", [cancel.request_id])).rows[0];
  const ins = (await c.query(
    `INSERT INTO payment_refunds (request_id, pledge_id, kind, paid_eur, retained_pct, fee_retained_eur, amount_eur, tier_version_id, hours_before, created_by)
     VALUES ($1, $2, 'resale', $3, 0, 0, $4, $5, $6, 'system') RETURNING *`,
    [cancel.request_id, sourcePledgeId, cancel.paid_eur, amount, cancel.tier_version_id, cancel.hours_before])).rows[0];
  const r = await providerFor(req.provider).refund(c, { refund: mapRefund(ins), request: mapPayRequest(req), amountEur: amount, env });
  if (r?.done) await c.query("UPDATE payment_refunds SET state = 'done', done_at = now(), done_by = $2, provider_reference = $3 WHERE id = $1", [ins.id, req.provider, r.providerReference]);
  return mapRefund(ins);
}

// ---------------------------------------------------------------- reads
// What a booking's payment stands at, for the manifest, admin and the
// traveler's booking page.
export async function requestsByPledge(db, pledgeIds) {
  const ids = [...new Set((pledgeIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const r = await db.query(
    "SELECT * FROM payment_requests WHERE pledge_id = ANY($1::text[]) ORDER BY created_at, id", [ids]);
  for (const row of r.rows) out.set(row.pledge_id, mapPayRequest(row));
  return out;
}

// Admin: per departure, the seats as paid, awaiting payment (with deadline),
// released, or short window; the open ops tasks; the refunds.
export async function payAtGoAheadOverview(db = pool, { now = Date.now() } = {}) {
  const deps = (await db.query(
    `SELECT DISTINCT cd.id FROM catalogue_departures cd JOIN pledges p ON p.departure_id = cd.legacy_departure_id
      WHERE p.payment_mode = 'pay_at_goahead' AND cd.status IN ('open', 'go_ahead') ORDER BY cd.id`)).rows;
  const departures = [];
  for (const { id } of deps) {
    const d = await departureFor(db, { id: Number(id) });
    const pledges = (await db.query(
      `SELECT id, booking_code, customers, seats, status, cancelled_reason, agency_id, booking_total FROM pledges
        WHERE departure_id = $1 AND payment_mode = 'pay_at_goahead' ORDER BY created_at, id`, [d.legacyDepartureId])).rows;
    const reqs = await requestsByPledge(db, pledges.map((p) => p.id));
    const seats = pledges.map((p) => {
      const r = reqs.get(p.id) || null;
      const shortWindow = r?.linkSentAt && r?.dueAt ? Date.parse(r.dueAt) - Date.parse(r.linkSentAt) < 24 * 3600000 : false;
      return {
        pledgeId: p.id, bookingCode: p.booking_code, name: p.customers, seats: Number(p.seats), status: p.status,
        cancelledReason: p.cancelled_reason, agency: p.agency_id !== "direct_customer" ? p.agency_id : null,
        amountEur: r?.amountEur ?? num(p.booking_total), request: r, shortWindow, ...paymentStanding(r),
      };
    });
    const count = (f) => seats.filter(f).reduce((s, x) => s + x.seats, 0);
    departures.push({
      id: d.id, date: d.date, title: d.product.title, code: d.product.code, status: d.status, cutoffAt: new Date(d.cutoffAt).toISOString(),
      counts: {
        paid: count((x) => x.request?.state === "paid" && x.status !== "cancelled"),
        awaiting: count((x) => ["sent", "awaiting_link"].includes(x.request?.state) && x.status !== "cancelled"),
        released: count((x) => x.request?.state === "released"),
        shortWindow: count((x) => x.shortWindow && x.request?.state === "sent"),
      },
      seats,
    });
  }
  const tasks = (await db.query(
    `SELECT t.*, COALESCE(r.reference, rr.reference) AS reference FROM payment_tasks t
       LEFT JOIN payment_requests r ON r.id = t.request_id
       LEFT JOIN payment_refunds f ON f.id = t.refund_id LEFT JOIN payment_requests rr ON rr.id = f.request_id
      WHERE t.state = 'open' ORDER BY t.created_at, t.id`)).rows.map((t) => ({
    id: Number(t.id), kind: t.kind, provider: t.provider, title: t.title, detail: t.detail, reference: t.reference,
    requestId: num(t.request_id), refundId: num(t.refund_id), createdAt: iso(t.created_at),
  }));
  const refunds = (await db.query("SELECT * FROM payment_refunds ORDER BY created_at DESC, id DESC LIMIT 200")).rows.map(mapRefund);
  return { departures, tasks, refunds, settings: await payAtGoAheadSettings(db), now: new Date(now).toISOString() };
}

// For the booking page (/booking/:code): the payment standing and the terms
// the booking was made under.
export async function bookingPayView(db, { pledgeId }) {
  const p = (await db.query("SELECT * FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  if (!p || p.payment_mode !== "pay_at_goahead") return null;
  const departure = await departureFor(db, { legacyDepartureId: p.departure_id });
  const r = (await requestsByPledge(db, [pledgeId])).get(pledgeId) || null;
  const terms = await bookingTerms(db, { versionId: p.cancellation_tier_version_id, productType: departure.product.type });
  const { termsVersionById } = await import("./terms-versions.js");
  const doc = p.terms_version_id ? await termsVersionById(db, p.terms_version_id) : null;
  // Seller disclosure: the assigned operator, or the pending line; the payee is
  // the collecting agent. A paid booking has its voucher.
  const seller = await sellerOf(db, departure.id);
  const parties = sellerAndPayee(seller);
  const paid = r?.state === "paid";
  const receipt = paid ? (await db.query("SELECT * FROM payment_requests WHERE id = $1", [r.id])).rows[0] : null;
  // Going ahead, but the operator hasn't acknowledged yet: no seller named and
  // no payment request yet (decided 27 Sep 2026).
  const awaitingOperator = departure.status === "go_ahead" && !seller && p.status !== "cancelled";
  // The seller changed after payment: the offer to cancel with a full refund.
  const offer = paid && await hasTable(db, "seller_change_offers") ? (await db.query(
    `SELECT s.*, o.legal_name AS from_name FROM seller_change_offers s LEFT JOIN operators o ON o.id = s.from_operator_id
      WHERE s.pledge_id = $1 ORDER BY s.id DESC LIMIT 1`, [pledgeId])).rows[0] : null;
  return {
    seller: seller ? { legalName: seller.legalName, licenceNo: seller.licenceNo } : null,
    sellerLine: parties.seller, payee: parties.payee, awaitingOperator,
    sellerChange: offer ? {
      from: offer.from_name || null, receiptNo: receipt?.receipt_no || null, expiresAt: iso(offer.expires_at),
      open: offer.state === "open" && new Date(offer.expires_at).getTime() > Date.now(), state: offer.state,
    } : null,
    voucher: paid ? {
      bookingCode: p.booking_code, title: departure.product.title, date: departure.date, seats: Number(p.seats),
      travellers: Array.isArray(p.traveller_names) ? p.traveller_names : [], pickupPoint: p.pickup_point || null,
      seller: parties.seller, payee: parties.payee, receiptNo: receipt?.receipt_no || null,
    } : null,
    mode: "pay_at_goahead",
    request: r && ["sent", "paid", "released"].includes(r.state)
      ? { state: r.state, amountEur: r.amountEur, dueAt: r.dueAt, linkUrl: r.state === "sent" ? r.linkUrl : null, payer: r.payer }
      : r ? { state: r.state, amountEur: r.amountEur, payer: r.payer } : null,
    terms: terms ? {
      ...terms, fixedBy: p.terms_fixed_by, fixedAt: iso(p.terms_fixed_at), travellerAcceptedAt: iso(p.traveller_terms_accepted_at),
      document: doc ? { version: doc.version, title: doc.title, url: doc.documentUrl } : null,
    } : null,
  };
}

// The traveler of an agency booking accepts the terms the agency booked
// under — that version, and only that one.
export async function acceptBookingTerms(db, { code, versionId, now = Date.now() }) {
  return inTx(db, async (c) => {
    const p = (await c.query("SELECT * FROM pledges WHERE UPPER(booking_code) = UPPER($1) FOR UPDATE", [code])).rows[0];
    if (!p || p.payment_mode !== "pay_at_goahead") throw new CatalogueError(404, "Booking not found.");
    if (p.status === "cancelled") throw new CatalogueError(409, "This booking was canceled.");
    if (Number(versionId) !== Number(p.cancellation_tier_version_id)) {
      throw new CatalogueError(409, "These aren't the terms your booking was made under. Reload the page to see them.");
    }
    if (!p.traveller_terms_accepted_at) {
      await c.query("UPDATE pledges SET traveller_terms_accepted_at = $2 WHERE id = $1", [p.id, new Date(now)]);
    }
    return { accepted: true, versionId: Number(p.cancellation_tier_version_id) };
  });
}

// ---------------------------------------------------------------- the tick
// Every 15 minutes, before the manifests freeze (server/jobs/operator-jobs.js).
export async function runPayAtGoAheadTick({ db = pool, now = Date.now(), send = null, env = process.env, log = () => {} } = {}) {
  const out = { requested: 0, opsNotified: 0, reminded: 0, warned: 0, released: 0, reconciled: 0, offersExpired: 0 };

  // 1. A request for every booking on a departure going ahead whose operator
  // has acknowledged (acknowledge() also makes them at once).
  const due = (await db.query(
    `SELECT p.id AS pledge_id, cd.id AS dep_id FROM pledges p
       JOIN catalogue_departures cd ON cd.legacy_departure_id = p.departure_id
      WHERE cd.status = 'go_ahead' AND p.status <> 'cancelled' AND p.payment_mode = 'pay_at_goahead'
        AND EXISTS (SELECT 1 FROM catalogue_assignments a WHERE a.departure_id = cd.id AND a.state = 'acknowledged')
        AND NOT EXISTS (SELECT 1 FROM payment_requests r WHERE r.pledge_id = p.id AND r.state IN ('awaiting_link', 'sent', 'paid', 'unsecured'))
      ORDER BY p.created_at, p.id`)).rows;
  for (const row of due) {
    const made = await inTx(db, async (c) => {
      const departure = await departureFor(c, { id: Number(row.dep_id) });
      return requestPayment(c, { pledgeId: row.pledge_id, departure, now, send, env });
    });
    if (made) out.requested += 1;
  }

  // 2. Ops: the links to make, once per request.
  const waiting = (await db.query(
    `SELECT r.*, c.title, cd.date FROM payment_requests r JOIN catalogue_departures cd ON cd.id = r.departure_id
       JOIN catalogue_products c ON c.id = cd.product_id
      WHERE r.state = 'awaiting_link' AND r.ops_notified_at IS NULL ORDER BY r.id`)).rows;
  if (waiting.length) {
    if (send) {
      const { payAtGoAheadOpsEmail, opsRecipient } = await import("./email.js");
      await send(payAtGoAheadOpsEmail({
        to: opsRecipient(), kind: "links", portalUrl: `${site()}/portal`,
        items: waiting.map((r) => ({ reference: r.reference, title: r.title, date: ymd(r.date), amount: Number(r.amount_eur) })),
      })).catch(() => ({ ok: false }));
    }
    await db.query("UPDATE payment_requests SET ops_notified_at = $2 WHERE id = ANY($1::bigint[])", [waiting.map((r) => r.id), new Date(now)]);
    out.opsNotified = waiting.length;
  }

  // 2b. A link never made (migration 052): alerts to ops and admin at 6 and 12
  // hours after GoAhead, then an admin decision 24 hours before the cut-off.
  // The seat is never released for it: the traveler did nothing wrong.
  const unlinked = (await db.query(
    `SELECT r.* FROM payment_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE r.state = 'awaiting_link' AND r.decision IS NULL AND p.status <> 'cancelled' ORDER BY r.id`)).rows;
  const alerts = { 6: [], 12: [] };
  for (const row of unlinked) {
    const r = mapPayRequest(row);
    const departure = await departureFor(db, { id: r.departureId });
    const item = { reference: r.reference, title: departure.product.title, date: departure.date, amount: r.amountEur, cutoffAt: new Date(departure.cutoffAt).toISOString() };
    if (!r.decisionNeeded && now >= decisionDueAt(departure.cutoffAt)) {
      const claimed = await db.query(
        "UPDATE payment_requests SET decision_needed = 'no_link', decision_needed_at = $2 WHERE id = $1 AND decision_needed IS NULL AND state = 'awaiting_link'",
        [r.id, new Date(now)]);
      if (claimed.rowCount) {
        out.decisionsNeeded = (out.decisionsNeeded || 0) + 1;
        await alertDecisionNeeded(db, { request: row, departure, why: "no_link", send });
      }
      continue;
    }
    const level = linkAlertDue(r, now);
    if (!level) continue;
    const col = level === 12 ? "link_alert_12h_at" : "link_alert_6h_at";
    const claimed = await db.query(`UPDATE payment_requests SET ${col} = $2 WHERE id = $1 AND ${col} IS NULL`, [r.id, new Date(now)]);
    if (claimed.rowCount) alerts[level].push(item);
  }
  for (const level of [6, 12]) {
    if (!alerts[level].length) continue;
    out[`linkAlerts${level}h`] = alerts[level].length;
    if (!send) continue;
    const { payAtGoAheadEscalationEmail } = await import("./email.js");
    for (const to of await escalationRecipients(db)) {
      await send(payAtGoAheadEscalationEmail({ to, level: `${level}h`, items: alerts[level], portalUrl: `${site()}/portal` })).catch(() => ({ ok: false }));
    }
  }

  // 3–5. Reminders, warnings, releases.
  const open = (await db.query(
    `SELECT r.*, c.title, cd.date, p.customers FROM payment_requests r JOIN catalogue_departures cd ON cd.id = r.departure_id
       JOIN catalogue_products c ON c.id = cd.product_id JOIN pledges p ON p.id = r.pledge_id
      WHERE r.state = 'sent' ORDER BY r.due_at, r.id`)).rows;
  const warn = [];
  for (const row of open) {
    const r = mapPayRequest(row);
    if (releaseDue(r, now)) {
      const released = await inTx(db, (c) => releaseSeat(c, { requestId: r.id, now, send }));
      if (released) out.released += 1;
      continue;
    }
    if (reminderDue(r, now)) {
      const claimed = await db.query("UPDATE payment_requests SET reminder_sent_at = $2 WHERE id = $1 AND reminder_sent_at IS NULL AND state = 'sent'", [r.id, new Date(now)]);
      if (claimed.rowCount) {
        out.reminded += 1;
        if (send && r.emailedTo) {
          const { payAtGoAheadReminderEmail } = await import("./email.js");
          await send(payAtGoAheadReminderEmail({
            to: r.emailedTo, name: r.payer === "traveller" ? row.customers : null, title: row.title, dateLabel: dateLabel(row.date),
            amount: r.amountEur, dueAt: r.dueAt, url: r.linkUrl, bookingCode: r.reference,
            ...sellerAndPayee(await sellerOf(db, r.departureId)),
          })).catch(() => ({ ok: false }));
        }
      }
    }
    if (releaseWarningDue(r, now)) {
      const claimed = await db.query("UPDATE payment_requests SET release_warned_at = $2 WHERE id = $1 AND release_warned_at IS NULL AND state = 'sent'", [r.id, new Date(now)]);
      if (claimed.rowCount) warn.push({ reference: r.reference, title: row.title, date: ymd(row.date), amount: r.amountEur, dueAt: r.dueAt });
    }
  }
  if (warn.length) {
    out.warned = warn.length;
    if (send) {
      const { payAtGoAheadOpsEmail, opsRecipient } = await import("./email.js");
      await send(payAtGoAheadOpsEmail({ to: opsRecipient(), kind: "release_warning", items: warn, portalUrl: `${site()}/portal` })).catch(() => ({ ok: false }));
    }
  }

  // 6. Bookings canceled elsewhere; waitlist offers not taken.
  out.reconciled = await reconcileCancelled(db, { now, env });
  out.sellerChangeOffersExpired = await expireSellerChangeOffers(db, { now });
  out.offersExpired = await expireOffers(db, { now, send });
  // Seats freed any other way (an admin edit): offered to whoever is waiting.
  const waitingOn = (await db.query("SELECT DISTINCT departure_id FROM departure_waitlist WHERE state = 'waiting'")).rows;
  for (const { departure_id: id } of waitingOn) {
    out.offered = (out.offered || 0) + await inTx(db, async (c) => offerFreedSeats(c, { departure: await departureFor(c, { id: Number(id) }), now, send }));
  }
  const busy = Object.values(out).some(Boolean);
  if (busy) log(`pay at GoAhead: ${JSON.stringify(out)}`);
  return out;
}
