// The pricing and money model (model phase 5, final 28 Sep 2026), with no
// database and no clock: one calculation that the rate card editor, the
// payment requests, the operator and agency statements, the margin report and
// Finance all call. Every amount is EGP unless the name says EUR. "The
// collecting agent" is Sawa's operating company, BRAND.legalName in
// server/brand.js (the name is written in one place: entity-disclosure.test.js).
//
// A rate version, per product:
//
//   tiers        [{ from, to, priceEur, operatorFeePct }]   default one tier, 4–8
//                (phase 7: the price is entered in EUR, what travelers pay;
//                a version from before carries priceEgp instead)
//   costLines    [{ name, basis: "per_group" | "per_traveller", amounts: [one per tier] }]
//   commissionPct   the collecting agent's commission, % of the selling price (default 10)
//
// Travelers pay the EUR price exactly. The site-wide exchange rate (064,
// phase 7: automatic or manual, server/fx.js) converts it into EGP for the
// operator and agency calculations: revenue = EUR price × the rate locked on
// each booking. `eurRate` below is always that rate, passed in.
//
// Per departure, from the manifest at the cut-off:
//
//   tier            by headcount (a guaranteed departure below 4 uses the first)
//   revenue         the places × the tier's EUR price × each booking's locked rate
//                   (an EGP-priced version: headcount × its EGP price)
//   operating cost  the per-group lines + headcount × the per-traveller lines
//   entitlement     operating cost × (1 + operator fee %): the operator's, in EGP
//   commission      revenue × commission %: the collecting agent's (payment costs come out of it)
//   pool            revenue − entitlement − commission
//   pool/traveller  pool ÷ headcount: an agency-sold place (the operator's own
//                   included) earns it for the agency; a direct place, for the collecting agent
//
// A negative pool: no agency share, and the collecting agent pays the operator's
// shortfall (the Minimum Departure Guarantee). A late cancellation where a fee
// is kept earns the agency half the pool per traveller for that place.

import { eurFromEgp } from "./fx-rules.js";

export const COST_BASES = ["per_group", "per_traveller"];
export const COST_BASIS_LABELS = { per_group: "per group", per_traveller: "per traveler" };
// One selling price per product (29 Sep 2026): every product defaults to a
// single tier, 4 to 8. Tier support stays in the code (poolTierIndex, the tier
// refund) for a product that has several. The operator fee has NO default: it
// is set case by case per product, and a rate card can't be published without it.
export const DEFAULT_POOL_TIERS = [
  { from: 4, to: 8, priceEgp: null, operatorFeePct: null },
];
// The phase 2 bands, kept only to convert a version that predates the pool model.
const LEGACY_BAND_TIERS = [
  { from: 4, to: 6, priceEgp: null, operatorFeePct: 0 },
  { from: 7, to: 9, priceEgp: null, operatorFeePct: 0 },
  { from: 10, to: 12, priceEgp: null, operatorFeePct: 0 },
];
export const DEFAULT_COMMISSION_PCT = 10;
export const LATE_CANCEL_POOL_SHARE = 0.5;
export const RATE_TABLE_FROM = 2;
export const RATE_TABLE_TO = 8;

const cents = (n) => Math.round(Number(n) * 100) / 100;
const isNum = (v) => v != null && v !== "" && Number.isFinite(Number(v));

// ---------------------------------------------------------------- tiers
// The tier a headcount prices at: the one containing it; below the first, the
// first (a guaranteed departure run below 4); above the last, the last.
export function poolTierIndex(tiers, headcount) {
  const n = Number(headcount) || 0;
  if (!Array.isArray(tiers) || !tiers.length) return -1;
  let idx = 0;
  tiers.forEach((t, i) => { if (n >= Number(t.from)) idx = i; });
  return idx;
}

export const tierLabel = (t) => `${t.from}–${t.to}`;

