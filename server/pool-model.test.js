// Model phase 5 — the pricing and money model with no database, on the inputs
// the model was agreed with (28 Sep 2026): prices 2,540 / 2,487 / 2,360 EGP;
// transport 2,200 / 2,200 / 3,300 per group; guide 2,000 per group; entry 700
// per traveler; operator fee 5% / 6% / 10%; the collecting agent 10%.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  departureEconomics, poolShares, poolRateTable, poolRateError, poolTierIndex, tierPriceEur, tierPriceLine,
  bookingChargeEur, tierDifferenceEur, operatorEntitlement, fxResult, poolStatementEur, convertLegacyRate, poolRateGaps, DEFAULT_POOL_TIERS,
} from "../shared/pool-model.js";

const MODEL_RATE = {
  tiers: [
    { from: 4, to: 6, priceEgp: 2540, operatorFeePct: 5 },
    { from: 7, to: 9, priceEgp: 2487, operatorFeePct: 6 },
    { from: 10, to: 12, priceEgp: 2360, operatorFeePct: 10 },
  ],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [2200, 2200, 3300] },
    { name: "Guide", basis: "per_group", amounts: [2000, 2000, 2000] },
    { name: "Entry fees", basis: "per_traveller", amounts: [700, 700, 700] },
  ],
  commissionPct: 10,
  eurRate: 50,
};

test("4 travelers: operating cost 7,000; entitlement 7,350; commission 1,016; pool 1,794 (448.5 each)", () => {
  const e = departureEconomics(MODEL_RATE, 4);
  assert.deepEqual([e.tier, e.revenue, e.operatingCost, e.entitlement, e.commission, e.pool, e.poolPerTraveller],
    ["4–6", 10160, 7000, 7350, 1016, 1794, 448.5]);
});

test("8 travelers: revenue 19,896; entitlement 10,388; commission 1,989.6; pool 7,518.4 (939.8 each)", () => {
  const e = departureEconomics(MODEL_RATE, 8);
  assert.deepEqual([e.tier, e.revenue, e.operatingCost, e.operatorFee, e.entitlement, e.commission, e.pool, e.poolPerTraveller],
    ["7–9", 19896, 9800, 588, 10388, 1989.6, 7518.4, 939.8]);
});

test("8 travelers, Agency A operating (3 places), Agency B (2), 3 direct: A 2,819.4 + entitlement, B 1,879.6, the collecting agent 4,809", () => {
  const e = departureEconomics(MODEL_RATE, 8);
  const s = poolShares(e, [
    { agencyId: "A", count: 3, outcome: "travelled" },
    { agencyId: "B", count: 2, outcome: "travelled" },
    { agencyId: null, count: 3, outcome: "travelled" },
  ]);
  const a = s.agencies.find((x) => x.agencyId === "A");
  const b = s.agencies.find((x) => x.agencyId === "B");
  assert.equal(a.amount, 2819.4);
  assert.equal(e.entitlement + a.amount, 13207.4, "A as operator (10,388) and as agency (2,819.4)");
  assert.equal(b.amount, 1879.6);
  assert.equal(s.onlineEra.pool, 2819.4, "the direct places' pool");
  assert.equal(s.onlineEra.total, 4809);
  // Every pound accounted for.
  assert.equal(Math.round((e.entitlement + a.amount + b.amount + s.onlineEra.total) * 100) / 100, e.revenue);
});

test("9 travelers: pool 9,014.7. 10: pool 7,710, and the editor warns that the 10th shrinks the pool", () => {
  assert.equal(departureEconomics(MODEL_RATE, 9).pool, 9014.7);
  assert.equal(departureEconomics(MODEL_RATE, 10).pool, 7710);
  const t = poolRateTable(MODEL_RATE, { from: 2, to: 12 });   // a product that still has three tiers
  const ten = t.rows.find((r) => r.headcount === 10);
  assert.equal(ten.poolChange, -1304.7);
  assert.equal(ten.poolShrinks, true);
  assert.ok(t.warnings.some((w) => w.kind === "pool_shrinks" && w.headcount === 10));
  assert.equal(t.rows.find((r) => r.headcount === 9).poolShrinks, false);
});

