// The one rate card per product (066), with no database: the worked example
// for "#2 Giza Uncovered", what a save must satisfy, the warning for a EUR
// price that looks like EGP, cost-line notes, and when a tour can be booked.
import test from "node:test";
import assert from "node:assert/strict";
import { departureEconomics, rateCardError, rateCardWarnings, operatingCostFor, poolRateTable } from "../shared/pool-model.js";

// The placeholder URL is never connected: the pool opens lazily.
process.env.DATABASE_URL ||= "postgres://unit:unit@127.0.0.1:1/unit";
const { rateCardBookable, mapSnapshot, NOT_BOOKABLE } = await import("./rates.js");

// #2 Giza Uncovered: €43 for 4–6 (operator fee 5%), €40 for 7–8 (6%);
// transport 1,850 / 2,200 and guiding 2,000 per group; entrance 700 per traveler.
const UNCOVERED = {
  tiers: [{ from: 4, to: 6, priceEur: 43, operatorFeePct: 5 }, { from: 7, to: 8, priceEur: 40, operatorFeePct: 6 }],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [1850, 2200], note: "Higher for 7–8: bigger driver tip" },
    { name: "Guiding", basis: "per_group", amounts: [2000, 2000] },
    { name: "Entrance", basis: "per_traveller", amounts: [700, 700] },
  ],
  commissionPct: 10,
};
const LIMITS = { goaheadMin: 4, maxGroup: 8 };

test("#2 Giza Uncovered at 59 EGP per EUR: 4 travelers → pool 2,150.7; 8 travelers → pool 6,604", () => {
  assert.equal(rateCardError(UNCOVERED, LIMITS), null);
  const four = departureEconomics(UNCOVERED, 4, { eurRate: 59 });
  // 4 × 43 × 59 = 10,148; 1,850 + 2,000 + 4 × 700 = 6,650; +5% = 6,982.5; 10% = 1,014.8.
  assert.deepEqual([four.revenue, four.operatingCost, four.entitlement, four.commission, four.pool], [10148, 6650, 6982.5, 1014.8, 2150.7]);
  const eight = departureEconomics(UNCOVERED, 8, { eurRate: 59 });
  // 8 × 40 × 59 = 18,880; 2,200 + 2,000 + 8 × 700 = 9,800; +6% = 10,388; 10% = 1,888.
  assert.deepEqual([eight.revenue, eight.operatingCost, eight.entitlement, eight.commission, eight.pool], [18880, 9800, 10388, 1888, 6604]);
  assert.equal(poolRateTable(UNCOVERED, { eurRate: 59 }).rows.find((r) => r.headcount === 8).pool, 6604, "the editor's table says the same");
});