// The operator fee for ONE departure (29 Sep 2026): a percentage an admin sets
// for that departure alone, with a reason, until the operator acknowledges the
// offer. It replaces the rate card's fee on every tier for that departure, and
// nothing else: the price, the cost lines and every other departure keep the
// rate card. `feeOverridePct` marks the rate as overridden, for the statements.
export function withFeeOverride(rate, pct) {
  if (!rate || pct == null || pct === "") return rate;
  const p = Number(pct);
  return { ...rate, feeOverridePct: p, tiers: (rate.tiers || []).map((t) => ({ ...t, operatorFeePct: p })) };
}

// An EGP price in EUR, for travelers: EGP ÷ the site-wide rate (064), rounded
// UP to a whole euro. Only a version still priced in EGP needs it.
export function tierPriceEur(priceEgp, eurRate) {
  return eurFromEgp(priceEgp, eurRate);
}

// Phase 7: a tier is priced in EUR (`priceEur`, what travelers pay, exactly)
// or, on a version from before, in EGP (`priceEgp`, converted at the rate).
export const tierPriced = (t) => isNum(t?.priceEur) || isNum(t?.priceEgp);
export const isEurPriced = (rate) => (rate?.tiers || []).some((t) => isNum(t.priceEur));

// What travelers pay for a tier, in EUR: the EUR price as entered (no
// conversion, no rounding), else the EGP price converted. The one place this
// is decided: the rate card editor, the tour page, the widget and the charge
// all read it, so what is shown is what is charged.
export function tierEur(tier, eurRate) {
  if (isNum(tier?.priceEur)) return Number(tier.priceEur);
  return tierPriceEur(tier?.priceEgp, eurRate);
}

// A tier's price in EGP, for the operator and agency calculations: EUR price ×
// the rate (null without one), else the EGP price as entered.
export function tierEgp(tier, eurRate) {
  if (isNum(tier?.priceEur)) return isNum(eurRate) && Number(eurRate) > 0 ? cents(Number(tier.priceEur) * Number(eurRate)) : null;
  return isNum(tier?.priceEgp) ? Number(tier.priceEgp) : null;
}

// The tiers as travelers read them: [{ label: "4–6", eur }], one per tier.
export function tierPriceRows(tiers, eurRate) {
  return (tiers || []).map((t) => ({ label: `${t.from}–${t.to}`, from: Number(t.from), to: Number(t.to), eur: tierEur(t, eurRate) }));
}

// "4–6 travelers €54 · 7–9 travelers €45 · 10–12 travelers €42". Null unless every
// tier has a price and there is a rate: a half-filled card shows nothing.
export function tierPriceSummary(tiers, eurRate, symbol = "€") {
  const rows = tierPriceRows(tiers, eurRate);
  if (!rows.length || rows.some((r) => r.eur == null)) return null;
  // One price: "€54 per person". Several tiers keep the per-size wording.
  if (rows.length === 1) return `${symbol}${rows[0].eur} per person`;
  return rows.map((r) => `${r.label} travelers ${symbol}${r.eur}`).join(" · ");
}

// What the tour page says: "€X per person, €Y from 7 travelers, €Z from 10".
export function tierPriceLine(tiers, eurRate, symbol = "€") {
  const prices = (tiers || []).map((t) => ({ from: Number(t.from), eur: tierEur(t, eurRate) }));
  if (!prices.length || prices.some((p) => p.eur == null)) return null;
  return prices.map((p, i) => (i === 0 ? `${symbol}${p.eur} per person`
    : i === 1 ? `${symbol}${p.eur} from ${p.from} travelers` : `${symbol}${p.eur} from ${p.from}`)).join(", ");
}

// ---------------------------------------------------------------- one departure
// What is missing for the calculation, as field names an editor can show.
export function poolRateGaps(rate) {
  const gaps = [];
  if (!rate) return ["rate version"];
  const tiers = rate.tiers || [];
  if (!tiers.length) gaps.push("tiers");
  tiers.forEach((t) => {
    if (!tierPriced(t)) gaps.push(`price ${tierLabel(t)}`);
    if (!isNum(t.operatorFeePct)) gaps.push(`operator fee ${tierLabel(t)}`);
  });
  (rate.costLines || []).forEach((l) => {
    tiers.forEach((t, i) => { if (!isNum(l.amounts?.[i])) gaps.push(`${l.name || "cost line"} ${tierLabel(t)}`); });
  });
  if (!isNum(rate.commissionPct)) gaps.push("agent commission");
  return gaps;
}

