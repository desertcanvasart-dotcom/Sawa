// Model phase 4's pure rules: the payment deadline, the reminder and the
// release warning, extensions, the waitlist order, the cancellation tiers,
// refunds, the loss check (clause 10.2) and the commission under pay at
// GoAhead. No database; the integration tests exercise the same rules end
// to end (pay-at-goahead.integration.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import {
  payDeadline, reminderAt, reminderDue, releaseWarningDue, releaseDue, extensionError, nextOffer, offerExpiresAt, paymentStanding,
  linkAlertDue, decisionDueAt, tooLateToStart, shortDeadlineError,
} from "../shared/pay-at-goahead.js";
import {
  tierAt, versionInForce, tierRowsError, describeTiers, refundFor, cancellationFee, lossCheck, owedPerSeatEgp,
} from "../shared/cancellation-tiers.js";
import { commissionOutcome } from "../shared/settlement-rules.js";

const HOUR = 3600000;
const T0 = Date.UTC(2026, 9, 1, 9, 0);

const SEED = [
  ...["day_tour", "one_way_road_tour"].flatMap((t) => [
    { productType: t, minBeforeHours: 48, unit: "hours", retainedPct: 0 },
    { productType: t, minBeforeHours: 0, unit: "hours", retainedPct: 10 },
  ]),
  ...["cruise", "multi_day"].flatMap((t) => [
    { productType: t, minBeforeHours: 720, unit: "days", retainedPct: 0 },
    { productType: t, minBeforeHours: 360, unit: "days", retainedPct: 12.5 },
    { productType: t, minBeforeHours: 0, unit: "days", retainedPct: 25 },
  ]),
];

test("the deadline is 48 hours from the link", () => {
  assert.deepEqual(payDeadline({ sentAtMs: T0, windowHours: 48, cutoffAtMs: T0 + 10 * 24 * HOUR }),
    { dueAt: T0 + 48 * HOUR, boundBy: "window", shortWindow: false });
});

test("the deadline is capped at the cut-off, even below the 24-hour floor (a short window)", () => {
  assert.deepEqual(payDeadline({ sentAtMs: T0, windowHours: 48, cutoffAtMs: T0 + 30 * HOUR }),
    { dueAt: T0 + 30 * HOUR, boundBy: "cutoff", shortWindow: false });
  assert.deepEqual(payDeadline({ sentAtMs: T0, windowHours: 48, cutoffAtMs: T0 + 10 * HOUR }),
    { dueAt: T0 + 10 * HOUR, boundBy: "cutoff", shortWindow: true });
});

test("a window below 24 hours is raised to the floor", () => {
  assert.deepEqual(payDeadline({ sentAtMs: T0, windowHours: 12, cutoffAtMs: NaN }),
    { dueAt: T0 + 24 * HOUR, boundBy: "minimum", shortWindow: false });
});

test("the reminder is at the halfway point, once; the warning 2 hours before; the release at the deadline", () => {
  const due = T0 + 48 * HOUR;
  const req = { state: "sent", linkSentAt: new Date(T0).toISOString(), dueAt: new Date(due).toISOString() };
  assert.equal(reminderAt(T0, due), T0 + 24 * HOUR);
  assert.equal(reminderDue(req, T0 + 23 * HOUR), false);
  assert.equal(reminderDue(req, T0 + 24 * HOUR), true);
  assert.equal(reminderDue({ ...req, reminderSentAt: "x" }, T0 + 25 * HOUR), false, "once");
  assert.equal(reminderDue({ ...req, state: "paid" }, T0 + 25 * HOUR), false, "never after payment");
  assert.equal(releaseWarningDue(req, due - 2 * HOUR - 1), false);
  assert.equal(releaseWarningDue(req, due - 2 * HOUR), true);
  assert.equal(releaseDue(req, due - 1), false);
  assert.equal(releaseDue(req, due), true);
  assert.equal(releaseDue({ ...req, state: "paid" }, due + HOUR), false, "a paid seat is never released");
});

test("an extension needs a reason, a later deadline, and not after the cut-off", () => {
  const base = { currentDueAtMs: T0 + 48 * HOUR, cutoffAtMs: T0 + 96 * HOUR, now: T0 };
  assert.match(extensionError({ ...base, newDueAtMs: T0 + 72 * HOUR, reason: " " }), /why/);
  assert.match(extensionError({ ...base, newDueAtMs: T0 + 40 * HOUR, reason: "x" }), /later/);
  assert.match(extensionError({ ...base, newDueAtMs: T0 + 100 * HOUR, reason: "x" }), /cut-off/);
  assert.equal(extensionError({ ...base, newDueAtMs: T0 + 72 * HOUR, reason: "card blocked" }), null);
});

