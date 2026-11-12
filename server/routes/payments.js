// Payment links (043): the ops queue, sending a link, marking it paid, voiding and refunding, and an agency's own view
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { CURRENCY_SYMBOL, CURRENCY } from "../../shared/currency.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { pool, withTransaction } from "../db/index.js";
import { mapPledge, isoDate } from "../db/mappers.js";
import { sendEmailInBackground, paymentLinkEmail, paymentReceivedEmail } from "../email.js";
import { throughPartner } from "../partner.js";
import { STAGE_LABEL, paymentsByPledge, isMissingPaymentsTable, paymentSummary, PAYMENT_KINDS, defaultAmount, cleanLinkUrl, paidTotal, linkDueAt, PAYMENT_PROVIDER, mapPayment } from "../payments.js";
import { routeContext } from "../route-context.js";

const {
  AppError, loadDeparture, loadProduct, app, h, depDateLabel, parse,
} = routeContext();

// ---- Payment links (043) ----------------------------------------------------
//
// Ops make a link in Tab, paste it here, and Sawa emails it to the customer.
// The rules — when a link falls due, where a booking stands — are in
// payments.js; these routes only read, write and tell people.
//
// Until migration 043 is applied every route here answers "payments are not
// switched on yet" instead of failing, and the read-only views simply leave
// payment status out.
const GOAHEAD_STATES = ["minimum_reached", "supplier_confirmed"];
const paymentsNotOn = () => Object.assign(
  new AppError(503, "Payments aren't switched on yet — migration 043 has not been applied to this database."), { expose: true });

function withStageLabel(summary) {
  return { ...summary, label: STAGE_LABEL[summary.stage] || summary.stage };
}

// Everything a payment write needs, read under a lock on the booking so two
// ops acting at once cannot both send a deposit link or both mark one paid.
async function paymentContext(c, pledgeId) {
  const p = (await c.query(`SELECT * FROM pledges WHERE id = $1 FOR UPDATE`, [pledgeId])).rows[0];
  if (!p) throw new AppError(404, "Booking not found.");
  const pledge = mapPledge(p);
  const departure = await loadDeparture(c, p.departure_id);
  const product = departure?.tourProductId ? await loadProduct(c, departure.tourProductId) : null;
  const payments = (await paymentsByPledge(c, [pledgeId])).get(pledgeId) || [];
  return { pledge, departure, product, payments };
}

async function withPayments(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isMissingPaymentsTable(e)) throw paymentsNotOn();
    throw e;
  }
}

// The admin queue: every live booking on a date that reached GoAhead, and any
// booking that has ever had a link, with where it stands.
app.get("/api/admin/payments", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  let rows;
  try {
    rows = (await pool.query(
      `SELECT p.*, d.route, d.date, d.start_date, d.end_date, d.status AS dep_status, d.time AS dep_time,
              d.tour_product_id
         FROM pledges p JOIN departures d ON d.id = p.departure_id
        WHERE (d.status = ANY($1::text[]) AND p.status <> 'cancelled')
           OR EXISTS (SELECT 1 FROM booking_payments b WHERE b.pledge_id = p.id)
        ORDER BY COALESCE(d.start_date, d.date) ASC, d.id ASC, p.created_at ASC`, [GOAHEAD_STATES])).rows;
  } catch (e) {
    if (isMissingPaymentsTable(e)) return res.json({ available: false, items: [] });
    throw e;
  }
  const byPledge = await paymentsByPledge(pool, rows.map((r) => r.id));
  const now = Date.now();
  const items = rows.map((r) => {
    const pledge = mapPledge(r);
    const payments = byPledge.get(r.id) || [];
    const departure = {
      id: Number(r.departure_id), route: r.route, status: r.dep_status, time: r.dep_time,
      date: isoDate(r.date), startDate: isoDate(r.start_date), endDate: isoDate(r.end_date),
    };
    return {
      pledge, departure, dateLabel: depDateLabel(departure), payments,
      summary: withStageLabel(paymentSummary({ pledge, payments, goAhead: GOAHEAD_STATES.includes(r.dep_status), nowMs: now })),
      defaults: Object.fromEntries(PAYMENT_KINDS.map((k) => [k, defaultAmount(k, pledge, payments)])),
    };
  });
  res.json({ available: true, items });
}));

