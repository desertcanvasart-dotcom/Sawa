// The price a traveller is SHOWN and the price they are CHARGED, from one file.
//
// ============================================================================
// WHY THIS MOVED
// ============================================================================
//
// `livePriceFor`, `priceFromTiers` and the price clamp existed twice: once in
// `server/domain.js` and once in `src/main.jsx`, under two names for the clamp
// (`clampPrice` / `safePrice`). The client copy carried this comment:
//
//   "Mirror of priceFromTiers in server/domain.js. These two must agree
//    exactly: this one decides the price a traveler is shown, that one decides
//    the price they are charged, and a disagreement is a quote the server won't
//    honour."
//
// **The danger was documented and then guarded by a promise.** The bodies were
// verified identical before this move — nothing was silently reconciled — but
// "these two must agree" is the same instrument that failed for `tourSlug`
// (nine copies), `seatsTotal`, and the group-size numbers.
//
// Here it is one implementation, and `check:duplication` derives its authority
// list from `shared/`, so a second copy of any of these now fails the build.
import { goAheadSeatsFor } from "./departure-state.js";

// A price that is not a usable number falls back rather than propagating NaN
// into a quote. Was `clampPrice` on the server and `safePrice` on the client —
// same body, and two names for one idea is how a reader ends up believing there
// are two ideas.
export function clampPrice(value, fallback) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

// Explicit per-headcount pricing, when an operator wants it.
//
// Stored as breakpoints rather than one row per traveller, because real costs
// step rather than slide: a 7-seater up to six people, a minibus beyond. The
// price for N travellers is the last breakpoint at or below N, so a sparse
// table is complete.
export function priceFromTiers(tiers, seats) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const sorted = tiers
    .map((t) => ({ seats: Number(t?.seats), price: Number(t?.price) }))
    .filter((t) => Number.isFinite(t.seats) && Number.isFinite(t.price) && t.seats > 0 && t.price > 0)
    .sort((a, b) => a.seats - b.seats);
  if (!sorted.length) return null;
  const n = Number(seats) || 0;
  // Below the first breakpoint, the first breakpoint's price applies — the
  // table is validated to start at the minimum group size, so this only comes
  // up for a legacy row that predates that rule.
  let match = sorted[0];
  for (const t of sorted) if (n >= t.seats) match = t;
  return Math.round(match.price);
}

export function livePriceFor(item, seats) {
  const goAhead = goAheadSeatsFor(item);
  const startPrice = clampPrice(item?.publishedRate, 80);
  const breakPrice = Math.min(startPrice, clampPrice(item?.breakPrice, Math.round(startPrice * 0.8)));
  const maxSeats = Math.max(Number(item?.maxSeats || goAhead), goAhead);
  const effectiveSeats = Math.min(maxSeats, Math.max(goAhead, Number(seats || 0)));
  // Clamped first: a party of 20 on a twelve-seat tour pays the twelve price,
  // under the table exactly as under the curve.
  const fromTable = priceFromTiers(item?.priceTiers, effectiveSeats);
  if (fromTable != null) return fromTable;
  const steps = Math.max(1, maxSeats - goAhead);
  const progress = Math.min(1, Math.max(0, effectiveSeats - goAhead) / steps);
  return Math.round(startPrice - (startPrice - breakPrice) * progress);
}
