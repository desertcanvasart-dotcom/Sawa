// Money owed, with no database (model phase 3): operator advances and
// balances, deductions, agency commission, booking completeness and the
// margin report. Records and statements only: nothing here moves money.
//
// Decided 27 Sep 2026 (docs/model-audit/03-migration-plan.md, phase 3 block).
import { cancellationBandsFor } from "./booking-policy.js";
import { usesDeadline } from "./catalogue.js";

export const ADVANCE_SHARE = 0.5;                  // of the expected amount, at acknowledgement
export const ADVANCE_BUSINESS_DAYS = 2;            // Egyptian business days after acknowledgement
export const BALANCE_DUE_DAYS = 7;                 // calendar days after the departure ends
export const STATEMENT_AUTO_ACCEPT_DAYS = 30;      // after it is sent, unless disputed
export const LATE_CANCEL_COMMISSION_SHARE = 0.5;   // of the seat's commission
export const COMMISSION_STATEMENT_BY_DAY = 10;     // sent by the 10th for the previous month
export const COMPLETION_REQUEST_DAYS = 7;          // ask for missing booking details
export const COMPLETION_REMINDER_DAYS = 3;         // and remind once
export const SAFETY_NONE = "None";                 // the explicit "no safety needs" answer

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const weekdayOfYmd = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const plusDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- dates
// An Egyptian business day: Sunday to Thursday, and not a public holiday.
export function isEgyptBusinessDay(ymd, holidays = new Set()) {
  const wd = weekdayOfYmd(ymd);
  return wd !== 5 && wd !== 6 && !holidays.has(ymd);
}

// The date `n` business days after `ymd` (the day itself doesn't count).
export function egyptBusinessDaysAfter(ymd, n, holidays = new Set()) {
  let d = ymd;
  let left = n;
  while (left > 0) {
    d = plusDays(d, 1);
    if (isEgyptBusinessDay(d, holidays)) left -= 1;
  }
  return d;
}

export const balanceDueOn = (endYmd) => plusDays(endYmd, BALANCE_DUE_DAYS);
export const statementAutoAcceptAt = (sentAtMs) => sentAtMs + STATEMENT_AUTO_ACCEPT_DAYS * 86400000;

// ---------------------------------------------------------------- operator
export function advanceFor(expectedTotal) {
  if (expectedTotal == null || !Number.isFinite(Number(expectedTotal))) return null;
  return round2(Number(expectedTotal) * ADVANCE_SHARE);
}

// The balance: the final operator amount, less capped deductions, plus
// reimbursements, less the advance. Deductions (penalties and service-failure
// deductions together) never exceed the departure's operator amount.
export function operatorBalance({ finalAmount, advance = 0, deductions = 0, reimbursements = 0 }) {
  if (finalAmount == null) return { balance: null, deductionsApplied: null, capped: false };
  const cap = Math.max(0, Number(finalAmount));
  const applied = Math.min(Number(deductions) || 0, cap);
  return {
    balance: round2(cap - applied + (Number(reimbursements) || 0) - (Number(advance) || 0)),
    deductionsApplied: round2(applied),
    capped: (Number(deductions) || 0) > cap,
  };
}

// How much more may be deducted from a departure's operator amount.
export function deductionRoom(finalAmount, existingDeductions = 0) {
  if (finalAmount == null) return null;
  return round2(Math.max(0, Number(finalAmount) - (Number(existingDeductions) || 0)));
}

// ---------------------------------------------------------------- commission
// Does Sawa keep a fee when a traveler cancels this many days before the
// start? The default cancellation schedule (shared/booking-policy.js): a band
// that retains any of the deposit keeps a fee. Cruises and multi-day tours
// follow the package schedule; day and one-way tours the day-tour schedule.
export function sawaKeepsFee(productType, daysBefore) {
  const bands = cancellationBandsFor({ type: usesDeadline(productType) ? "package" : "day_tour" });
  const band = bands.find((b) => b.days == null || daysBefore >= b.days) || bands[bands.length - 1];
  return (band.ofDeposit || 0) > 0;
}