export function operatingCostFor(rate, tierIdx, headcount) {
  let total = 0;
  const lines = [];
  for (const l of rate.costLines || []) {
    const unit = Number(l.amounts?.[tierIdx]);
    const qty = l.basis === "per_traveller" ? Number(headcount) || 0 : 1;
    const amount = cents(unit * qty);
    lines.push({ name: l.name, basis: l.basis, unit, qty, amount });
    total += amount;
  }
  return { total: cents(total), lines };
}

// The operator's entitlement alone: operating cost × (1 + fee %). It needs
// the cost lines and the fees, not the selling prices, so a version converted
// from phase 2 (fee 0%) still gives the operator its rate-card amount.
export function operatorEntitlement(rate, headcount) {
  const n = Math.max(0, Number(headcount) || 0);
  const tiers = rate?.tiers || [];
  const missing = [];
  if (!tiers.length) missing.push("tiers");
  if (tiers.length) {
    const idx = poolTierIndex(tiers, n);
    const tier = tiers[idx];
    if (!isNum(tier.operatorFeePct)) missing.push(`operator fee ${tierLabel(tier)}`);
    for (const l of rate.costLines || []) if (!isNum(l.amounts?.[idx])) missing.push(`${l.name || "cost line"} ${tierLabel(tier)}`);
    if (!missing.length) {
      const cost = operatingCostFor(rate, idx, n);
      const operatorFee = cents(cost.total * Number(tier.operatorFeePct) / 100);
      return {
        complete: true, missing: [], headcount: n, tier: tierLabel(tier), operatingCost: cost.total, costLines: cost.lines,
        operatorFeePct: Number(tier.operatorFeePct), operatorFee, entitlement: cents(cost.total + operatorFee),
      };
    }
  }
  return { complete: false, missing, headcount: n, entitlement: null };
}

// The whole calculation for one departure. null amounts, with `missing`, while
// the rate version is incomplete.
//
// Phase 7: a EUR-priced tier's revenue in EGP is the EUR price × a rate:
//   revenueEgp  given by the settlement: each booking's seats at the rate
//               locked on that booking (pool-settlement.js)
//   eurRate     otherwise, one rate for every place (the editor's table uses
//               the current site-wide rate, and says so)
// Everything after the revenue is EGP, exactly as before.
export function departureEconomics(rate, headcount, { eurRate = null, revenueEgp = null } = {}) {
  const n = Math.max(0, Number(headcount) || 0);
  const missing = poolRateGaps(rate);
  if (missing.length) return { headcount: n, missing, complete: false };
  const idx = poolTierIndex(rate.tiers, n);
  const tier = rate.tiers[idx];
  const priceEur = isNum(tier.priceEur) ? Number(tier.priceEur) : null;
  if (priceEur != null && !isNum(revenueEgp) && !(isNum(eurRate) && Number(eurRate) > 0)) {
    return { headcount: n, missing: ["exchange rate"], complete: false };
  }
  const priceEgp = priceEur != null ? tierEgp(tier, eurRate) : Number(tier.priceEgp);
  const revenue = isNum(revenueEgp) ? cents(Number(revenueEgp)) : cents(n * priceEgp);
  const cost = operatingCostFor(rate, idx, n);
  const operatorFeePct = Number(tier.operatorFeePct);
  const operatorFee = cents(cost.total * operatorFeePct / 100);
  const entitlement = cents(cost.total + operatorFee);
  const commissionPct = Number(rate.commissionPct);
  const commission = cents(revenue * commissionPct / 100);
  const pool = cents(revenue - entitlement - commission);
  return {
    complete: true, missing: [], headcount: n, tierIndex: idx, tier: tierLabel(tier), priceEgp, priceEur,
    revenue, operatingCost: cost.total, costLines: cost.lines, operatorFeePct, operatorFee, entitlement,
    commissionPct, commission, pool,
    poolPerTraveller: n > 0 ? cents(pool / n) : null,
    guarantee: pool < 0 ? cents(-pool) : 0,
  };
}

