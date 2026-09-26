// 044 — the settlement arithmetic and the Wednesday schedule, without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settleDeparture, netPaidAsOf, approvedCostTotal, runWindow, payDateOnOrAfter, endedBy,
  payoutLines, payoutBlocker, SAWA_SHARE,
} from "./settlement.js";

const CTS = "ag_cts", A = "ag_a", B = "ag_b";
const T = (d) => `2026-10-${String(d).padStart(2, "0")}T10:00:00Z`;
const paid = (amount, day = 1, extra = {}) => ({ state: "paid", amount, paidAt: T(day), ...extra });
const refunded = (amount, paidDay, refundDay) => ({ state: "refunded", amount, paidAt: T(paidDay), refundedAt: T(refundDay) });

// The client's complete example (§10): 15 passengers, CTS 7 / A 5 / B 3,
// revenue $3,000, approved cost $1,500 → Sawa $150, CTS $630, A $450, B $270.
function example() {
  const pledges = [
    { id: "d", agencyId: "direct_customer", seats: 7, status: "confirmed" },
    { id: "a", agencyId: A, seats: 5, status: "confirmed" },
    { id: "b", agencyId: B, seats: 3, status: "confirmed" },
  ];
  const paymentsByPledge = new Map([["d", [paid(1400)]], ["a", [paid(1000)]], ["b", [paid(600)]]]);
  const costs = [
    { state: "approved", amount: 900, approvedAmount: 900 },
    { state: "approved", amount: 700, approvedAmount: 600 },   // Sawa approved less than asked
    { state: "rejected", amount: 400 },
    { state: "submitted", amount: 999 },
  ];
  return { pledges, paymentsByPledge, costs, directAgencyId: CTS };
}

test("the client's worked example comes out to the cent", () => {
  const s = settleDeparture(example());
  assert.equal(s.revenue, 3000);
  assert.equal(s.cost, 1500, "approved amounts only — rejected and unreviewed lines don't count");
  assert.equal(s.gross, 1500);
  assert.equal(s.sawaCut, 150);
  assert.equal(s.pool, 1350);
  assert.deepEqual(s.shares.map((x) => [x.agencyId, x.seats, x.total]), [[CTS, 7, 630], [A, 5, 450], [B, 3, 270]]);
  assert.equal(s.sawa.total, 150);
  assert.equal(SAWA_SHARE, 0.10);
});

test("pennies the split can't divide stay with Sawa, and the books balance", () => {
  const s = settleDeparture({ ...example(), costs: [{ state: "approved", amount: 1499.99, approvedAmount: 1499.99 }] });
  const agencies = s.shares.reduce((n, x) => n + x.total, 0);
  assert.equal(Math.round((agencies + s.sawa.total) * 100), Math.round(s.gross * 100), "every cent of profit is assigned");
  assert.ok(s.sawa.remainder >= 0 && s.sawa.remainder < 0.05);
});

test("refunded passengers are not counted, and their money is out of revenue", () => {
  const ex = example();
  ex.paymentsByPledge.set("b", [refunded(600, 1, 3)]);
  const s = settleDeparture(ex);
  assert.equal(s.revenue, 2400);
  assert.deepEqual(s.shares.map((x) => x.agencyId), [CTS, A], "B has no paid passengers left");
  assert.equal(s.totalSeats, 12);
  // Before the refund happened, B still counted.
  assert.equal(settleDeparture({ ...ex, asOfMs: Date.parse(T(2)) }).totalSeats, 15);
});

test("widget travellers count for the agency whose widget they used", () => {
  const s = settleDeparture({
    pledges: [{ id: "w", agencyId: "direct_customer", refCode: "agency-a", seats: 2, status: "confirmed" }],
    paymentsByPledge: new Map([["w", [paid(500)]]]), directAgencyId: CTS, referralAgencies: new Map([["agency-a", A]]),
  });
  assert.deepEqual(s.shares.map((x) => x.agencyId), [A]);
});

test("money collected after the cutoff is left for a later run", () => {
  const ex = example();
  ex.paymentsByPledge.set("b", [paid(200, 1), paid(400, 6)]);
  const early = settleDeparture({ ...ex, asOfMs: Date.parse(T(4)) });
  assert.equal(early.revenue, 2600);
  const later = settleDeparture(ex);
  assert.equal(later.revenue, 3000);
});