test("the waitlist offers the first party that fits; an offer is held 12 hours, never past the cut-off", () => {
  const at = (m) => new Date(T0 + m * 60000).toISOString();
  const q = [
    { id: 1, seats: 3, state: "waiting", createdAt: at(1) },
    { id: 2, seats: 2, state: "waiting", createdAt: at(2) },
    { id: 3, seats: 1, state: "waiting", createdAt: at(3) },
    { id: 4, seats: 1, state: "expired", createdAt: at(0) },
  ];
  assert.equal(nextOffer(q, 3).id, 1);
  assert.equal(nextOffer(q, 2).id, 2, "the first that fits");
  assert.equal(nextOffer(q, 0), null);
  assert.equal(offerExpiresAt({ now: T0, offerHours: 12, cutoffAtMs: T0 + 48 * HOUR }), T0 + 12 * HOUR);
  assert.equal(offerExpiresAt({ now: T0, offerHours: 12, cutoffAtMs: T0 + 5 * HOUR }), T0 + 5 * HOUR);
});

test("the manifest marks: paid, or due with the deadline", () => {
  assert.equal(paymentStanding({ state: "paid" }).standing, "paid");
  assert.deepEqual(paymentStanding({ state: "sent", dueAt: "2026-10-03T09:00:00.000Z" }), { standing: "due", label: "Payment due", dueAt: "2026-10-03T09:00:00.000Z" });
});

test("tiers: the row in force at a time before the start, and the version in force on a day", () => {
  assert.equal(tierAt(SEED, "day_tour", 72).retainedPct, 0);
  assert.equal(tierAt(SEED, "day_tour", 48).retainedPct, 0, "48 hours is the first tier (inclusive)");
  assert.equal(tierAt(SEED, "day_tour", 47.9).retainedPct, 10);
  assert.equal(tierAt(SEED, "day_tour", -3).retainedPct, 10, "a no-show");
  assert.equal(tierAt(SEED, "cruise", 20 * 24).retainedPct, 12.5);
  assert.equal(tierAt(SEED, "multi_day", 14 * 24).retainedPct, 25);
  const versions = [
    { id: 1, version: 1, state: "published", effectiveFrom: "2026-01-01" },
    { id: 2, version: 2, state: "published", effectiveFrom: "2026-10-01" },
    { id: 3, version: 3, state: "published", effectiveFrom: "2026-10-01" },
    { id: 4, version: 4, state: "draft", effectiveFrom: null },
  ];
  assert.equal(versionInForce(versions, "2026-09-30").id, 1);
  assert.equal(versionInForce(versions, "2026-10-01").id, 3, "a same-day correction wins");
  assert.deepEqual(describeTiers(SEED, "cruise").map((t) => t.window),
    ["30 days or more before the start", "29–15 days before the start", "Less than 15 days before the start, or no-show"]);
});

test("tier rows are checked before saving", () => {
  assert.equal(tierRowsError(SEED), null);
  assert.match(tierRowsError(SEED.filter((t) => t.productType !== "one_way_road_tour")), /One-way road tour: add/);
  assert.match(tierRowsError(SEED.map((t) => (t.productType === "cruise" && t.minBeforeHours === 0 ? { ...t, minBeforeHours: 24 } : t))), /no-shows/);
  assert.match(tierRowsError(SEED.map((t) => (t.productType === "day_tour" && t.minBeforeHours === 0 ? { ...t, retainedPct: 120 } : t))), /between 0 and 100/);
  assert.match(tierRowsError([...SEED, { productType: "day_tour", minBeforeHours: 30, unit: "days", retainedPct: 5 }]), /whole number of days/);
});

test("refunds: full price × the retained percentage; a resale before the cut-off keeps nothing", () => {
  assert.equal(cancellationFee(100, 10), 10);
  assert.deepEqual(refundFor({ paidEur: 100, priceEur: 100, retainedPct: 10 }), { paid: 100, fee: 10, refund: 90 });
  assert.deepEqual(refundFor({ paidEur: 900, priceEur: 900, retainedPct: 12.5 }), { paid: 900, fee: 112.5, refund: 787.5 });
  assert.deepEqual(refundFor({ paidEur: 100, priceEur: 100, retainedPct: 10, resold: true }), { paid: 100, fee: 0, refund: 100 });
  assert.deepEqual(refundFor({ paidEur: 80, priceEur: 100, retainedPct: 100 }), { paid: 80, fee: 80, refund: 0 }, "never more than was paid");
});

