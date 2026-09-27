// Model phase 3 — the money rules with no database: advance amount and due
// date (weekends and public holidays), the balance on phase 2's worked
// examples, the deduction cap, commission outcomes, statement totals,
// booking completeness, the margin with a missing FX rate, and the PDF.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceFor, egyptBusinessDaysAfter, isEgyptBusinessDay, operatorBalance, deductionRoom, balanceDueOn,
  commissionOutcome, sawaKeepsFee, commissionStatementTotals, missingBookingFields, departureMargin, statementAutoAcceptAt,
} from "../shared/settlement-rules.js";
import { textPdf, statementPdf } from "./pdf.js";

const H = 3600000;
const D = 24 * H;

test("the advance is 50% of the expected amount", () => {
  assert.equal(advanceFor(520), 260);
  assert.equal(advanceFor(390.5), 195.25);
  assert.equal(advanceFor(null), null, "no amount while the rate card is blank");
});

test("the advance is due 2 Egyptian business days later: Sun–Thu, skipping weekends and public holidays", () => {
  // 2026-10-01 is a Thursday. Friday and Saturday are the weekend.
  assert.equal(isEgyptBusinessDay("2026-10-02"), false);
  assert.equal(isEgyptBusinessDay("2026-10-03"), false);
  assert.equal(isEgyptBusinessDay("2026-10-04"), true, "Sunday is a working day");
  assert.equal(egyptBusinessDaysAfter("2026-10-01", 2), "2026-10-05", "Thu → Sun, Mon");
  // 6 October (Armed Forces Day) is a public holiday.
  const holidays = new Set(["2026-10-06"]);
  assert.equal(egyptBusinessDaysAfter("2026-10-04", 2), "2026-10-06");
  assert.equal(egyptBusinessDaysAfter("2026-10-04", 2, holidays), "2026-10-07", "Sun → Mon, (Tue holiday), Wed");
  assert.equal(egyptBusinessDaysAfter("2026-10-01", 2, new Set(["2026-10-04"])), "2026-10-06", "a holiday on Sunday after the weekend");
});

test("the balance on phase 2's worked examples, less a 50% advance", () => {
  const advance = advanceFor(520);   // acknowledged with 8 travelers booked
  assert.equal(operatorBalance({ finalAmount: 520, advance }).balance, 260, "8 × 40 + 200 = 520, less 260");
  assert.equal(operatorBalance({ finalAmount: 390, advance }).balance, 130, "two cancel before the cut-off: 6 × 40 + 150 = 390, less 260");
  assert.equal(operatorBalance({ finalAmount: 520, advance }).balance, 260, "two cancel after the cut-off: still 520, less 260");
  assert.equal(operatorBalance({ finalAmount: null, advance }).balance, null);
  assert.equal(balanceDueOn("2026-11-13"), "2026-11-20", "7 calendar days after the departure ends");
});

test("deductions are capped at the departure's operator amount", () => {
  const r = operatorBalance({ finalAmount: 520, advance: 260, deductions: 800, reimbursements: 50 });
  assert.equal(r.deductionsApplied, 520);
  assert.equal(r.capped, true);
  assert.equal(r.balance, -210, "520 − 520 + 50 − 260: the operator owes Sawa the advance back, less the reimbursement");
  assert.equal(deductionRoom(520, 400), 120);
  assert.equal(deductionRoom(520, 600), 0);
});

test("a statement is accepted automatically 30 days after it is sent", () => {
  const sent = Date.parse("2026-11-01T10:00:00Z");
  assert.equal(new Date(statementAutoAcceptAt(sent)).toISOString(), "2026-12-01T10:00:00.000Z");
});

test("commission: earned when the traveler travels, 50% on a late cancellation where Sawa keeps a fee, nothing without GoAhead", () => {
  const start = Date.parse("2026-11-13T06:00:00Z");
  const base = { startMs: start, productType: "day_tour", goAheadAtMs: start - 10 * D };
  assert.equal(commissionOutcome({ ...base, departureStatus: "completed", reachedGoAhead: true, pledgeStatus: "confirmed" }).state, "earned");
  assert.equal(commissionOutcome({ ...base, departureStatus: "go_ahead", reachedGoAhead: true, pledgeStatus: "confirmed" }), null, "undecided until the trip");
  // Day tour: under 48 hours before, Sawa keeps the deposit.
  const late = commissionOutcome({ ...base, departureStatus: "completed", reachedGoAhead: true, pledgeStatus: "cancelled", cancelledReason: "traveler", cancelledAtMs: start - 24 * H });
  assert.deepEqual([late.state, late.share], ["half", 0.5]);
  assert.equal(commissionOutcome({ ...base, departureStatus: "completed", reachedGoAhead: true, pledgeStatus: "cancelled", cancelledReason: "traveler", cancelledAtMs: start - 3 * D }).state, "void", "early: no fee, no commission");
  assert.equal(commissionOutcome({ ...base, departureStatus: "completed", reachedGoAhead: true, pledgeStatus: "cancelled", cancelledReason: "admin", cancelledAtMs: start - 24 * H }).state, "void", "Sawa canceled it: no fee kept from the traveler");
  assert.equal(commissionOutcome({ ...base, goAheadAtMs: null, departureStatus: "cancelled_below_minimum", reachedGoAhead: false, pledgeStatus: "confirmed" }).state, "void");
  assert.equal(commissionOutcome({ ...base, goAheadAtMs: null, departureStatus: "cancelled_below_minimum", reachedGoAhead: false, pledgeStatus: "cancelled", cancelledReason: "traveler", cancelledAtMs: start - H }).state, "void");
  // Cruises follow the package schedule: 29–15 days keeps half the deposit.
  assert.equal(sawaKeepsFee("cruise", 20), true);
  assert.equal(sawaKeepsFee("cruise", 31), false);
  assert.equal(sawaKeepsFee("day_tour", 1), true);
  assert.equal(sawaKeepsFee("day_tour", 2), false);
});