test("a loss shares nothing out; Sawa's decision is an adjustment", () => {
  const ex = { ...example(), costs: [{ state: "approved", amount: 3300, approvedAmount: 3300 }] };
  const s = settleDeparture(ex);
  assert.equal(s.loss, true);
  assert.equal(s.gross, -300);
  assert.equal(s.sawaCut, 0);
  assert.ok(s.shares.every((x) => x.total === 0), "no automatic split of a loss");
  // Sawa decides the operator absorbs it.
  const decided = settleDeparture({ ...ex, adjustments: [{ agencyId: CTS, amount: -300, reason: "operator overspend" }] });
  assert.equal(decided.shares.find((x) => x.agencyId === CTS).total, -300);
  // Or that Sawa covers a non-refundable cost for an agency.
  const covered = settleDeparture({ ...example(), adjustments: [{ agencyId: A, amount: 40, reason: "non-refundable ticket" }, { agencyId: null, amount: -40, reason: "Sawa covers" }] });
  assert.equal(covered.shares.find((x) => x.agencyId === A).total, 490);
  assert.equal(covered.sawa.total, 110);
});

test("net paid counts payments and refunds by their own dates", () => {
  const rows = [paid(100, 1), refunded(50, 2, 5), { state: "link_sent", amount: 999 }, { state: "void", amount: 999 }];
  assert.equal(netPaidAsOf(rows, Date.parse(T(3))), 150);
  assert.equal(netPaidAsOf(rows), 100);
  assert.equal(approvedCostTotal([{ state: "approved", amount: 10 }, { state: "approved", amount: 10, approvedAmount: 0 }]), 10);
});

// ---- the Wednesday schedule

test("a Wednesday run covers tours ended by the Saturday before, money to that Saturday's end in Cairo", () => {
  const w = runWindow("2026-10-14");
  assert.equal(w.saturday, "2026-10-10");
  assert.equal(new Date(w.cutoffMs).toISOString(), "2026-10-10T20:59:59.999Z", "Saturday 23:59:59.999 Cairo (UTC+3)");
  assert.throws(() => runWindow("2026-10-13"), /not a Wednesday/);
});

test("the next pay date is the coming Wednesday, or today on a Wednesday", () => {
  assert.equal(payDateOnOrAfter("2026-10-11"), "2026-10-14", "Sunday → Wednesday");
  assert.equal(payDateOnOrAfter("2026-10-14"), "2026-10-14");
  assert.equal(payDateOnOrAfter("2026-10-15"), "2026-10-21");
});

test("ended by: a package's last day, a day tour's day", () => {
  assert.equal(endedBy({ date: "2026-10-10" }, "2026-10-10"), true);
  assert.equal(endedBy({ startDate: "2026-10-05", endDate: "2026-10-11" }, "2026-10-10"), false);
});

test("pay now, top up later: a run pays only what earlier runs didn't", () => {
  const entitled = [
    { departureId: 1, agencyId: A, amount: 450, detail: {} },
    { departureId: 1, agencyId: B, amount: 300, detail: {} },
  ];
  const first = payoutLines(entitled, new Map());
  assert.deepEqual(first.map((l) => [l.agencyId, l.amount]), [[A, 450], [B, 300]]);
  // Next week: a late payment raised A to 480; B unchanged.
  const alreadyPaid = new Map([["1:ag_a", 450], ["1:ag_b", 300]]);
  const topUp = payoutLines([{ ...entitled[0], amount: 480 }, entitled[1]], alreadyPaid);
  assert.deepEqual(topUp.map((l) => [l.agencyId, l.amount]), [[A, 30]]);
  // B's passengers were refunded after being paid: B owes it back.
  const clawback = payoutLines([{ ...entitled[0], amount: 480 }], new Map([["1:ag_a", 480], ["1:ag_b", 300]]), new Set([1]));
  assert.deepEqual(clawback.map((l) => [l.agencyId, l.amount]), [[B, -300]]);
});

test("a departure is paid out only when Sawa has signed it off", () => {
  const ok = { ended: true, costsFinal: true, loss: false, lossDecided: false, pendingCosts: 0 };
  assert.equal(payoutBlocker(ok), null);
  assert.equal(payoutBlocker({ ...ok, ended: false }), "not_ended");
  assert.equal(payoutBlocker({ ...ok, pendingCosts: 1 }), "costs_to_review");
  assert.equal(payoutBlocker({ ...ok, costsFinal: false }), "costs_not_final");
  assert.equal(payoutBlocker({ ...ok, loss: true }), "loss_needs_decision");
  assert.equal(payoutBlocker({ ...ok, loss: true, lossDecided: true }), null);
});