const paymentLinkSchema = z.object({
  kind: z.enum(["deposit", "balance", "full"]),
  url: z.string().trim().min(1, "Paste the Tab payment link."),
  amount: z.coerce.number().positive("Enter the amount on the link.").optional(),
});

app.post("/api/admin/bookings/:pledgeId/payment-links", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const input = parse(paymentLinkSchema, req.body);
  const url = cleanLinkUrl(input.url);
  if (!url) throw new AppError(422, "That isn't a valid https payment link.");
  const result = await withPayments(() => withTransaction(async (c) => {
    const { pledge, departure, product, payments } = await paymentContext(c, req.params.pledgeId);
    if (pledge.status === "cancelled") throw new AppError(409, "This booking is canceled — there is nothing to collect.");
    if (payments.some((p) => p.state === "link_sent" && p.kind === input.kind)) {
      throw new AppError(409, `A ${input.kind} link is already out for this booking. Void it before sending another.`);
    }
    const outstanding = Math.max(0, Math.round(((Number(pledge.bookingTotal) || 0) - paidTotal(payments)) * 100) / 100);
    const amount = Math.round((input.amount ?? defaultAmount(input.kind, pledge, payments)) * 100) / 100;
    if (!(amount > 0)) throw new AppError(422, "There is nothing left to collect on this booking.");
    if (amount > outstanding + 0.005) {
      throw new AppError(422, `That is more than is outstanding on this booking (${CURRENCY_SYMBOL}${outstanding}).`);
    }
    const sentAt = Date.now();
    const { dueAt, boundBy } = linkDueAt({ kind: input.kind, sentAtMs: sentAt, departure, product, balanceDueDate: pledge.balanceDueDate });
    const row = (await c.query(
      `INSERT INTO booking_payments
         (pledge_id, kind, amount, currency, provider, link_url, link_sent_at, due_at, due_bound_by, emailed_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [pledge.id, input.kind, amount, CURRENCY, PAYMENT_PROVIDER, url, new Date(sentAt), new Date(dueAt), boundBy,
        pledge.customerEmail || null, req.user.email || null])).rows[0];
    return { pledge, departure, payment: mapPayment(row) };
  }));
  const { pledge, departure, payment } = result;
  await logAudit(req, {
    action: "payment.link_sent", entity: "pledge", entityId: pledge.id,
    detail: { paymentId: payment.id, kind: payment.kind, amount: payment.amount, dueAt: payment.dueAt, dueBoundBy: payment.dueBoundBy, emailedTo: payment.emailedTo },
  });
  if (pledge.customerEmail) {
    sendEmailInBackground(throughPartner(pool, { pledgeId: pledge.id }, paymentLinkEmail({
      to: pledge.customerEmail, customerName: pledge.customers, route: departure?.route || "your tour",
      dateLabel: departure ? depDateLabel(departure) : "", kind: payment.kind, amount: payment.amount,
      dueAt: payment.dueAt, url: payment.linkUrl, bookingCode: pledge.bookingCode,
    })));
  }
  res.status(201).json({ payment, emailed: !!pledge.customerEmail });
}));

// Change one link's state. Each transition names the only state it may start
// from, so a double click or a stale screen cannot mark a void link paid.
async function transitionPayment(req, { from, apply }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, "Payment not found.");
  return withPayments(() => withTransaction(async (c) => {
    const cur = (await c.query(`SELECT * FROM booking_payments WHERE id = $1`, [id])).rows[0];
    if (!cur) throw new AppError(404, "Payment not found.");
    const ctx = await paymentContext(c, cur.pledge_id);
    const locked = (await c.query(`SELECT * FROM booking_payments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (locked.state !== from) throw new AppError(409, `This link is ${locked.state.replace("_", " ")}, not ${from.replace("_", " ")}.`);
    const row = (await apply(c, id)).rows[0];
    const payments = (await paymentsByPledge(c, [cur.pledge_id])).get(cur.pledge_id) || [];
    // 030's `paid` flag: the agreed price received in full.
    const inFull = (Number(ctx.pledge.bookingTotal) || 0) > 0 && paidTotal(payments) >= Number(ctx.pledge.bookingTotal);
    await c.query(`UPDATE pledges SET paid = $1 WHERE id = $2`, [inFull, cur.pledge_id]);
    return { ...ctx, payments, payment: mapPayment(row), before: mapPayment(cur) };
  }));
}

const referenceSchema = z.object({ reference: z.string().trim().min(1, "Enter Tab's payment reference.").max(120) });
const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

app.post("/api/admin/payments/:id/paid", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { reference } = parse(referenceSchema, req.body);
  const r = await transitionPayment(req, {
    from: "link_sent",
    apply: (c, id) => c.query(
      `UPDATE booking_payments SET state = 'paid', paid_at = now(), provider_reference = $2 WHERE id = $1 RETURNING *`, [id, reference]),
  });
  await logAudit(req, {
    action: "payment.paid", entity: "pledge", entityId: r.pledge.id,
    detail: { paymentId: r.payment.id, kind: r.payment.kind, amount: r.payment.amount, reference },
  });
  if (r.pledge.customerEmail) {
    sendEmailInBackground(throughPartner(pool, { pledgeId: r.pledge.id }, paymentReceivedEmail({
      to: r.pledge.customerEmail, customerName: r.pledge.customers, route: r.departure?.route || "your tour",
      dateLabel: r.departure ? depDateLabel(r.departure) : "", amount: r.payment.amount, reference,
      outstanding: Math.max(0, (Number(r.pledge.bookingTotal) || 0) - paidTotal(r.payments)), bookingCode: r.pledge.bookingCode,
    })));
  }
  res.json({ payment: r.payment });
}));