test("monthly statement totals, in EUR and at the statement date's EGP rate", () => {
  const lines = [{ seats: 2, earnedEur: 24 }, { seats: 1, earnedEur: 6 }, { seats: 3, earnedEur: 0 }];
  assert.deepEqual(commissionStatementTotals(lines), { totalEur: 30, totalEgp: null, seats: 6 });
  assert.deepEqual(commissionStatementTotals(lines, 55.5), { totalEur: 30, totalEgp: 1665, seats: 6 });
});

test("a booking lacks what the manifest needs until every field is there", () => {
  const full = { seats: 2, travelerNames: ["Ana", "Bo"], phone: "+20100", pickupPoint: "Mena House", nationality: "BR", safetyNeeds: "None" };
  assert.deepEqual(missingBookingFields(full, { needsNationality: true }), []);
  assert.deepEqual(missingBookingFields({ ...full, travelerNames: ["Ana"] }), ["travelerNames"]);
  assert.deepEqual(missingBookingFields({ ...full, nationality: "" }, { needsNationality: true }), ["nationality"]);
  assert.deepEqual(missingBookingFields({ ...full, nationality: "" }, { needsNationality: false }), []);
  assert.deepEqual(missingBookingFields({ seats: 1 }), ["travelerNames", "phone", "pickupPoint", "safetyNeeds"]);
});

test("the margin shows 'rate missing' rather than guessing an exchange rate", () => {
  const charges = [{ amountEur: 300, day: "2026-10-01" }, { amountEur: 100, day: "2026-10-05" }];
  const missing = departureMargin({ charges, operatorEgp: 5500, commissionsEur: 20, feesEur: 10, rates: new Map([["2026-10-01", 55]]) });
  assert.equal(missing.margin, null);
  assert.equal(missing.problem, "rate missing");
  assert.deepEqual(missing.missingRates, ["2026-10-05"]);
  // With both rates: 5500 EGP split 3:1 by charge, at 55 and 50.
  const ok = departureMargin({ charges, operatorEgp: 5500, commissionsEur: 20, feesEur: 10, rates: new Map([["2026-10-01", 55], ["2026-10-05", 50]]) });
  assert.equal(ok.operatorEur, 75 + 27.5);
  assert.equal(ok.margin, 400 - 102.5 - 20 - 10);
  assert.equal(departureMargin({ charges: [], operatorEgp: 1 }).problem, "no charges yet");
});

test("the statement PDF is a well-formed PDF with the figures in it", () => {
  const pdf = statementPdf({
    state: "sent", sentAt: "2026-11-21T10:00:00Z",
    snapshot: {
      operator: { legalName: "Nile Tours S.A.E." }, departure: { code: "P01", title: "Giza Pyramids", date: "2026-11-13", specVersion: 1 },
      rateVersion: { version: 1 }, travelers: [{ name: "Ana Lima", booking: "ABC" }], travelerCount: 8, band: "7-9", perTraveler: 40,
      lines: [{ label: "Per traveler", qty: 8, unit: 40, amount: 320 }, { label: "Departure fee, 7–9 travelers", qty: 1, unit: 200, amount: 200 }],
      operatorAmount: 520, adjustments: [], deductionsApplied: 0, reimbursements: 0, advance: 260, balance: 260,
    },
  });
  const text = pdf.toString("latin1");
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /%%EOF\n$/);
  assert.match(text, /Balance EGP 260\.00/);
  assert.match(text, /Nile Tours S\.A\.E\./);
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(xref, xref + 4), "xref", "the xref offset points at the table");
  assert.ok(Number(textPdf(Array.from({ length: 200 }, (_, i) => ({ text: `line ${i}` }))).toString("latin1").match(/\/Count (\d+)/)[1]) > 1, "long statements run to more pages");
});
