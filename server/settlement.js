// Settlements and the Wednesday payouts — the arithmetic, in one place (044).
//
// The client's model (26 Sep 2026), per departure:
//
//   revenue collected + extra income − approved net tour cost = gross profit
//
// Extra income (046) is money the tour brings in beyond the bookings: a
// commission from a shop, optional tours the guide sells. It sits on the cost
// sheet as "money in", is approved by Sawa like a cost, and is shared the same
// way. A commission Sawa's side PAYS (to a guide, a hotel) is a cost.
//   Sawa takes 10% of the gross profit
//   the other 90% is shared by the participating agencies by headcount
//
// Headcount is paid passengers: seats on a live booking whose money, net of
// refunds, is above zero. A refunded passenger is not counted. Direct
// travellers count for Capital Travel Service, widget travellers for the
// agency whose widget they used (passengerOwner in domain.js — the operator
// rule's own answer).
//
// Sawa decides and approves everything. Its decisions — who absorbs a loss,
// who covers a non-refundable cost — are ADJUSTMENTS: a signed amount for one
// party (agency id, or null for Sawa), added after the split.
//
// Payouts: every Wednesday, for tours that ended by the Saturday before, with
// the money collected by that Saturday's end (Cairo time). Money that arrives
// later is paid as a top-up on a later Wednesday: a run pays, per departure
// and agency, what is owed as of its cutoff minus what approved runs already
// paid. Nothing is ever edited after it is paid; a correction is a new line.
import { passengerOwner } from "./domain.js";
import { zonedDateTimeToUtc } from "./tz.js";

export const SAWA_SHARE = 0.10;
export const COST_CATEGORIES = ["transport", "guide", "entrance", "meals", "activities", "accommodation", "permits", "local_services", "commission_paid", "other"];
export const INCOME_CATEGORIES = ["shop_commission", "optional_tours", "commission_received"];
export const COST_LABEL = {
  transport: "Transportation", guide: "Tour guide", entrance: "Entrance fees", meals: "Meals",
  activities: "Activities", accommodation: "Accommodation", permits: "Permits",
  local_services: "Local services", commission_paid: "Commission we pay", other: "Other",
  shop_commission: "Shop commission", optional_tours: "Optional tours sold", commission_received: "Other commission received",
};
// A line's kind follows from its category: money out (a cost) or money in.
export const lineKind = (category) => (INCOME_CATEGORIES.includes(category) ? "income" : "cost");
// The categories as the screens list them.
export const LINE_CATEGORIES = [...COST_CATEGORIES, ...INCOME_CATEGORIES].map((id) => ({ id, label: COST_LABEL[id], kind: lineKind(id) }));

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const at = (v) => { const t = Date.parse(v || ""); return Number.isNaN(t) ? NaN : t; };

export const isMissingSettlementTables = (err) => err?.code === "42P01"
  && /departure_costs|settlement_adjustments|departure_settlements|payout_runs|payout_lines|payout_transfers/.test(err?.message || "");

// ---------------------------------------------------------------- dates

// Calendar day in Cairo, as YYYY-MM-DD.
export const cairoDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(ms));

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The Wednesday a run pays on, from any day: that day if it is a Wednesday,
// else the next one.
export function payDateOnOrAfter(iso) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();   // 0 Sun … 3 Wed
  return addDays(iso, (3 - dow + 7) % 7);
}

// What a Wednesday run covers: tours that ended by the Saturday before, and
// money collected by the end of that Saturday in Cairo.
export function runWindow(payDateIso) {
  if (new Date(`${payDateIso}T12:00:00Z`).getUTCDay() !== 3) throw new Error(`${payDateIso} is not a Wednesday`);
  const saturday = addDays(payDateIso, -4);
  const next = addDays(saturday, 1);
  // The last instant of Saturday is the instant Sunday begins.
  return { payDate: payDateIso, saturday, cutoffMs: zonedDateTimeToUtc(next, "00:00") - 1 };
}

// A departure has ended by `dayIso` when its last day is on or before it.
export const endedBy = (departure, dayIso) => String(departure.endDate || departure.startDate || departure.date || "9999").slice(0, 10) <= dayIso;

// ---------------------------------------------------------------- the split

// Money for one booking as of an instant: paid in, minus refunded.
export function netPaidAsOf(payments = [], asOfMs = Infinity) {
  let n = 0;
  for (const p of payments) {
    if ((p.state === "paid" || p.state === "refunded") && at(p.paidAt) <= asOfMs) n += p.amount;
    if (p.state === "refunded" && at(p.refundedAt) <= asOfMs) n -= p.amount;
  }
  return round2(n);
}

const approvedTotal = (lines, kind) =>
  round2(lines.filter((c) => c.state === "approved" && (c.kind || "cost") === kind).reduce((s, c) => s + Number(c.approvedAmount ?? c.amount), 0));