test("loss check (clause 10.2): €95, 2,200 EGP at 55 EGP/EUR, 10% under 48 hours loses €30.50 a seat", () => {
  const w = lossCheck({ rows: SEED, productType: "day_tour", cutoffHours: 48, retailEur: 95, owedEgp: 2200, egpPerEur: 55 });
  assert.deepEqual(w.map((x) => [x.afterPoint, x.losesMoney, x.lossEur]), [[false, false, null], [true, true, 30.5]]);
  // Cruises: checked after the GoAhead deadline (21 days here), per traveler
  // land services plus half a twin room.
  assert.equal(owedPerSeatEgp("cruise", { landPerTraveler: 20000, roomTwin: 30000 }), 35000);
  const c = lossCheck({ rows: SEED, productType: "cruise", goaheadDeadlineDays: 21, retailEur: 900, owedEgp: 35000, egpPerEur: 55 });
  assert.deepEqual(c.map((x) => x.afterPoint), [false, true, true], "29–15 days crosses the 21-day deadline");
  assert.equal(c[1].losesMoney, true, "12.5% of €900 = €112.50 against €636.36 owed");
  assert.equal(lossCheck({ rows: SEED, productType: "day_tour", cutoffHours: 48, retailEur: 95, owedEgp: null, egpPerEur: 55 })[1].problem, "rate missing");
  assert.equal(lossCheck({ rows: SEED, productType: "day_tour", cutoffHours: 48, retailEur: 95, owedEgp: 2200, egpPerEur: null })[1].problem, "exchange rate missing");
});

test("commission under pay at GoAhead: void when released, earned only if paid, half only if a fee was actually kept", () => {
  const base = { reachedGoAhead: true, goAheadAtMs: 1, startMs: 10 * 24 * HOUR, productType: "day_tour", payAtGoAhead: true };
  assert.equal(commissionOutcome({ ...base, departureStatus: "go_ahead", pledgeStatus: "cancelled", cancelledReason: "unpaid", cancelledAtMs: 5 }).state, "void");
  assert.equal(commissionOutcome({ ...base, departureStatus: "completed", pledgeStatus: "confirmed", paid: true }).state, "earned");
  assert.equal(commissionOutcome({ ...base, departureStatus: "completed", pledgeStatus: "confirmed", paid: false }).state, "void");
  const late = { ...base, pledgeStatus: "cancelled", cancelledReason: "traveler", cancelledAtMs: 9 * 24 * HOUR };
  assert.equal(commissionOutcome({ ...late, departureStatus: "go_ahead", feeKept: true }), null, "decided once the departure is over (a resale may still come)");
  assert.equal(commissionOutcome({ ...late, departureStatus: "completed", feeKept: true }).state, "half");
  assert.equal(commissionOutcome({ ...late, departureStatus: "completed", feeKept: false }).state, "void", "resold: nothing kept");
  // The legacy rule is unchanged.
  assert.equal(commissionOutcome({ ...late, payAtGoAhead: false, departureStatus: "completed", cancelledAtMs: 10 * 24 * HOUR - HOUR }).state, "half");
});

test("a link never made: alerts at 6 and 12 hours, once each; a decision 24 hours before the cut-off", () => {
  const req = { state: "awaiting_link", linkUrl: null, createdAt: new Date(T0).toISOString() };
  assert.equal(linkAlertDue(req, T0 + 5 * HOUR), null);
  assert.equal(linkAlertDue(req, T0 + 6 * HOUR), 6);
  assert.equal(linkAlertDue({ ...req, linkAlert6hAt: "x" }, T0 + 7 * HOUR), null, "once");
  assert.equal(linkAlertDue({ ...req, linkAlert6hAt: "x" }, T0 + 12 * HOUR), 12);
  assert.equal(linkAlertDue({ ...req, linkUrl: "https://x" }, T0 + 12 * HOUR), null, "a link was made");
  assert.equal(linkAlertDue({ ...req, state: "sent" }, T0 + 12 * HOUR), null);
  assert.equal(decisionDueAt(T0 + 48 * HOUR), T0 + 24 * HOUR);
});

test("a link that leaves under 12 hours starts no deadline; a decision's short deadline is before the cut-off", () => {
  assert.equal(tooLateToStart(T0 + 11 * HOUR, T0), true);
  assert.equal(tooLateToStart(T0 + 12 * HOUR, T0), false);
  assert.equal(shortDeadlineError({ dueAtMs: T0 + HOUR, cutoffAtMs: T0 + 5 * HOUR, now: T0 }), null);
  assert.match(shortDeadlineError({ dueAtMs: T0 + 6 * HOUR, cutoffAtMs: T0 + 5 * HOUR, now: T0 }), /cut-off/);
  assert.match(shortDeadlineError({ dueAtMs: T0 - 1, cutoffAtMs: T0 + 5 * HOUR, now: T0 }), /future/);
  assert.equal(paymentStanding({ state: "unsecured" }).standing, "unsecured");
  assert.equal(paymentStanding({ state: "awaiting_link", decisionNeeded: "no_link" }).label, "Needs an admin decision");
});