test("the tiers must cover the GoAhead minimum to the maximum group, with no gaps or overlaps; \"To\" is at most 8", () => {
  const withTiers = (tiers) => ({ ...UNCOVERED, tiers, costLines: UNCOVERED.costLines.map((l) => ({ ...l, amounts: tiers.map((_, i) => l.amounts[i] ?? l.amounts[0]) })) });
  assert.match(rateCardError(withTiers([{ from: 4, to: 6, priceEur: 43, operatorFeePct: 5 }, { from: 7, to: 11, priceEur: 40, operatorFeePct: 6 }]), LIMITS),
    /Tier 7–11: "To" can't be more than 8/, "#2 Giza Uncovered as it was");
  assert.match(rateCardError(withTiers([{ from: 5, to: 8, priceEur: 43, operatorFeePct: 5 }]), LIMITS), /first tier starts at 5: start it at 4/);
  assert.match(rateCardError(withTiers([{ from: 4, to: 7, priceEur: 43, operatorFeePct: 5 }]), LIMITS), /last tier ends at 7: end it at 8/);
  assert.match(rateCardError(withTiers([{ from: 4, to: 5, priceEur: 43, operatorFeePct: 5 }, { from: 7, to: 8, priceEur: 40, operatorFeePct: 6 }]), LIMITS), /Tier 2 must start right after tier 1 ends \(6\)/, "a gap");
  assert.match(rateCardError(withTiers([{ from: 4, to: 6, priceEur: 43, operatorFeePct: 5 }, { from: 6, to: 8, priceEur: 40, operatorFeePct: 6 }]), LIMITS), /Tier 2 must start right after tier 1 ends \(7\)/, "an overlap");
  assert.equal(rateCardError(withTiers([{ from: 2, to: 8, priceEur: 43, operatorFeePct: 5 }]), LIMITS), null, "starting below the minimum is fine (a guaranteed departure)");
  assert.equal(rateCardError(withTiers([{ from: 4, to: 12, priceEur: 43, operatorFeePct: 5 }]), { goaheadMin: 4, maxGroup: 12 }), null, "a cruise may go to 12");
});

test("the operator fee and every cost amount are required; prices on every tier or none", () => {
  const noFee = { ...UNCOVERED, tiers: [UNCOVERED.tiers[0], { ...UNCOVERED.tiers[1], operatorFeePct: null }] };
  assert.match(rateCardError(noFee, LIMITS), /Tier 7–8: the operator fee is required/);
  const noAmount = { ...UNCOVERED, costLines: [{ ...UNCOVERED.costLines[0], amounts: [1850, null] }, ...UNCOVERED.costLines.slice(1)] };
  assert.match(rateCardError(noAmount, LIMITS), /Cost line "Transport": enter the amount for 7–8/);
  const half = { ...UNCOVERED, tiers: [UNCOVERED.tiers[0], { ...UNCOVERED.tiers[1], priceEur: null }] };
  assert.match(rateCardError(half, LIMITS), /Enter a price for every tier, or none \(7–8 has none\)/);
  const none = { ...UNCOVERED, tiers: UNCOVERED.tiers.map((t) => ({ ...t, priceEur: null })) };
  assert.equal(rateCardError(none, LIMITS), null, "a card with no prices saves (the pool waits for prices)");
});

test("a EUR price that looks like an EGP amount is a warning, not a refusal", () => {
  assert.deepEqual(rateCardWarnings(UNCOVERED, LIMITS), [], "€43 and €40 are fine");
  // 2,537 is 43 × 59: the EGP amount typed as euros. At 4 travelers the
  // operating cost per traveler is 6,650 ÷ 4 = 1,662.5 EGP.
  const typed = { ...UNCOVERED, tiers: [{ ...UNCOVERED.tiers[0], priceEur: 2537 }, UNCOVERED.tiers[1]] };
  const w = rateCardWarnings(typed, LIMITS);
  assert.equal(w.length, 1);
  assert.equal(w[0].tier, "4–6");
  assert.match(w[0].text, /€2,537 for 4–6 looks like an EGP amount: it is more than the operating cost per traveler at 4 \(1,662.5 EGP\)/);
  assert.equal(rateCardError(typed, LIMITS), null, "it still saves");
});

test("a cost line's note travels with it: the calculation's lines carry it (the operator statement shows it)", () => {
  const lines = operatingCostFor(UNCOVERED, 1, 8).lines;
  assert.equal(lines[0].note, "Higher for 7–8: bigger driver tip");
  assert.equal("note" in lines[1], false);
});

test("a tour can be booked with a rate card and a site-wide rate; a snapshot reads like a card", () => {
  assert.deepEqual(rateCardBookable(null, 59), { ok: false, reason: "no_rate_card" });
  assert.deepEqual(rateCardBookable(UNCOVERED, null), { ok: false, reason: "no_exchange_rate" });
  assert.deepEqual(rateCardBookable(UNCOVERED, 59), { ok: true });
  assert.match(NOT_BOOKABLE.no_rate_card, /can't be booked right now/);
  const snap = mapSnapshot({ tiers: UNCOVERED.tiers, costLines: UNCOVERED.costLines, commissionPct: 10, currency: "EGP", takenAt: "2026-09-29T10:00:00Z" });
  assert.equal(snap.snapshot, true);
  assert.equal(departureEconomics(snap, 8, { eurRate: 59 }).pool, 6604);
  assert.equal(snap.costLines[0].note, "Higher for 7–8: bigger driver tip");
  assert.equal(mapSnapshot(null), null);
});