// ---------------------------------------------------------------- the shares
// Who gets what from one departure. `places` are the manifest's places at the
// cut-off, grouped: { agencyId (null for a direct place), count, outcome }.
//   travelled       the full pool per traveller
//   late_fee_kept   a late cancellation where a fee was kept: half of it
//   none            nothing (canceled with no fee kept, or resold)
// Whatever an agency doesn't get (direct places, the other half of a late
// cancellation, places that earn nothing) stays with the collecting agent. A negative
// pool pays no agency; the collecting agent pays the guarantee.
export function poolShares(econ, places = []) {
  if (!econ?.complete) return { agencies: [], onlineEra: null, problem: "rate card incomplete" };
  const ppt = econ.pool > 0 && econ.poolPerTraveller != null ? econ.poolPerTraveller : 0;
  const byAgency = new Map();
  let agencyTotal = 0;
  for (const p of places) {
    if (!p.agencyId) continue;
    const count = Number(p.count) || 0;
    const factor = p.outcome === "travelled" ? 1 : p.outcome === "late_fee_kept" ? LATE_CANCEL_POOL_SHARE : 0;
    const amount = cents(count * ppt * factor);
    const cur = byAgency.get(p.agencyId) || { agencyId: p.agencyId, places: 0, latePlaces: 0, amount: 0 };
    if (p.outcome === "travelled") cur.places += count;
    if (p.outcome === "late_fee_kept") cur.latePlaces += count;
    cur.amount = cents(cur.amount + amount);
    byAgency.set(p.agencyId, cur);
    agencyTotal = cents(agencyTotal + amount);
  }
  const poolKept = econ.pool > 0 ? cents(econ.pool - agencyTotal) : 0;
  const directPlaces = places.filter((p) => !p.agencyId).reduce((s, p) => s + (Number(p.count) || 0), 0);
  return {
    agencies: [...byAgency.values()],
    onlineEra: {
      commission: econ.commission,
      pool: poolKept,
      directPlaces,
      guarantee: econ.guarantee,
      total: cents(econ.commission + poolKept - econ.guarantee),
    },
    problem: null,
  };
}

// ---------------------------------------------------------------- the editor
// The live table: 2 to 12 travelers, with the two warnings.
export function poolRateTable(rate, { from = RATE_TABLE_FROM, to = RATE_TABLE_TO, eurRate = null } = {}) {
  const rows = [];
  let prev = from > 0 ? departureEconomics(rate, from - 1, { eurRate }) : null;
  for (let n = from; n <= to; n++) {
    const e = departureEconomics(rate, n, { eurRate });
    const poolChange = e.complete && prev?.complete ? cents(e.pool - prev.pool) : null;
    rows.push({
      ...e,
      poolChange,
      negativePool: e.complete && e.pool < 0,
      poolShrinks: poolChange != null && poolChange < 0,
    });
    prev = e;
  }
  return {
    rows,
    warnings: [
      ...rows.filter((r) => r.negativePool).map((r) => ({ headcount: r.headcount, kind: "negative_pool", text: `At ${r.headcount} travelers the pool is negative (${r.pool}): the Minimum Departure Guarantee pays ${r.guarantee}.` })),
      ...rows.filter((r) => r.poolShrinks).map((r) => ({ headcount: r.headcount, kind: "pool_shrinks", text: `Adding the ${r.headcount}th traveler shrinks the pool by ${-r.poolChange}.` })),
    ],
  };
}