app.post("/api/admin/payments/:id/void", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { reason } = parse(reasonSchema, req.body || {});
  const r = await transitionPayment(req, {
    from: "link_sent",
    apply: (c, id) => c.query(
      `UPDATE booking_payments SET state = 'void', voided_at = now(), void_reason = $2 WHERE id = $1 RETURNING *`, [id, reason || null]),
  });
  await logAudit(req, {
    action: "payment.void", entity: "pledge", entityId: r.pledge.id,
    detail: { paymentId: r.payment.id, kind: r.payment.kind, amount: r.payment.amount, reason: reason || null },
  });
  res.json({ payment: r.payment });
}));

app.post("/api/admin/payments/:id/refund", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { reference } = parse(referenceSchema, req.body);
  const r = await transitionPayment(req, {
    from: "paid",
    apply: (c, id) => c.query(
      `UPDATE booking_payments SET state = 'refunded', refunded_at = now(), refund_reference = $2 WHERE id = $1 RETURNING *`, [id, reference]),
  });
  await logAudit(req, {
    action: "payment.refund", entity: "pledge", entityId: r.pledge.id,
    detail: { paymentId: r.payment.id, kind: r.payment.kind, amount: r.payment.amount, reference },
  });
  res.json({ payment: r.payment });
}));

// The agency's own bookings, with where each one stands on payment and the
// open link, so the agency can chase its own customer.
app.get("/api/agency/payments", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  if (!req.user.agencyId) throw new AppError(403, "This account is not linked to an agency.");
  const rows = (await pool.query(
    `SELECT p.*, d.status AS dep_status FROM pledges p JOIN departures d ON d.id = p.departure_id WHERE p.agency_id = $1`,
    [req.user.agencyId])).rows;
  let byPledge;
  try {
    byPledge = await paymentsByPledge(pool, rows.map((r) => r.id));
  } catch (e) {
    if (isMissingPaymentsTable(e)) return res.json({ available: false, byPledge: {} });
    throw e;
  }
  const now = Date.now();
  const out = {};
  for (const r of rows) {
    const summary = paymentSummary({ pledge: mapPledge(r), payments: byPledge.get(r.id) || [], goAhead: GOAHEAD_STATES.includes(r.dep_status), nowMs: now });
    out[r.id] = withStageLabel(summary);
  }
  res.json({ available: true, byPledge: out });
}));
