// Payment links — the rules, in one place (043).
//
// The client's model (26 Sep 2026): ops make a payment link in Tab
// (tab.travel), paste it into the portal, and Sawa emails it to the customer.
// Two links per booking — the deposit once the date reaches GoAhead, then the
// balance before the trip — and 3 days to pay each. Ops mark a link paid with
// Tab's own reference. Nothing here talks to Tab: if Tab later offers an API,
// it replaces the pasting and the marking, and these rules stay.
//
// Everything below the database helpers is pure, so the whole lifecycle is
// testable without a database (payments.test.js).
import { confirmDeadlineAt } from "./domain.js";
import { zonedDateTimeToUtc } from "./tz.js";
import { paymentWindow, PAYMENT_WINDOW_DAYS } from "../shared/payment-window.js";

export const PAYMENT_KINDS = ["deposit", "balance", "full"];
export const PAYMENT_PROVIDER = "tab";

// A link is never given less than this, whatever the deadlines say. A deposit
// link sent the day before its confirm deadline would otherwise be due in
// hours — or already overdue — which no traveller can act on. Recorded as
// `minimum` in due_bound_by, so the short-notice case is visible afterwards.
export const MIN_WINDOW_HOURS = 24;

// How far ahead of the balance due date the balance link should go out. The
// balance is due 2 days before a day tour and 14 before a package
// (booking-policy.js); a week's notice before that date is when the queue
// starts asking for the link.
export const BALANCE_LINK_LEAD_DAYS = 7;

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------- database

// Undefined table: migration 043 has not been applied to this database yet.
export const isMissingPaymentsTable = (err) => err?.code === "42P01" && /booking_payments/.test(err?.message || "");

export function mapPayment(r) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
  return {
    id: Number(r.id),
    pledgeId: r.pledge_id,
    kind: r.kind,
    amount: Number(r.amount),
    currency: r.currency,
    provider: r.provider,
    linkUrl: r.link_url,
    linkSentAt: iso(r.link_sent_at),
    dueAt: iso(r.due_at),
    dueBoundBy: r.due_bound_by,
    state: r.state,
    paidAt: iso(r.paid_at),
    providerReference: r.provider_reference || null,
    voidedAt: iso(r.voided_at),
    voidReason: r.void_reason || null,
    refundedAt: iso(r.refunded_at),
    refundReference: r.refund_reference || null,
    emailedTo: r.emailed_to || null,
    createdBy: r.created_by || null,
  };
}