// A rate version that can't be saved: the reason, else null.
export function poolRateError(rate) {
  const tiers = rate?.tiers;
  if (!Array.isArray(tiers) || !tiers.length) return "Add at least one tier.";
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!Number.isInteger(Number(t.from)) || !Number.isInteger(Number(t.to)) || Number(t.from) < 1 || Number(t.to) < Number(t.from)) {
      return `Tier ${i + 1}: "from" and "to" must be whole numbers, with "to" no smaller than "from".`;
    }
    if (i > 0 && Number(t.from) !== Number(tiers[i - 1].to) + 1) return `Tier ${i + 1} must start right after tier ${i} ends (${Number(tiers[i - 1].to) + 1}).`;
    if ((isNum(t.priceEgp) && Number(t.priceEgp) < 0) || (isNum(t.priceEur) && Number(t.priceEur) < 0)) return `Tier ${tierLabel(t)}: the price can't be negative.`;
    if (isNum(t.operatorFeePct) && (Number(t.operatorFeePct) < 0 || Number(t.operatorFeePct) > 100)) return `Tier ${tierLabel(t)}: the operator fee is a percentage from 0 to 100.`;
  }
  for (const l of rate.costLines || []) {
    if (!String(l.name || "").trim()) return "Every cost line needs a name.";
    if (!COST_BASES.includes(l.basis)) return `Cost line "${l.name}": the basis is "per group" or "per traveler".`;
    if (!Array.isArray(l.amounts) || l.amounts.length !== tiers.length) return `Cost line "${l.name}" needs one amount per tier.`;
    if (l.amounts.some((a) => isNum(a) && Number(a) < 0)) return `Cost line "${l.name}": amounts can't be negative.`;
  }
  if (isNum(rate.commissionPct) && (Number(rate.commissionPct) < 0 || Number(rate.commissionPct) >= 100)) return "The agent's commission is a percentage from 0 to under 100.";
  return null;
}

// ---------------------------------------------------------------- travelers
// What a booking is charged: its seats at the EUR price of the tier the
// departure is in when the request is sent, at the rate the booking stored.
export function bookingChargeEur({ rate, headcount, seats, eurRate }) {
  if (!rate?.tiers?.length) return null;
  const tier = rate.tiers[poolTierIndex(rate.tiers, headcount)];
  const each = tierEur(tier, eurRate);
  return each == null ? null : { eachEur: each, totalEur: each * (Number(seats) || 0), tier: tierLabel(tier) };
}

// A departure that reached a cheaper tier by the cut-off refunds the
// difference; it never charges more when the headcount falls.
export function tierDifferenceEur({ paidEur, seats, finalEachEur }) {
  if (!isNum(paidEur) || !isNum(finalEachEur)) return 0;
  return Math.max(0, cents(Number(paidEur) - Number(finalEachEur) * (Number(seats) || 0)));
}

// The collecting agent's FX line: the EUR actually collected (net of refunds), each
// amount at the CBE rate on its day, less the nominal EGP revenue. It never
// reaches an operator or an agency. A day with no rate is reported, not guessed.
export function fxResult({ movements = [], rates = new Map(), revenueEgp }) {
  const missingRates = [...new Set(movements.filter((m) => !rates.get(m.day)).map((m) => m.day))].sort();
  if (missingRates.length || revenueEgp == null) return { collectedEur: null, collectedEgp: null, fxEgp: null, missingRates };
  const collectedEur = cents(movements.reduce((s, m) => s + Number(m.amountEur), 0));
  const collectedEgp = cents(movements.reduce((s, m) => s + Number(m.amountEur) * Number(rates.get(m.day)), 0));
  return { collectedEur, collectedEgp, fxEgp: cents(collectedEgp - Number(revenueEgp)), missingRates };
}

// An agency's monthly pool shares, in EUR at the CBE rate on the statement date.
export function poolStatementEur(totalEgp, egpPerEur) {
  if (!isNum(totalEgp) || !isNum(egpPerEur) || Number(egpPerEur) <= 0) return null;
  return cents(Number(totalEgp) / Number(egpPerEur));
}

