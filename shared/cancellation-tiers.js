// The cancellation tiers under pay at GoAhead (model phase 4), with no
// database and no clock: the tier editor, the refund, the commission rule and
// the loss check all run this arithmetic.
//
// A tier version holds rows for every product type. A row reads "from
// `minBeforeHours` before the start (inclusive) up to the next row, Sawa keeps
// `retainedPct` of the full price". The 0-hour row runs right up to the start
// and covers no-shows. Versions are published with an effective date and never
// change after; a booking keeps the version it was made under.
//
// Mode C has no deposit, so the fee kept on a cancellation is
// full price × the tier's retained percentage (decided 27 Sep 2026).
import { PRODUCT_TYPES, TYPE_LABELS, usesDeadline } from "./catalogue.js";

export const TIER_UNITS = ["hours", "days"];
const HOUR_MS = 3600000;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// The rows for one product type, furthest from the start first.
export function tiersFor(rows, productType) {
  return (rows || [])
    .filter((r) => r.productType === productType)
    .map((r) => ({ ...r, minBeforeHours: Number(r.minBeforeHours), retainedPct: Number(r.retainedPct) }))
    .sort((a, b) => b.minBeforeHours - a.minBeforeHours);
}

// The row that applies `hoursBefore` hours before the start. After the start
// (a no-show) the 0-hour row applies.
export function tierAt(rows, productType, hoursBefore) {
  const tiers = tiersFor(rows, productType);
  if (!tiers.length) return null;
  const h = Number.isFinite(Number(hoursBefore)) ? Math.max(0, Number(hoursBefore)) : 0;
  return tiers.find((t) => h >= t.minBeforeHours) || tiers[tiers.length - 1];
}

export const hoursBeforeStart = (startMs, atMs) => (Number(startMs) - Number(atMs)) / HOUR_MS;

// The version in force on `day` (YYYY-MM-DD, tour timezone): published, with
// the latest effective date on or before it; the higher version number wins a
// tie (a same-day correction). The same rule as a product specification.
export function versionInForce(versions, day) {
  return (versions || [])
    .filter((v) => v.state === "published" && isYmd(v.effectiveFrom) && v.effectiveFrom <= day)
    .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.version - b.version : a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .pop() || null;
}