// A seat's commission, once the departure is decided:
//   departure never reached GoAhead          → void (nothing)
//   traveler traveled (departure completed)  → earned, 100%
//   traveler canceled after GoAhead, in a band where Sawa keeps a fee → half, 50%
//   any other cancellation                   → void
// Returns null while the departure is still undecided.
export function commissionOutcome({
  departureStatus, reachedGoAhead, pledgeStatus, cancelledReason = null,
  cancelledAtMs = null, goAheadAtMs = null, startMs, productType,
}) {
  if (departureStatus === "cancelled_below_minimum" || (!reachedGoAhead && departureStatus !== "open")) {
    return { state: "void", share: 0, reason: "The departure didn't reach GoAhead." };
  }
  if (pledgeStatus === "cancelled") {
    const afterGoAhead = goAheadAtMs != null && cancelledAtMs != null && cancelledAtMs >= goAheadAtMs;
    if (cancelledReason === "traveler" && afterGoAhead && cancelledAtMs != null) {
      const daysBefore = Math.floor((startMs - cancelledAtMs) / 86400000);
      if (sawaKeepsFee(productType, daysBefore)) {
        return { state: "half", share: LATE_CANCEL_COMMISSION_SHARE, reason: "Late cancellation: Sawa keeps a fee." };
      }
    }
    return { state: "void", share: 0, reason: "Canceled without a fee to Sawa." };
  }
  if (departureStatus === "completed") return { state: "earned", share: 1, reason: "Traveled." };
  return null;
}

export function commissionStatementTotals(lines, egpPerEur = null) {
  const totalEur = round2(lines.reduce((s, l) => s + (Number(l.earnedEur) || 0), 0));
  return {
    totalEur,
    totalEgp: egpPerEur == null ? null : round2(totalEur * Number(egpPerEur)),
    seats: lines.reduce((s, l) => s + (Number(l.seats) || 0), 0),
  };
}

// ---------------------------------------------------------------- bookings
// What a booking still lacks for the operator's manifest (required for new
// bookings under catalogue_v2): every traveler's name, a phone number, a
// pickup point, nationality where the product needs it, and an answer on
// safety needs ("None" counts as an answer).
export function missingBookingFields({ seats, travelerNames = [], phone, pickupPoint, nationality, safetyNeeds }, { needsNationality = false } = {}) {
  const missing = [];
  const names = (Array.isArray(travelerNames) ? travelerNames : []).map((n) => String(n || "").trim());
  if (names.filter(Boolean).length < Math.max(1, Number(seats) || 1)) missing.push("travelerNames");
  if (!String(phone || "").trim()) missing.push("phone");
  if (!String(pickupPoint || "").trim()) missing.push("pickupPoint");
  if (needsNationality && !String(nationality || "").trim()) missing.push("nationality");
  if (!String(safetyNeeds || "").trim()) missing.push("safetyNeeds");
  return missing;
}

export const BOOKING_FIELD_LABELS = {
  travelerNames: "every traveler's name",
  phone: "a phone number",
  pickupPoint: "a pickup point",
  nationality: "nationality",
  safetyNeeds: "health or safety needs (or \"none\")",
};

// ---------------------------------------------------------------- margin
// A departure's margin in EUR. EUR revenue is what was charged, by charge
// date. The operator cost (EGP) is converted at the rate on each charge date,
// in proportion to that charge's share of the revenue. A date with no rate in
// the table is reported, never guessed.
//
//   charges       [{ amountEur, day }]   paid, net of refunds
//   operatorEgp   the operator amount (final after the departure, else expected)
//   commissionsEur, feesEur (null when the fee rate isn't set)
//   rates         Map day → EGP per EUR
export function departureMargin({ charges = [], operatorEgp = null, commissionsEur = 0, feesEur = null, rates = new Map() }) {
  const revenueEur = round2(charges.reduce((s, c) => s + Number(c.amountEur || 0), 0));
  const missingRates = [...new Set(charges.filter((c) => !rates.get(c.day)).map((c) => c.day))].sort();
  let operatorEur = null;
  if (operatorEgp != null && revenueEur > 0 && !missingRates.length) {
    operatorEur = round2(charges.reduce((s, c) => s + (Number(operatorEgp) * (Number(c.amountEur) / revenueEur)) / Number(rates.get(c.day)), 0));
  }
  const problem = !charges.length ? "no charges yet"
    : missingRates.length ? "rate missing"
    : operatorEgp == null ? "operator amount unknown"
    : null;
  const margin = problem ? null : round2(revenueEur - operatorEur - Number(commissionsEur || 0) - Number(feesEur || 0));
  return { revenueEur, operatorEgp, operatorEur, commissionsEur: round2(commissionsEur || 0), feesEur, margin, missingRates, problem, feesMissing: feesEur == null };
}