// ---------------------------------------------------------------- migration
// An old (phase 2) rate version in the new shape: the band fees become one
// per-group line, the per-traveler amount one per-traveler line, and the
// operator fee is 0%. Selling prices were never on the operator rate card, so
// they are left for an admin to enter. Room rates have no place in the new
// shape: a twin room becomes half its rate per traveler, and the single-room
// rate is reported, not carried.
export function convertLegacyRate(old) {
  const notes = [];
  const fees = [old.fee4_6, old.fee7_9, old.fee10_12].map((v) => (isNum(v) ? Number(v) : null));
  const perHead = isNum(old.perTraveler) ? Number(old.perTraveler) : isNum(old.landPerTraveler) ? Number(old.landPerTraveler) : null;
  const costLines = [{ name: "Departure fee", basis: "per_group", amounts: fees }];
  if (perHead != null || old.perTraveler !== undefined || old.landPerTraveler !== undefined) {
    costLines.push({ name: isNum(old.landPerTraveler) && !isNum(old.perTraveler) ? "Land services" : "Per traveler", basis: "per_traveller", amounts: [perHead, perHead, perHead] });
  }
  if (isNum(old.roomTwin)) {
    const half = cents(Number(old.roomTwin) / 2);
    costLines.push({ name: "Room or cabin (twin share)", basis: "per_traveller", amounts: [half, half, half] });
    notes.push(`twin room ${old.roomTwin} carried as ${half} per traveler`);
  }
  if (isNum(old.roomSingle)) notes.push(`single room ${old.roomSingle} not carried (no per-room basis): add it as a cost line if it applies`);
  if (isNum(old.commissionPerSeat)) notes.push(`fixed agency commission ${old.commissionPerSeat} per seat retired (agencies are paid from the pool)`);
  if (fees.some((f) => f == null)) notes.push("a band fee was blank");
  notes.push("selling prices to enter");
  return {
    tiers: LEGACY_BAND_TIERS.map((t) => ({ ...t })),
    costLines,
    commissionPct: DEFAULT_COMMISSION_PCT,
    notes,
  };
}

// ---------------------------------------------------------------- phase 7
// Removing a tier in the rate card editor. Its range is given to its
// neighbour, so the tiers still cover the same group sizes: removing 4–6 from
// 4–6 / 7–9 / 10–12 leaves 4–9 / 10–12, never a card that starts at 7. (It
// used to drop the range: removing the first two tiers left one tier, 10–12,
// with that tier's price and fee.) Cost-line amounts for the tier go with it.
export function removeTierAt(model, i) {
  const tiers = model.tiers || [];
  if (tiers.length < 2 || i < 0 || i >= tiers.length) return model;
  const gone = tiers[i];
  const next = tiers.filter((_, j) => j !== i).map((t) => ({ ...t }));
  if (i === 0) next[0].from = gone.from;
  else next[i - 1].to = gone.to;
  return {
    ...model,
    tiers: next,
    costLines: (model.costLines || []).map((l) => ({ ...l, amounts: (l.amounts || []).filter((_, j) => j !== i) })),
  };
}

// One price from a version with several tiers (the phase 6 single price, as
// it should have been built): the FIRST tier's price, operator fee and cost
// amounts, for group sizes from the product's GoAhead minimum to its maximum
// group. Every cost line is kept.
export function singlePriceFrom(version, { goaheadMin = 4, maxGroup = 8 } = {}) {
  const t0 = (version.tiers || [])[0] || {};
  return {
    tiers: [{
      from: Number(goaheadMin), to: Number(maxGroup),
      ...(isNum(t0.priceEur) ? { priceEur: Number(t0.priceEur) } : { priceEgp: isNum(t0.priceEgp) ? Number(t0.priceEgp) : null }),
      operatorFeePct: isNum(t0.operatorFeePct) ? Number(t0.operatorFeePct) : null,
    }],
    costLines: (version.costLines || []).map((l) => ({ name: l.name, basis: l.basis, amounts: [isNum(l.amounts?.[0]) ? Number(l.amounts[0]) : null] })),
    commissionPct: version.commissionPct,
  };
}

// A version's tiers priced in EUR: EGP ÷ the site-wide rate, rounded up to
// the whole euro (tierPriceEur). A tier already in EUR is left as it is.
export function eurTiersFrom(tiers, eurRate) {
  return (tiers || []).map((t) => {
    if (isNum(t.priceEur)) return { from: t.from, to: t.to, priceEur: Number(t.priceEur), operatorFeePct: t.operatorFeePct ?? null };
    return { from: t.from, to: t.to, priceEur: isNum(t.priceEgp) ? tierPriceEur(t.priceEgp, eurRate) : null, operatorFeePct: t.operatorFeePct ?? null };
  });
}
