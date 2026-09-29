// One price per product, and the operator fee (29 Sep 2026), with the agreed
// examples: 4 travelers at 5,192 EGP, transport 2,650 and guide 2,000 per
// departure, entrance 2,250 and lunch 400 per traveler, a 5% fee, 10% commission.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  departureEconomics, operatorEntitlement, poolRateGaps, poolRateTable, DEFAULT_POOL_TIERS, RATE_TABLE_FROM, RATE_TABLE_TO,
  withFeeOverride, tierPriceSummary, tierPriceLine, tierPriceEur, rateCardError,
} from "../shared/pool-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const ONE = {
  tiers: [{ from: 4, to: 8, priceEgp: 5192, operatorFeePct: 5 }],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [2650] },
    { name: "Guide", basis: "per_group", amounts: [2000] },
    { name: "Entrance fees", basis: "per_traveller", amounts: [2250] },
    { name: "Lunch", basis: "per_traveller", amounts: [400] },
  ],
  commissionPct: 10,
};

test("every product defaults to one tier, 4 to 8, with no default operator fee", () => {
  assert.deepEqual(DEFAULT_POOL_TIERS, [{ from: 4, to: 8, priceEgp: null, operatorFeePct: null }]);
  assert.deepEqual([RATE_TABLE_FROM, RATE_TABLE_TO], [2, 8], "the rate card editor's table is 2 to 8 travelers");
  assert.equal(poolRateTable(ONE).rows.length, 7);
});

test("single price: 4 travelers pool 2,678.7; 8 travelers pool 10,239.9", () => {
  const four = departureEconomics(ONE, 4);
  assert.deepEqual([four.revenue, four.operatingCost, four.operatorFee, four.entitlement, four.commission, four.pool], [20768, 15250, 762.5, 16012.5, 2076.8, 2678.7]);
  const eight = departureEconomics(ONE, 8);
  assert.deepEqual([eight.revenue, eight.operatingCost, eight.operatorFee, eight.entitlement, eight.commission, eight.pool], [41536, 25850, 1292.5, 27142.5, 4153.6, 10239.9]);
  assert.equal(eight.tier, "4–8");
});

test("an operator fee override of 8% on the same 8 travelers moves only that departure", () => {
  // The brief quoted 27,917.9 and 9,464.5. The arithmetic is exact: 25,850 × 1.08 = 27,918.0, so the pool is
  // 41,536 − 27,918 − 4,153.6 = 9,464.4. The figures below are the code's; the difference is reported.
  const over = withFeeOverride(ONE, 8);
  const e = departureEconomics(over, 8);
  assert.deepEqual([e.operatorFeePct, e.operatorFee, e.entitlement, e.pool], [8, 2068, 27918, 9464.4]);
  assert.equal(operatorEntitlement(over, 8).entitlement, 27918);
  assert.equal(over.feeOverridePct, 8, "marked as an override for the statements");
  assert.equal(ONE.tiers[0].operatorFeePct, 5, "the rate card's own fee is untouched");
  assert.equal(departureEconomics(ONE, 8).pool, 10239.9, "another departure of the same product keeps the card");
  assert.equal(withFeeOverride(ONE, null), ONE, "no override: the rate card");
});

test("the operator fee is required: with none, the rate card is incomplete and can't be saved", () => {
  const empty = { ...ONE, tiers: [{ ...ONE.tiers[0], operatorFeePct: "" }] };
  assert.ok(poolRateGaps(empty).includes("operator fee 4–8"));
  const nulled = { ...ONE, tiers: [{ ...ONE.tiers[0], operatorFeePct: null }] };
  assert.ok(poolRateGaps(nulled).includes("operator fee 4–8"));
  assert.deepEqual(poolRateGaps(ONE), []);
  // The server refuses to save it (066: server/rates.js saveRateCard checks rateCardError).
  assert.match(rateCardError(empty), /operator fee is required/);
  assert.equal(rateCardError(ONE), null);
  assert.match(read("server", "rates.js"), /rateCardError\(model, product\)/);
});

test("tour pages and the widget say \"€X per person\" for one price; the from-7 / from-10 lines are gone", () => {
  assert.equal(tierPriceSummary(ONE.tiers, 97), "€54 per person");
  assert.equal(tierPriceLine(ONE.tiers, 97), "€54 per person");
  assert.equal(tierPriceEur(5192, 97), 54);
  // A product that still has tiers keeps the per-size wording (tier support stays in the code).
  const three = [{ from: 4, to: 6, priceEgp: 5192 }, { from: 7, to: 9, priceEgp: 4307 }, { from: 10, to: 12, priceEgp: 4071 }];
  assert.equal(tierPriceSummary(three, 97), "4–6 travelers €54 · 7–9 travelers €45 · 10–12 travelers €42");
  const main = read("src", "main.jsx");
  assert.match(main, /priceTierCount \|\| 0\) > 1 \?/, "the refund promise is only said for a product with several tiers");
  assert.doesNotMatch(main, /from 7 travel|from 10 travel/i);
});

test("the tier-drop refund is not part of the active flow for one tier, and its code stays", () => {
  const src = read("server", "pool-settlement.js");
  assert.match(src, /tiers\.length < 2\) return 0/);
  assert.match(src, /async function refundTierDifferences/, "kept for a product that has tiers");
});
