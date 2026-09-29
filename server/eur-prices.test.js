// Phase 7: rate cards priced in EUR and the tier-removal fix, with no
// database. docs/phase7/REPORT.md. (The phase 7 conversion into drafts went
// with the versions in 066.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  departureEconomics, poolRateTable, tierEur, tierEgp, tierPriceLine, bookingChargeEur, removeTierAt, singlePriceFrom, eurTiersFrom, poolRateGaps,
} from "../shared/pool-model.js";
import { travellerRateFrom, eurFromEgp, manualMarketGap } from "../shared/fx-rules.js";
import { rateCardError } from "../shared/pool-model.js";

// €97 per traveller; transport 2,650 and guide 2,000 per group, entry 2,250
// and lunch 400 per traveller; operator fee 5%; commission 10%.
const GIZA_EUR = {
  tiers: [{ from: 4, to: 8, priceEur: 97, operatorFeePct: 5 }],
  costLines: [
    { name: "Transport", basis: "per_group", amounts: [2650] },
    { name: "Guide", basis: "per_group", amounts: [2000] },
    { name: "Entrance fees", basis: "per_traveller", amounts: [2250] },
    { name: "Lunch", basis: "per_traveller", amounts: [400] },
  ],
  commissionPct: 10,
};

test("€97 at 59: 5,723 EGP revenue per traveler; 4 travelers pool 4,590.3, 8 travelers pool 14,063.1", () => {
  assert.equal(tierEgp(GIZA_EUR.tiers[0], 59), 5723);
  const four = departureEconomics(GIZA_EUR, 4, { eurRate: 59 });
  assert.deepEqual([four.revenue, four.operatingCost, four.operatorFee, four.entitlement, four.commission, four.pool], [22892, 15250, 762.5, 16012.5, 2289.2, 4590.3]);
  const eight = departureEconomics(GIZA_EUR, 8, { eurRate: 59 });
  assert.deepEqual([eight.revenue, eight.operatingCost, eight.operatorFee, eight.entitlement, eight.commission, eight.pool], [45784, 25850, 1292.5, 27142.5, 4578.4, 14063.1]);
  assert.deepEqual([eight.priceEur, eight.priceEgp], [97, 5723]);
});

test("revenue at each booking's locked rate: the settlement passes it in; costs and the pool follow in EGP", () => {
  // 2 seats booked at 59, 2 at 57.23: 2×97×59 + 2×97×57.23 = 11,446 + 11,102.62.
  const e = departureEconomics(GIZA_EUR, 4, { revenueEgp: 2 * 97 * 59 + 2 * 97 * 57.23 });
  assert.equal(e.revenue, 22548.62);
  assert.equal(e.entitlement, 16012.5, "the operator's entitlement does not move with the rate");
  assert.equal(e.commission, 2254.86, "10% of the EGP revenue");
  assert.equal(e.pool, 4281.26);
});

test("travelers pay the EUR price exactly: no conversion, no rounding, whatever the rate", () => {
  assert.equal(tierEur({ priceEur: 97 }, 59), 97);
  assert.equal(tierEur({ priceEur: 97 }, 51.3), 97);
  assert.equal(tierPriceLine(GIZA_EUR.tiers, 59), "€97 per person");
  assert.deepEqual(bookingChargeEur({ rate: GIZA_EUR, headcount: 4, seats: 3, eurRate: 58 }), { eachEur: 97, totalEur: 291, tier: "4–8" });
  // A version from before phase 7 still converts its EGP price, rounded up.
  assert.equal(tierEur({ priceEgp: 3200 }, 57.23), 56);
});

test("no exchange rate: the EUR-priced calculation waits for one", () => {
  const e = departureEconomics(GIZA_EUR, 4);
  assert.deepEqual([e.complete, e.missing], [false, ["exchange rate"]]);
  assert.equal(tierEgp(GIZA_EUR.tiers[0], null), null);
  assert.deepEqual(poolRateGaps(GIZA_EUR), [], "the card itself is complete");
  const table = poolRateTable(GIZA_EUR, { eurRate: 59 });
  assert.equal(table.rows.find((r) => r.headcount === 8).pool, 14063.1, "the editor's table at the current rate");
});

test("automatic 59 less 3% is 57.23, and 3,200 EGP at it is €56; a manual rate is compared with the market", () => {
  assert.equal(travellerRateFrom(59, 3), 57.23);
  assert.equal(eurFromEgp(3200, 57.23), 56);
  assert.deepEqual(manualMarketGap(58, 59), { pct: 1.69, warn: false });
  assert.deepEqual(manualMarketGap(55.5, 59), { pct: 5.93, warn: true });
  assert.equal(manualMarketGap(58, null), null);
});

// ---------------------------------------------------------------- the draft bug
const GIZA_V1 = {
  version: 1, state: "published", commissionPct: 10,
  tiers: [{ from: 4, to: 6, priceEgp: 5192, operatorFeePct: 5 }, { from: 7, to: 9, priceEgp: 4307, operatorFeePct: 6 }, { from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }],
  costLines: [{ name: "Transport", basis: "per_group", amounts: [2650, 2650, 3300] }, { name: "Entrance fees", basis: "per_traveller", amounts: [2250, 2250, 2250] }],
};
const PRODUCT = { goaheadMin: 4, maxGroup: 8 };

test("the cause: removing the first two tiers used to leave one tier, 10–12; it now keeps the range", () => {
  // What the editor did: drop the tier and its range.
  const old = { tiers: GIZA_V1.tiers.filter((_, i) => i === 2), costLines: GIZA_V1.costLines };
  assert.deepEqual(old.tiers, [{ from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }], "the Giza draft v2: 10–12, 4,071, 10%");
  assert.match(rateCardError({ ...old, costLines: [] }, PRODUCT), /Tier 10–12: "To" can't be more than 8/, "and it can no longer be saved");
  assert.match(rateCardError({ ...old, tiers: [{ from: 7, to: 8, priceEgp: 4071, operatorFeePct: 10 }], costLines: [] }, PRODUCT), /first tier starts at 7: start it at 4/);
  // Now: the removed range goes to the neighbour.
  const one = removeTierAt(removeTierAt(GIZA_V1, 0), 0);
  assert.deepEqual(one.tiers, [{ from: 4, to: 12, priceEgp: 4071, operatorFeePct: 10 }]);
  const last = removeTierAt(GIZA_V1, 2);
  assert.deepEqual(last.tiers.map((t) => `${t.from}–${t.to}`), ["4–6", "7–12"]);
  assert.deepEqual(last.costLines[0].amounts, [2650, 2650], "the tier's cost amounts go with it; the lines stay");
});

test("one price as phase 6 meant it: the FIRST tier, from the GoAhead minimum to the maximum group, cost lines kept", () => {
  const one = singlePriceFrom(GIZA_V1, PRODUCT);
  assert.deepEqual(one.tiers, [{ from: 4, to: 8, priceEgp: 5192, operatorFeePct: 5 }]);
  assert.deepEqual(one.costLines, [{ name: "Transport", basis: "per_group", amounts: [2650] }, { name: "Entrance fees", basis: "per_traveller", amounts: [2250] }]);
  assert.deepEqual(singlePriceFrom(GIZA_V1, { goaheadMin: 6, maxGroup: 12 }).tiers[0].from, 6);
});