// Payments for a set of bookings, grouped by booking. Oldest first, so the
// history reads in the order it happened.
export async function paymentsByPledge(db, pledgeIds) {
  const ids = [...new Set((pledgeIds || []).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT * FROM booking_payments WHERE pledge_id = ANY($1::text[]) ORDER BY link_sent_at ASC, id ASC`, [ids]);
  for (const r of rows) out.get(r.pledge_id)?.push(mapPayment(r));
  return out;
}

// ---------------------------------------------------------------- the rules

// When a link sent now falls due, and which rule decided it.
//
//   deposit / full  3 days, or the date's confirm deadline if sooner — LLL1.2,
//                   the rule shared/payment-window.js was written for.
//   balance         the balance due date the traveller was quoted at booking
//                   (end of that day, Egyptian time). Never earlier: the
//                   confirmation email promised that date in writing.
//
// Then the floor: never less than MIN_WINDOW_HOURS from the moment it is sent.
export function linkDueAt({ kind, sentAtMs, departure = null, product = null, balanceDueDate = null }) {
  const sent = Number(sentAtMs);
  let dueAt;
  let boundBy;
  if (kind === "balance" && balanceDueDate) {
    dueAt = zonedDateTimeToUtc(String(balanceDueDate).slice(0, 10), "23:59");
    boundBy = "balance-due-date";
    if (!Number.isFinite(dueAt)) { dueAt = sent + PAYMENT_WINDOW_DAYS * DAY_MS; boundBy = "window"; }
  } else {
    const deadline = departure ? confirmDeadlineAt(departure, product) : NaN;
    const w = paymentWindow(sent, deadline);
    dueAt = w.dueAt;
    boundBy = w.boundBy;
  }
  if (!Number.isFinite(dueAt) || dueAt - sent < MIN_WINDOW_HOURS * HOUR_MS) {
    dueAt = sent + MIN_WINDOW_HOURS * HOUR_MS;
    boundBy = "minimum";
  }
  return { dueAt, boundBy };
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Money received and still held: paid links, minus any since refunded.
export function paidTotal(payments = []) {
  return round2(payments.filter((p) => p.state === "paid").reduce((s, p) => s + p.amount, 0));
}

// What a new link of this kind should ask for, before ops change it.
export function defaultAmount(kind, pledge, payments = []) {
  const total = Number(pledge?.bookingTotal) || 0;
  const outstanding = Math.max(0, round2(total - paidTotal(payments)));
  if (kind === "deposit") return Math.min(Number(pledge?.depositDue) || 0, outstanding) || outstanding;
  return outstanding;
}

// Where one booking stands, and what ops should do next.
//
//   not_due              the date has not reached GoAhead — nothing is owed yet
//   deposit_link_needed  GoAhead reached, no link sent        → send deposit link
//   link_sent            a link is out and within its window
//   overdue              a link is out and past its due time  → chase or void
//   deposit_paid         part paid; the balance link is not due yet
//   balance_link_needed  part paid, within a week of the balance due date → send balance link
//   paid_in_full         everything received
//   cancelled            the booking was cancelled (→ refund, if anything was paid)
export function paymentSummary({ pledge, payments = [], goAhead = false, nowMs = Date.now() }) {
  const total = round2(pledge?.bookingTotal);
  const paid = paidTotal(payments);
  const refunded = round2(payments.filter((p) => p.state === "refunded").reduce((s, p) => s + p.amount, 0));
  const outstanding = Math.max(0, round2(total - paid));
  const openRow = [...payments].reverse().find((p) => p.state === "link_sent") || null;
  const open = openRow ? {
    id: openRow.id, kind: openRow.kind, amount: openRow.amount, dueAt: openRow.dueAt,
    linkUrl: openRow.linkUrl, overdue: Date.parse(openRow.dueAt) < nowMs,
  } : null;
  const base = { total, paid, refunded, outstanding, open };

  if (pledge?.status === "cancelled") {
    return { ...base, stage: "cancelled", action: paid > 0 ? "refund" : null };
  }
  if (total > 0 && paid >= total) return { ...base, stage: "paid_in_full", action: null };
  if (open) {
    return open.overdue
      ? { ...base, stage: "overdue", action: "chase" }
      : { ...base, stage: "link_sent", action: null };
  }
  if (paid > 0) {
    const due = pledge?.balanceDueDate ? Date.parse(`${String(pledge.balanceDueDate).slice(0, 10)}T00:00:00Z`) : NaN;
    const time = Number.isFinite(due) && nowMs >= due - BALANCE_LINK_LEAD_DAYS * DAY_MS;
    return time
      ? { ...base, stage: "balance_link_needed", action: "send_balance_link" }
      : { ...base, stage: "deposit_paid", action: null };
  }
  return goAhead
    ? { ...base, stage: "deposit_link_needed", action: "send_deposit_link" }
    : { ...base, stage: "not_due", action: null };
}

// What each stage is called on screen — one wording for admin, agency and
// traveller views.
export const STAGE_LABEL = {
  not_due: "Not due yet",
  deposit_link_needed: "Deposit link needed",
  link_sent: "Link sent",
  overdue: "Overdue",
  deposit_paid: "Deposit paid",
  balance_link_needed: "Balance link needed",
  paid_in_full: "Paid in full",
  cancelled: "Canceled",
};

// A pasted link must be a real https URL. Tab is the provider, but its link
// domains are not pinned here: a wrong pin would block a real link at the
// moment a traveller is waiting for it, and ops can see what they pasted.
export function cleanLinkUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 1000) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:") return null;
  return u.toString();
}
