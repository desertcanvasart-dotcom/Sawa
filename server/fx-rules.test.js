// The automatic EUR/EGP rate's rules (064), with no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  needsApproval, travellerRateFrom, travellerUpdateDue, eurFromEgp, changePct, bufferError, WEEKLY_MS,
} from "../shared/fx-rules.js";

const NOW = Date.parse("2026-09-28T09:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

test("a fetched rate more than 5% from the previous one needs approval; 5% exactly does not", () => {
  assert.equal(needsApproval(50, 52.5), false, "5.0%");
  assert.equal(needsApproval(50, 52.51), true);
  assert.equal(needsApproval(50, 47.4), true, "a fall counts too");
  assert.equal(needsApproval(null, 80), false, "the first rate has nothing to compare to");
  assert.equal(Math.round(changePct(50, 55) * 100) / 100, 10);
});

test("traveler rate = market × (1 − buffer), rounded down to the piastre", () => {
  assert.equal(travellerRateFrom(50.5, 3), 48.98, "48.985 down");
  assert.equal(travellerRateFrom(55.25, 0), 55.25);
  assert.equal(travellerRateFrom(55.25), 53.59, "default 3%");
  assert.equal(travellerRateFrom(null, 3), null);
  assert.equal(bufferError(3), null);
  assert.match(bufferError(-1), /between 0% and 20%/);
  assert.match(bufferError("x"), /percentage/);
});

test("EUR price = EGP ÷ traveler rate, rounded up to the whole euro", () => {
  assert.equal(eurFromEgp(2360, 50), 48);
  assert.equal(eurFromEgp(2500, 50), 50, "exact stays exact");
  assert.equal(eurFromEgp(2540, 48.98), 52, "51.86 up");
  assert.equal(eurFromEgp(100, 0), null);
});

test("renewal: none yet → initial; a week old → weekly; market 3% from its base → market_move; otherwise nothing", () => {
  assert.equal(travellerUpdateDue({ current: null, market: 50, now: NOW }), "initial");
  assert.equal(travellerUpdateDue({ current: null, market: null, now: NOW }), null, "no market rate, nothing to do");
  const current = { egpPerEur: 48.5, marketEgpPerEur: 50, bufferPct: 3, effectiveAt: daysAgo(2) };
  assert.equal(travellerUpdateDue({ current, market: 51.4, now: NOW }), null, "2.8%");
  assert.equal(travellerUpdateDue({ current, market: 51.6, now: NOW }), "market_move", "3.2%");
  assert.equal(travellerUpdateDue({ current, market: 48.4, now: NOW }), "market_move", "a fall counts too");
  assert.equal(travellerUpdateDue({ current: { ...current, effectiveAt: new Date(NOW - WEEKLY_MS).toISOString() }, market: 50, now: NOW }), "weekly");
  // An override with no market recorded: its base is the rate before the buffer.
  const override = { egpPerEur: 48.5, marketEgpPerEur: null, bufferPct: null, effectiveAt: daysAgo(1) };
  assert.equal(travellerUpdateDue({ current: override, market: 50, bufferPct: 3, now: NOW }), null, "48.5 ÷ 0.97 = 50");
  assert.equal(travellerUpdateDue({ current: override, market: 52, bufferPct: 3, now: NOW }), "market_move");
});