// "48 hours", "30 days": how a row was entered.
export function amountLabel(hours, unit) {
  const h = Number(hours);
  if (unit === "days" && h % 24 === 0) {
    const d = h / 24;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  return `${h} hour${h === 1 ? "" : "s"}`;
}

// The window a row covers, in words. `upper` is the row before it (further
// from the start), or null for the first row.
export function windowLabel(tier, upper = null) {
  const unit = tier.unit || "hours";
  if (tier.minBeforeHours > 0 && !upper) return `${amountLabel(tier.minBeforeHours, unit)} or more before the start`;
  if (tier.minBeforeHours === 0) {
    return `Less than ${amountLabel(upper ? upper.minBeforeHours : 0, upper?.unit || unit)} before the start, or no-show`;
  }
  // A days row between two days rows reads "29–15 days".
  if (unit === "days" && (upper.unit || "hours") === "days") {
    return `${upper.minBeforeHours / 24 - 1}–${tier.minBeforeHours / 24} days before the start`;
  }
  return `From ${amountLabel(tier.minBeforeHours, unit)} to less than ${amountLabel(upper.minBeforeHours, upper.unit || unit)} before the start`;
}

// The rows of one product type, each with its window in words.
export function describeTiers(rows, productType) {
  const tiers = tiersFor(rows, productType);
  return tiers.map((t, i) => ({ ...t, window: windowLabel(t, tiers[i - 1] || null) }));
}

// Why a set of rows can't be saved, or null. Every product type has rows, one
// of them at 0 hours (the start and no-shows); a days row is a whole number of
// days; percentages run 0–100 and never fall as the start approaches.
export function tierRowsError(rows) {
  for (const type of PRODUCT_TYPES) {
    const label = TYPE_LABELS[type];
    const tiers = tiersFor(rows, type);
    if (!tiers.length) return `${label}: add at least one tier.`;
    const seen = new Set();
    for (const t of tiers) {
      if (!Number.isInteger(t.minBeforeHours) || t.minBeforeHours < 0) return `${label}: the time before the start must be a whole number of hours, 0 or more.`;
      if (t.minBeforeHours > 24 * 400) return `${label}: a tier can start at most 400 days before the start.`;
      if (!TIER_UNITS.includes(t.unit || "hours")) return `${label}: a tier is counted in hours or days.`;
      if (t.unit === "days" && t.minBeforeHours % 24 !== 0) return `${label}: a tier in days must be a whole number of days.`;
      if (!Number.isFinite(t.retainedPct) || t.retainedPct < 0 || t.retainedPct > 100) return `${label}: the retained percentage must be between 0 and 100.`;
      if (seen.has(t.minBeforeHours)) return `${label}: two tiers start at the same time.`;
      seen.add(t.minBeforeHours);
    }
    if (tiers[tiers.length - 1].minBeforeHours !== 0) return `${label}: the last tier must run up to the start (0 hours), so no-shows are covered.`;
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].retainedPct < tiers[i - 1].retainedPct) {
        return `${label}: the retained percentage can't fall as the start gets closer.`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- money
// The fee kept on a cancellation: full price × retained %.
export const cancellationFee = (priceEur, retainedPct) => round2((Number(priceEur) || 0) * (Number(retainedPct) || 0) / 100);

// What a canceling traveler gets back. The fee never exceeds what was paid.
// `resold`: a waitlisted traveler took the seat before the cut-off, so
// nothing is kept (decided 27 Sep 2026).
export function refundFor({ paidEur, priceEur, retainedPct, resold = false }) {
  const paid = round2(paidEur || 0);
  const fee = resold ? 0 : Math.min(paid, cancellationFee(priceEur, retainedPct));
  return { paid, fee: round2(fee), refund: round2(paid - fee) };
}

// ---------------------------------------------------------------- loss check
// What Sawa still owes the operator for one seat once it can no longer drop
// off the manifest (clause 10.2), in EGP, from the locked rate version: the
// per-traveler amount for day and one-way tours; land services plus half a
// twin room for cruises and multi-day (a traveler sharing, the usual case).
// null while the rate card lacks a field.
export function owedPerSeatEgp(productType, rate) {
  if (!rate) return null;
  const n = (v) => (v == null || v === "" ? null : Number(v));
  if (usesDeadline(productType)) {
    const land = n(rate.landPerTraveler);
    const twin = n(rate.roomTwin);
    return land == null || twin == null ? null : round2(land + twin / 2);
  }
  return n(rate.perTraveler);
}

// For each tier window: does any part of it fall after the point where the
// operator is owed for the seat anyway — the cut-off for day and one-way
// tours, the GoAhead deadline for cruises and multi-day? For those windows,
// compare the fee Sawa keeps with what it still owes the operator for the
// seat. A window "loses money" when the fee is less.
//
//   retailEur        the full price of one seat
//   owedEgp          owedPerSeatEgp(), from the locked (or in-force) rate
//   egpPerEur        the exchange rate to compare at
export function lossCheck({ rows, productType, cutoffHours = 48, goaheadDeadlineDays = null, retailEur, owedEgp, egpPerEur }) {
  const pointHours = usesDeadline(productType)
    ? (goaheadDeadlineDays == null ? null : Number(goaheadDeadlineDays) * 24)
    : Number(cutoffHours);
  const owedEur = owedEgp != null && Number(egpPerEur) > 0 ? round2(Number(owedEgp) / Number(egpPerEur)) : null;
  return describeTiers(rows, productType).map((t) => {
    const afterPoint = pointHours != null && t.minBeforeHours < pointHours;
    const retainedEur = retailEur == null ? null : cancellationFee(retailEur, t.retainedPct);
    const base = { minBeforeHours: t.minBeforeHours, unit: t.unit, window: t.window, retainedPct: t.retainedPct, afterPoint, retainedEur, owedEur };
    if (!afterPoint) return { ...base, checked: false, lossEur: null, losesMoney: false, problem: null };
    const problem = retailEur == null ? "price missing" : owedEgp == null ? "rate missing" : owedEur == null ? "exchange rate missing" : null;
    if (problem) return { ...base, checked: false, lossEur: null, losesMoney: false, problem };
    const lossEur = round2(owedEur - retainedEur);
    return { ...base, checked: true, lossEur: lossEur > 0 ? lossEur : 0, losesMoney: lossEur > 0, problem: null };
  });
}

export const pointLabel = (productType) => (usesDeadline(productType) ? "the GoAhead deadline" : "the cut-off");