test("2 travelers (guaranteed, first tier): pool −1,308; the collecting agent pays a 1,308 guarantee; agencies get nothing", () => {
  const e = departureEconomics(MODEL_RATE, 2);
  assert.deepEqual([e.tier, e.revenue, e.entitlement, e.commission, e.pool, e.guarantee], ["4–6", 5080, 5880, 508, -1308, 1308]);
  const s = poolShares(e, [{ agencyId: "A", count: 2, outcome: "travelled" }]);
  assert.equal(s.agencies[0].amount, 0);
  assert.equal(s.onlineEra.total, 508 - 1308, "its commission less the guarantee it pays");
  const t = poolRateTable(MODEL_RATE);
  assert.ok(t.warnings.some((w) => w.kind === "negative_pool" && w.headcount === 2));
  assert.equal(t.rows.length, 7, "2 to 8 travelers: the table stops at the maximum group");
});

test("a late cancellation where a fee is kept earns the agency half the pool per traveler", () => {
  const e = departureEconomics(MODEL_RATE, 8);
  const s = poolShares(e, [
    { agencyId: "A", count: 2, outcome: "travelled" },
    { agencyId: "A", count: 1, outcome: "late_fee_kept" },
    { agencyId: "B", count: 1, outcome: "none" },
    { agencyId: null, count: 4, outcome: "travelled" },
  ]);
  assert.equal(s.agencies.find((x) => x.agencyId === "A").amount, 2349.5);
  assert.equal(s.agencies.find((x) => x.agencyId === "B").amount, 0);
  assert.equal(s.onlineEra.pool, 5168.9);
});

test("tiers: below the first uses the first, above the last the last", () => {
  assert.equal(poolTierIndex(MODEL_RATE.tiers, 1), 0);
  assert.equal(poolTierIndex(MODEL_RATE.tiers, 6), 0);
  assert.equal(poolTierIndex(MODEL_RATE.tiers, 7), 1);
  assert.equal(poolTierIndex(MODEL_RATE.tiers, 12), 2);
  assert.equal(poolTierIndex(MODEL_RATE.tiers, 14), 2);
});

test("travelers see whole euros at the published rate", () => {
  assert.equal(tierPriceEur(2540, 50), 51);
  assert.equal(tierPriceEur(2487, 50), 50);
  assert.equal(tierPriceEur(2360, 50), 48, "rounded up (29 Sep 2026), it was 47");
  assert.equal(tierPriceEur(2500, 50), 50, "an exact division does not tip up");
  assert.equal(tierPriceLine(MODEL_RATE.tiers, 50), "€51 per person, €50 from 7 travelers, €48 from 10");
  assert.equal(tierPriceLine(MODEL_RATE.tiers, null), null, "no rate, no price line");
  assert.deepEqual(bookingChargeEur({ rate: MODEL_RATE, headcount: 8, seats: 2, eurRate: 50 }), { eachEur: 50, totalEur: 100, tier: "7–9" });
});

test("tier drop: 7–9 to 10–12 after payment refunds the EUR difference; a fall never charges more", () => {
  const paid = bookingChargeEur({ rate: MODEL_RATE, headcount: 8, seats: 2, eurRate: 50 }).totalEur;
  const final = bookingChargeEur({ rate: MODEL_RATE, headcount: 10, seats: 2, eurRate: 50 });
  assert.equal(tierDifferenceEur({ paidEur: paid, seats: 2, finalEachEur: final.eachEur }), 4, "\u20ac50 each paid, \u20ac48 each at the final tier");
  const dearer = bookingChargeEur({ rate: MODEL_RATE, headcount: 5, seats: 2, eurRate: 50 });
  assert.equal(tierDifferenceEur({ paidEur: paid, seats: 2, finalEachEur: dearer.eachEur }), 0);
});

