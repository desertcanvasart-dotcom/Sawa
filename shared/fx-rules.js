// The automatic EUR/EGP rate (064): the rules, with no database, so the
// server, the Finance screen and the tests all read the same ones.
//
//   market rate    EGP per 1 EUR from the provider (or entered by hand)
//   traveler rate  market × (1 − buffer %), what travelers are priced at
//
// A lower traveler rate means more euros per Egyptian pound of price, so the
// buffer covers the pound moving between a booking and the day it is paid.

export const DEFAULT_BUFFER_PCT = 3;
// A fetched rate this far from the previous day's waits for an admin.
export const APPROVAL_JUMP_PCT = 5;
// The traveler rate is renewed weekly, or at once when the market moves this
// far from the market rate it was worked out from.
export const EARLY_UPDATE_PCT = 3;
export const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BUFFER_PCT = 20;

const isNum = (v) => v !== null && v !== "" && Number.isFinite(Number(v));

// |b − a| as a percentage of a.
export function changePct(from, to) {
  if (!isNum(from) || !isNum(to) || Number(from) <= 0) return null;
  return (Math.abs(Number(to) - Number(from)) / Number(from)) * 100;
}

// A fetched rate needs approval when it is more than 5% from the previous
// approved one. The first rate ever has nothing to compare to.
export function needsApproval(previous, next, limitPct = APPROVAL_JUMP_PCT) {
  const pct = changePct(previous, next);
  return pct != null && pct > limitPct;
}

// Rounded DOWN to the piastre: never a rate kinder to the traveler than the
// buffer says.
export function travellerRateFrom(marketRate, bufferPct = DEFAULT_BUFFER_PCT) {
  if (!isNum(marketRate) || Number(marketRate) <= 0) return null;
  const b = isNum(bufferPct) ? Number(bufferPct) : DEFAULT_BUFFER_PCT;
  return Math.floor(Number(marketRate) * (1 - b / 100) * 100 + 1e-9) / 100;
}

export function bufferError(bufferPct) {
  if (!isNum(bufferPct)) return "Enter the buffer as a percentage, e.g. 3.";
  const b = Number(bufferPct);
  if (b < 0 || b > MAX_BUFFER_PCT) return `The buffer must be between 0% and ${MAX_BUFFER_PCT}%.`;
  return null;
}

// The market rate the current traveler rate stands on. A row from before the
// automatic rate (a manual override with no approved market rate yet) has none recorded: it is taken as the
// market rate that, less the buffer, gives it.
function baseMarket(current, bufferPct) {
  if (isNum(current?.marketEgpPerEur)) return Number(current.marketEgpPerEur);
  const b = isNum(current?.bufferPct) ? Number(current.bufferPct) : Number(bufferPct ?? DEFAULT_BUFFER_PCT);
  return Number(current.egpPerEur) / (1 - b / 100);
}

// Is a new traveler rate due, and why? `current` is the rate in force (null
// if there has never been one), `market` the latest approved market rate.
//   initial      none yet
//   weekly       the one in force is a week old
//   market_move  the market is more than 3% from what it was worked out from
// Null when nothing is due, or there is no market rate to work from.
export function travellerUpdateDue({ current, market, bufferPct = DEFAULT_BUFFER_PCT, now = Date.now() }) {
  if (!isNum(market) || Number(market) <= 0) return null;
  if (!current) return "initial";
  const age = now - Date.parse(current.effectiveAt);
  if (Number.isFinite(age) && age >= WEEKLY_MS) return "weekly";
  const moved = changePct(baseMarket(current, bufferPct), market);
  if (moved != null && moved > EARLY_UPDATE_PCT) return "market_move";
  return null;
}

// A traveler's EUR price for an EGP price: EGP ÷ rate, rounded UP to the
// whole euro. The tiny allowance keeps an exact division (2,500 ÷ 50) from
// rounding up on floating-point dust.
export function eurFromEgp(priceEgp, rate) {
  if (!isNum(priceEgp) || !isNum(rate) || Number(rate) <= 0) return null;
  return Math.ceil(Number(priceEgp) / Number(rate) - 1e-9);
}