export const approvedCostTotal = (lines = []) => approvedTotal(lines, "cost");
export const approvedIncomeTotal = (lines = []) => approvedTotal(lines, "income");

// One departure's settlement as of an instant.
//
// Returns the figures and, per party, what it is owed: `shares` for agencies
// (headcount share + adjustments) and `sawa` for Sawa (10%, rounding pennies,
// anything that could not be shared, and its own adjustments).
export function settleDeparture({
  pledges = [], paymentsByPledge = new Map(), costs = [], adjustments = [],
  directAgencyId = null, referralAgencies = null, asOfMs = Infinity,
}) {
  let revenue = 0;
  const seats = new Map();
  for (const p of pledges) {
    const net = netPaidAsOf(paymentsByPledge.get(p.id) || [], asOfMs);
    revenue += net;
    if (p.status === "cancelled" || net <= 0) continue;
    const owner = passengerOwner(p, { directAgencyId, referralAgencies });
    if (!owner) continue;
    seats.set(owner, (seats.get(owner) || 0) + (Number(p.seats) || 0));
  }
  revenue = round2(revenue);
  const cost = approvedCostTotal(costs);
  const income = approvedIncomeTotal(costs);
  const gross = round2(revenue + income - cost);
  const loss = gross < 0;
  const totalSeats = [...seats.values()].reduce((s, n) => s + n, 0);
  const sawaCut = loss ? 0 : round2(gross * SAWA_SHARE);
  const pool = loss ? 0 : round2(gross - sawaCut);

  const byAgency = new Map();
  for (const [agencyId, n] of seats) {
    byAgency.set(agencyId, { agencyId, seats: n, pct: totalSeats ? n / totalSeats : 0, share: totalSeats ? Math.floor((pool * n / totalSeats) * 100) / 100 : 0, adjustments: 0 });
  }
  const shared = round2([...byAgency.values()].reduce((s, a) => s + a.share, 0));
  let sawaAdjust = 0;
  for (const a of adjustments) {
    if (!a.agencyId) { sawaAdjust += Number(a.amount); continue; }
    if (!byAgency.has(a.agencyId)) byAgency.set(a.agencyId, { agencyId: a.agencyId, seats: 0, pct: 0, share: 0, adjustments: 0 });
    byAgency.get(a.agencyId).adjustments = round2(byAgency.get(a.agencyId).adjustments + Number(a.amount));
  }
  const shares = [...byAgency.values()].map((a) => ({ ...a, total: round2(a.share + a.adjustments) }))
    .sort((x, y) => y.seats - x.seats || String(x.agencyId).localeCompare(String(y.agencyId)));
  return {
    revenue, income, cost, gross, loss, sawaCut, pool, totalSeats,
    // The pennies the floor left, and the whole pool when nobody is left to
    // share it (every passenger refunded), stay with Sawa.
    sawa: { cut: sawaCut, remainder: round2(pool - shared), adjustments: round2(sawaAdjust), total: round2(sawaCut + pool - shared + sawaAdjust) },
    shares,
  };
}

// Why a departure cannot be paid yet — or null when it can.
export function payoutBlocker({ ended, costsFinal, loss, lossDecided, pendingCosts }) {
  if (!ended) return "not_ended";
  if (pendingCosts > 0) return "costs_to_review";
  if (!costsFinal) return "costs_not_final";
  if (loss && !lossDecided) return "loss_needs_decision";
  return null;
}
export const BLOCKER_LABEL = {
  not_ended: "Tour not ended",
  costs_to_review: "Cost lines to review",
  costs_not_final: "Cost sheet not final",
  loss_needs_decision: "Loss — Sawa to decide",
};

// A run's lines: owed as of the cutoff, minus what approved runs already paid,
// per departure and agency. An agency paid before and owed nothing now (its
// passengers refunded since) gets a negative line — money it owes back, netted
// against the rest of its transfer. Zero lines are left out.
export function payoutLines(entitled, alreadyPaid, departureIds = new Set(entitled.map((e) => e.departureId))) {
  const lines = [];
  const seen = new Set();
  for (const { departureId, agencyId, amount, detail } of entitled) {
    const key = `${departureId}:${agencyId}`;
    seen.add(key);
    const paid = alreadyPaid.get(key) || 0;
    const delta = round2(amount - paid);
    if (Math.abs(delta) >= 0.01) lines.push({ departureId, agencyId, amount: delta, detail: { ...detail, owed: amount, previouslyPaid: round2(paid) } });
  }
  for (const [key, paid] of alreadyPaid) {
    const [dep, agencyId] = [Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1)];
    if (seen.has(key) || !departureIds.has(dep) || Math.abs(paid) < 0.01) continue;
    lines.push({ departureId: dep, agencyId, amount: round2(-paid), detail: { owed: 0, previouslyPaid: round2(paid), reason: "no longer owed" } });
  }
  return lines;
}