test("FX: the published rate against the CBE charge-date rate changes only the collecting agent's FX line", () => {
  const e = departureEconomics(MODEL_RATE, 8);
  const movements = [{ amountEur: 400, day: "2026-10-01" }];
  const at = (r) => fxResult({ movements, rates: new Map([["2026-10-01", r]]), revenueEgp: e.revenue });
  assert.equal(at(49.74).fxEgp, 0);
  assert.equal(at(50).fxEgp, 104);
  assert.equal(at(48).fxEgp, -696);
  // The shares don't move with the rate: nothing in them reads it.
  const shares = poolShares(e, [{ agencyId: "A", count: 8, outcome: "travelled" }]);
  assert.equal(shares.agencies[0].amount, 7518.4);
  assert.deepEqual(fxResult({ movements, rates: new Map(), revenueEgp: 1 }).missingRates, ["2026-10-01"]);
});

test("agency statement: EGP pool shares to EUR at the statement-date rate", () => {
  assert.equal(poolStatementEur(4699, 50), 93.98);
  assert.equal(poolStatementEur(4699, 0), null);
  assert.equal(poolStatementEur(4699, null), null);
});

test("an incomplete rate card gives no numbers, and says what is missing", () => {
  const e = departureEconomics({ ...MODEL_RATE, tiers: DEFAULT_POOL_TIERS }, 8);
  assert.equal(e.complete, false);
  assert.ok(e.missing.includes("price 4–8"));
  assert.ok(e.missing.includes("operator fee 4–8"), "the operator fee has no default: it must be entered");
  assert.deepEqual(poolRateGaps(MODEL_RATE), []);
  assert.equal(poolShares(e, []).problem, "rate card incomplete");
});

test("rate versions that can't be saved", () => {
  assert.equal(poolRateError(MODEL_RATE), null);
  assert.match(poolRateError({ ...MODEL_RATE, tiers: [MODEL_RATE.tiers[0], { ...MODEL_RATE.tiers[2] }] }), /start right after/);
  assert.match(poolRateError({ ...MODEL_RATE, costLines: [{ name: "X", basis: "per_room", amounts: [1, 1, 1] }] }), /basis/);
  assert.match(poolRateError({ ...MODEL_RATE, costLines: [{ name: "X", basis: "per_group", amounts: [1] }] }), /one amount per tier/);
  assert.match(poolRateError({ ...MODEL_RATE, eurRate: 0 }), /EUR rate/);
});

test("migration: band fees become a per-group line, the per-traveler amount a per-traveler line, operator fee 0%", () => {
  const c = convertLegacyRate({ perTraveler: 700, fee4_6: 4200, fee7_9: 4200, fee10_12: 5300, commissionPerSeat: 12 });
  assert.deepEqual(c.costLines, [
    { name: "Departure fee", basis: "per_group", amounts: [4200, 4200, 5300] },
    { name: "Per traveler", basis: "per_traveller", amounts: [700, 700, 700] },
  ]);
  assert.deepEqual(c.tiers.map((t) => t.operatorFeePct), [0, 0, 0]);
  assert.deepEqual(c.tiers.map((t) => t.priceEgp), [null, null, null]);
  assert.ok(c.notes.some((n) => /commission 12 per seat retired/.test(n)));
  const cruise = convertLegacyRate({ landPerTraveler: 3000, roomTwin: 5000, roomSingle: 4000, fee4_6: 1, fee7_9: 1, fee10_12: 1 });
  assert.equal(cruise.costLines[1].name, "Land services");
  assert.deepEqual(cruise.costLines[2], { name: "Room or cabin (twin share)", basis: "per_traveller", amounts: [2500, 2500, 2500] });
  assert.ok(cruise.notes.some((n) => /single room 4000 not carried/.test(n)));
});

test("the entitlement needs costs and fees, not prices: a converted phase 2 version pays what the old rate card paid", () => {
  assert.equal(operatorEntitlement(MODEL_RATE, 8).entitlement, 10388);
  const c = convertLegacyRate({ perTraveler: 700, fee4_6: 4200, fee7_9: 4200, fee10_12: 5300 });
  const e = operatorEntitlement(c, 8);
  assert.deepEqual([e.complete, e.operatingCost, e.operatorFee, e.entitlement], [true, 4200 + 8 * 700, 0, 9800]);
  assert.equal(operatorEntitlement({ ...c, costLines: [{ name: "Guide", basis: "per_group", amounts: [null, 1, 1] }] }, 5).complete, false);
});
