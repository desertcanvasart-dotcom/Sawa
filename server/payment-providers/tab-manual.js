// Tab (tab.travel) by hand: the first payment provider adapter.
//
// Nothing here calls Tab. Tab has no API this repository can use
// (docs/phase4/payments-readiness.md, sections 1–3), so each step is a task
// for ops, in Admin → Finance → Pay at GoAhead:
//
//   create_link   make a Tab link for the amount, with the booking code as
//                 its reference, and paste it into Sawa (Sawa then emails it
//                 and starts the deadline)
//   (payment)     mark the request paid, quoting Tab's own reference
//   issue_refund  refund the amount in Tab's dashboard, and record Tab's
//                 refund reference
const money = (n) => `€${Number(n).toFixed(2).replace(/\.00$/, "")}`;

export const tabManual = {
  name: "tab-manual",
  manual: true,

  async createPaymentRequest(c, { request, booking, amountEur, deadlineAt }) {
    const reference = booking.bookingCode;
    await c.query(
      `INSERT INTO payment_tasks (kind, provider, request_id, title, detail)
       VALUES ('create_link', 'tab-manual', $1, $2, $3) ON CONFLICT DO NOTHING`,
      [request.id, `Make a Tab link for ${money(amountEur)}, reference ${reference}`,
        JSON.stringify({ amountEur, reference, payer: request.payer, deadlineAt: deadlineAt ? new Date(deadlineAt).toISOString() : null })]);
    return { linkUrl: null, reference };
  },

  async recordPayment(c, { request, providerReference }) {
    const ref = String(providerReference || "").trim();
    if (!ref) throw Object.assign(new Error("Quote Tab's payment reference."), { status: 422 });
    await c.query(
      "UPDATE payment_tasks SET state = 'done', done_at = COALESCE(done_at, now()) WHERE kind = 'create_link' AND request_id = $1 AND state = 'open'",
      [request.id]);
    return { providerReference: ref.slice(0, 200), paidAt: new Date() };
  },

  async refund(c, { refund, request, amountEur }) {
    await c.query(
      `INSERT INTO payment_tasks (kind, provider, refund_id, title, detail)
       VALUES ('issue_refund', 'tab-manual', $1, $2, $3) ON CONFLICT DO NOTHING`,
      [refund.id, `Refund ${money(amountEur)} in Tab for ${request.reference}`,
        JSON.stringify({ amountEur, reference: request.reference, paymentReference: request.providerReference || null, kind: refund.kind })]);
    return { done: false };
  },
};
