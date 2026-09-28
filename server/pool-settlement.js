// The pricing and money model at work (model phase 5, behind catalogue_v2,
// migration 061). The arithmetic is shared/pool-model.js; this module feeds it
// a departure and records what it says, once, for everything that reports it:
// the operator statement, the agency statements, the margin report and
// Finance all read `catalogue_departure_economics`.
//
//   At booking      the booking keeps the published EUR rate in force, and is
//                   quoted the EUR price of the tier the departure is in
//   At the request  the payment request charges the EUR price of the tier the
//                   departure is in then (server/pay-at-goahead.js payerFor)
//   At the cut-off  the manifest is frozen (assignments.js); the tier is set
//                   by its headcount, and a departure that reached a cheaper
//                   tier refunds the difference to each paid traveler (with
//                   tab-manual, an ops task). Nobody is ever charged more.
//   When it is over the pool is shared: each agency-sold place earns the
//                   agency the pool per traveler (half for a late
//                   cancellation where a fee was kept); a direct place earns
//                   it for the collecting agent. A negative pool pays no agency, and
//                   The collecting agent pays the operator's shortfall.
//
// Records only: nothing here moves money. Finance pays from the statements.
import { pool, withTransaction } from "./db/index.js";
import { rateById, rateInForce, ratesFor, poolModelAvailable } from "./rates.js";
import { todayIn } from "./catalogue.js";
import {
  departureEconomics, operatorEntitlement, poolShares, bookingChargeEur, tierDifferenceEur, poolTierIndex, tierPriceEur, fxResult,
} from "../shared/pool-model.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));
const cents = (n) => Math.round(Number(n) * 100) / 100;
const DIRECT = "direct_customer";

export { poolModelAvailable };

async function departureRow(c, departureId) {
  return (await c.query(
    `SELECT cd.id, cd.status, cd.date, cd.legacy_departure_id, cd.rate_version_id, cd.product_id
       FROM catalogue_departures cd WHERE cd.id = $1`, [departureId])).rows[0] || null;
}

// The rate a departure is priced under: the version it was locked to at its
// first sale, else the one in force today.
export async function rateForDeparture(c, dep, now = Date.now()) {
  if (dep.rate_version_id != null) return rateById(c, Number(dep.rate_version_id));
  return rateInForce(await ratesFor(c, Number(dep.product_id)), todayIn(now));
}

async function liveSeats(c, legacyDepartureId) {
  return Number((await c.query(
    "SELECT COALESCE(SUM(seats), 0)::int AS n FROM pledges WHERE departure_id = $1 AND status <> 'cancelled'", [legacyDepartureId])).rows[0].n);
}

// The headcount the tier is set by: the manifest frozen at the cut-off, the
// live one before it.
export async function headcountFor(c, dep) {
  const frozen = (await c.query("SELECT seat_count, frozen_at FROM catalogue_manifests WHERE departure_id = $1", [dep.id])).rows[0];
  return frozen ? { headcount: Number(frozen.seat_count), frozenAt: frozen.frozen_at } : { headcount: await liveSeats(c, dep.legacy_departure_id), frozenAt: null };
}

// The places on the manifest at the cut-off, per booking, with what became of
// each: travelled; a late cancellation where a fee was kept (a cancellation
// refund that retained something, less whatever a resale returned); or none.
async function placesFor(c, dep, frozenAt) {
  const rows = (await c.query(
    `SELECT p.id, p.agency_id, p.seats, p.status, p.cancelled_at,
            (SELECT COALESCE(SUM(CASE WHEN f.kind = 'cancellation' THEN f.fee_retained_eur WHEN f.kind = 'resale' THEN -f.amount_eur ELSE 0 END), 0)
               FROM payment_refunds f WHERE f.pledge_id = p.id AND f.state <> 'cancelled') AS fee_kept
       FROM pledges p
      WHERE p.departure_id = $1
        AND (p.status <> 'cancelled' OR ($2::timestamptz IS NOT NULL AND p.cancelled_at >= $2::timestamptz))
      ORDER BY p.created_at, p.id`, [dep.legacy_departure_id, frozenAt])).rows;
  return rows.map((p) => ({
    pledgeId: p.id,
    agencyId: p.agency_id && p.agency_id !== DIRECT ? p.agency_id : null,
    count: Number(p.seats) || 0,
    outcome: p.status !== "cancelled" ? "travelled" : Number(p.fee_kept) > 0 ? "late_fee_kept" : "none",
  }));
}

// One departure's calculation, not recorded.
export async function departurePool(c, departureId, { now = Date.now() } = {}) {
  const dep = await departureRow(c, departureId);
  if (!dep) return null;
  const rate = await rateForDeparture(c, dep, now);
  const { headcount, frozenAt } = await headcountFor(c, dep);
  const economics = rate ? departureEconomics(rate, headcount) : { complete: false, missing: ["rate version"], headcount };
  const entitlement = rate ? operatorEntitlement(rate, headcount) : { complete: false, missing: ["rate version"], entitlement: null };
  const places = await placesFor(c, dep, frozenAt);
  const shares = poolShares(economics, places);
  return { departure: dep, rate, headcount, frozen: !!frozenAt, economics, entitlement, places, shares };
}

async function record(c, calc, stage) {
  await c.query(
    `INSERT INTO catalogue_departure_economics (departure_id, rate_version_id, stage, headcount, economics, places, shares, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (departure_id) DO UPDATE SET rate_version_id = EXCLUDED.rate_version_id, stage = EXCLUDED.stage,
       headcount = EXCLUDED.headcount, economics = EXCLUDED.economics, places = EXCLUDED.places, shares = EXCLUDED.shares, computed_at = now()`,
    [calc.departure.id, calc.rate?.id ?? null, stage, calc.headcount,
      JSON.stringify({ ...calc.economics, entitlementOnly: calc.entitlement }), JSON.stringify(calc.places), JSON.stringify(calc.shares)]);
}

export async function recordedEconomics(db, departureId) {
  const r = (await db.query("SELECT * FROM catalogue_departure_economics WHERE departure_id = $1", [departureId])).rows[0];
  return r ? {
    departureId: Number(r.departure_id), rateVersionId: num(r.rate_version_id), stage: r.stage, headcount: Number(r.headcount),
    economics: r.economics, places: r.places || [], shares: r.shares, computedAt: r.computed_at,
  } : null;
}

// ---------------------------------------------------------------- booking
// In the booking's own transaction, after the pledge exists (its insert
// trigger has locked the departure's rate version): the booking keeps the
// published EUR rate, and is quoted the EUR price of the tier the departure
// is in now, this booking included. A rate card without prices leaves the
// listing's price as it was.
export async function stampBookingPrice(c, { pledgeId, now = Date.now() }) {
  if (!(await poolModelAvailable(c))) return null;
  const p = (await c.query("SELECT seats, departure_id FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  const dep = p ? (await c.query(
    "SELECT id, status, date, legacy_departure_id, rate_version_id, product_id FROM catalogue_departures WHERE legacy_departure_id = $1",
    [p.departure_id])).rows[0] : null;
  if (!dep) return null;
  const rate = await rateForDeparture(c, dep, now);
  if (!rate?.eurRate) return null;
  const quote = bookingChargeEur({ rate, headcount: await liveSeats(c, dep.legacy_departure_id), seats: Number(p.seats), eurRate: rate.eurRate });
  if (!quote) {
    await c.query("UPDATE pledges SET published_eur_rate = $2 WHERE id = $1", [pledgeId, rate.eurRate]);
    return { eurRate: rate.eurRate, quote: null };
  }
  await c.query(
    "UPDATE pledges SET published_eur_rate = $2, price_per_person = $3, booking_total = $4 WHERE id = $1",
    [pledgeId, rate.eurRate, quote.eachEur, quote.totalEur]);
  return { eurRate: rate.eurRate, quote };
}

// What a booking is charged when its payment request goes out: its seats at
// the EUR price of the tier the departure is in now, at the rate the booking
// kept. null when the booking predates the model or the card has no prices
// (the caller then charges the booking's own total, as before).
export async function poolChargeFor(c, pledge, { now = Date.now() } = {}) {
  if (pledge.published_eur_rate == null) return null;
  const dep = (await c.query(
    "SELECT id, status, date, legacy_departure_id, rate_version_id, product_id FROM catalogue_departures WHERE legacy_departure_id = $1",
    [pledge.departure_id])).rows[0];
  if (!dep) return null;
  const rate = await rateForDeparture(c, dep, now);
  if (!rate) return null;
  const { headcount } = await headcountFor(c, dep);
  return bookingChargeEur({ rate, headcount, seats: Number(pledge.seats), eurRate: Number(pledge.published_eur_rate) });
}

// ---------------------------------------------------------------- cut-off
// The tier is fixed by the frozen headcount. Every paid request that paid for
// a dearer tier than that is refunded the difference, once.
async function refundTierDifferences(c, calc, { env = process.env } = {}) {
  if (!calc.rate?.tiers?.length) return 0;
  const tier = calc.rate.tiers[poolTierIndex(calc.rate.tiers, calc.headcount)];
  const paid = (await c.query(
    `SELECT r.*, p.seats, p.published_eur_rate FROM payment_requests r JOIN pledges p ON p.id = r.pledge_id
      WHERE r.departure_id = $1 AND r.state = 'paid' AND p.status <> 'cancelled' AND p.published_eur_rate IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM payment_refunds f WHERE f.request_id = r.id AND f.kind = 'tier_difference' AND f.state <> 'cancelled')`,
    [calc.departure.id])).rows;
  if (!paid.length) return 0;
  const { providerFor } = await import("./payment-providers/index.js");
  const { mapRefund, mapPayRequest } = await import("./pay-at-goahead.js");
  let made = 0;
  for (const r of paid) {
    const finalEach = tierPriceEur(tier.priceEgp, Number(r.published_eur_rate));
    const amount = tierDifferenceEur({ paidEur: Number(r.amount_eur), seats: Number(r.seats), finalEachEur: finalEach });
    if (!(amount > 0)) continue;
    const ins = (await c.query(
      `INSERT INTO payment_refunds (request_id, pledge_id, kind, paid_eur, retained_pct, fee_retained_eur, amount_eur, created_by)
       VALUES ($1, $2, 'tier_difference', $3, 0, 0, $4, 'system') RETURNING *`,
      [r.id, r.pledge_id, Number(r.amount_eur), amount])).rows[0];
    const out = await providerFor(r.provider).refund(c, { refund: mapRefund(ins), request: mapPayRequest(r), amountEur: amount, env });
    if (out?.done) {
      await c.query("UPDATE payment_refunds SET state = 'done', done_at = now(), done_by = $2, provider_reference = $3 WHERE id = $1",
        [ins.id, r.provider, out.providerReference]);
    }
    made += 1;
  }
  return made;
}

// ---------------------------------------------------------------- the shares
// Each agency booking's pool row, decided from the departure's final
// calculation. A departure that never went ahead earns nothing.
async function decidePoolRows(c, calc) {
  const ppt = calc.economics.complete && calc.economics.pool > 0 ? calc.economics.poolPerTraveller : 0;
  const byPledge = new Map(calc.places.map((p) => [p.pledgeId, p]));
  const rows = (await c.query(
    "SELECT * FROM agency_commissions WHERE departure_id = $1 AND basis = 'pool' AND state = 'pending' FOR UPDATE", [calc.departure.id])).rows;
  // A rate card without selling prices has no pool to share: the rows wait,
  // said so, rather than being decided at nothing.
  if (!calc.economics.complete) {
    await c.query(
      "UPDATE agency_commissions SET state_reason = $2 WHERE departure_id = $1 AND basis = 'pool' AND state = 'pending'",
      [calc.departure.id, `Waiting for the rate card: ${(calc.economics.missing || []).slice(0, 3).join(", ")}.`]);
    return 0;
  }
  let decided = 0;
  for (const r of rows) {
    const place = byPledge.get(r.pledge_id);
    const outcome = place?.outcome || "none";
    const factor = outcome === "travelled" ? 1 : outcome === "late_fee_kept" ? 0.5 : 0;
    // No positive pool: nothing to share, whatever the place's outcome.
    const state = ppt <= 0 || factor === 0 ? "void" : factor === 1 ? "earned" : "half";
    const reason = calc.economics.pool <= 0 ? "The pool was not positive: no agency share (the collecting agent paid the guarantee)."
      : outcome === "travelled" ? "Traveled: the pool per traveler."
      : outcome === "late_fee_kept" ? "Late cancellation with a fee kept: half the pool per traveler."
      : "Canceled without a fee kept, or not on the manifest at the cut-off.";
    const seats = place?.count ?? Number(r.seats);
    await c.query(
      `UPDATE agency_commissions SET state = $2, pool_per_traveller_egp = $3, share_factor = $4, earned_egp = $5,
              earned_eur = NULL, state_reason = $6, decided_at = now() WHERE pledge_id = $1`,
      [r.pledge_id, state, calc.economics.complete ? calc.economics.poolPerTraveller : null, factor, cents(seats * ppt * factor), reason]);
    decided += 1;
  }
  return decided;
}

async function voidNeverRan(c) {
  const r = await c.query(
    `UPDATE agency_commissions ac SET state = 'void', earned_egp = 0, share_factor = 0, decided_at = now(),
            state_reason = 'The departure didn''t go ahead.'
       FROM catalogue_departures cd
      WHERE cd.id = ac.departure_id AND ac.basis = 'pool' AND ac.state = 'pending' AND cd.status = 'cancelled_below_minimum'`);
  return r.rowCount;
}

// ---------------------------------------------------------------- the tick
// With the assignment tick, after manifests freeze.
export async function runPoolTick({ db = pool, now = Date.now(), env = process.env, log = () => {} } = {}) {
  if (!(await poolModelAvailable(db))) return {};
  const out = { poolCutoffs: 0, tierRefunds: 0, poolFinal: 0, poolRowsDecided: 0, poolRowsVoided: 0 };
  const atCutoff = (await db.query(
    `SELECT m.departure_id AS id FROM catalogue_manifests m
       LEFT JOIN catalogue_departure_economics e ON e.departure_id = m.departure_id
      WHERE e.departure_id IS NULL`)).rows;
  for (const { id } of atCutoff) {
    await inTx(db, async (c) => {
      const calc = await departurePool(c, Number(id), { now });
      await record(c, calc, "cutoff");
      out.tierRefunds += await refundTierDifferences(c, calc, { env });
      out.poolCutoffs += 1;
    });
  }
  const over = (await db.query(
    `SELECT cd.id FROM catalogue_departures cd
       LEFT JOIN catalogue_departure_economics e ON e.departure_id = cd.id
      WHERE cd.status = 'completed' AND (e.departure_id IS NULL OR e.stage = 'cutoff')`)).rows;
  for (const { id } of over) {
    await inTx(db, async (c) => {
      const calc = await departurePool(c, Number(id), { now });
      await record(c, calc, "final");
      out.poolRowsDecided += await decidePoolRows(c, calc);
      out.poolFinal += 1;
    });
  }
  out.poolRowsVoided = await voidNeverRan(db);
  if (out.poolCutoffs || out.poolFinal) log(`pool: ${out.poolCutoffs} at cut-off (${out.tierRefunds} tier refund${out.tierRefunds === 1 ? "" : "s"}), ${out.poolFinal} settled`);
  return out;
}

// ---------------------------------------------------------------- reports
// The EUR collected for a departure, net of refunds, each movement on its
// day, and the CBE rates for those days: the FX line's inputs.
export async function collectionsFor(c, departureId) {
  const day = (v) => todayIn(new Date(v).getTime());
  const movements = [];
  for (const r of (await c.query("SELECT amount_eur, paid_at FROM payment_requests WHERE departure_id = $1 AND state = 'paid'", [departureId])).rows) {
    movements.push({ amountEur: Number(r.amount_eur), day: day(r.paid_at), kind: "charge" });
  }
  for (const f of (await c.query(
    `SELECT f.amount_eur, COALESCE(f.done_at, f.created_at) AS at FROM payment_refunds f JOIN payment_requests r ON r.id = f.request_id
      WHERE r.departure_id = $1 AND f.state <> 'cancelled' AND f.amount_eur > 0`, [departureId])).rows) {
    movements.push({ amountEur: -Number(f.amount_eur), day: day(f.at), kind: "refund" });
  }
  const days = [...new Set(movements.map((m) => m.day))];
  const rates = new Map(days.length ? (await c.query(
    "SELECT day, egp_per_eur FROM fx_rates WHERE day = ANY($1::date[])", [days])).rows.map((r) => [ymd(r.day), Number(r.egp_per_eur)]) : []);
  return { movements, rates };
}

// Payment costs (the provider's fee setting), in EUR, on the charges: they
// come out of the collecting agent's commission.
async function paymentCostsEur(c, movements) {
  const fees = (await c.query("SELECT value FROM finance_settings WHERE key = 'payment_fees'")).rows[0]?.value || null;
  if (!fees) return { eur: null, fees: null };
  const eur = cents(movements.filter((m) => m.kind === "charge")
    .reduce((s, m) => s + m.amountEur * (Number(fees.percent) / 100) + Number(fees.fixedEur || 0), 0));
  return { eur, fees };
}

// One departure, every line of the one calculation, for the operator
// statement, the margin report and Finance. The collecting agent's result (EGP):
// commission + its pool − the guarantee − payment costs + the FX line.
export async function departureMoney(c, departureId, { now = Date.now() } = {}) {
  const recorded = await recordedEconomics(c, departureId);
  const calc = recorded
    ? { economics: recorded.economics, shares: recorded.shares, headcount: recorded.headcount, stage: recorded.stage, places: recorded.places }
    : await departurePool(c, departureId, { now }).then((x) => x && ({ ...x, economics: { ...x.economics, entitlementOnly: x.entitlement }, stage: "live" }));
  if (!calc) return null;
  const e = calc.economics;
  const { movements, rates } = await collectionsFor(c, departureId);
  const fx = fxResult({ movements, rates, revenueEgp: e.complete ? e.revenue : null });
  const costs = await paymentCostsEur(c, movements);
  // Payment costs are charged in EUR: converted at each charge's day's rate.
  // No fee setting: 0, flagged (paymentFeesSet), as the margin report did.
  const costsEgp = costs.eur == null ? 0 : (() => {
    const charges = movements.filter((m) => m.kind === "charge");
    const total = charges.reduce((s, m) => s + m.amountEur, 0);
    if (!charges.length) return 0;
    if (charges.some((m) => !rates.get(m.day))) return null;
    return cents(charges.reduce((s, m) => s + costs.eur * (m.amountEur / total) * rates.get(m.day), 0));
  })();
  const oe = calc.shares?.onlineEra || null;
  const onlineEraEgp = e.complete && oe && fx.fxEgp != null && costsEgp != null ? cents(oe.total - costsEgp + fx.fxEgp) : null;
  return {
    stage: calc.stage, headcount: calc.headcount, complete: !!e.complete, missing: e.missing || [],
    lines: e.complete ? {
      tier: e.tier, priceEgp: e.priceEgp, revenue: e.revenue, operatingCost: e.operatingCost, costLines: e.costLines,
      operatorFeePct: e.operatorFeePct, operatorFee: e.operatorFee, entitlement: e.entitlement,
      commissionPct: e.commissionPct, commission: e.commission, pool: e.pool, poolPerTraveller: e.poolPerTraveller, guarantee: e.guarantee,
    } : null,
    entitlement: e.entitlementOnly?.entitlement ?? e.entitlement ?? null,
    shares: calc.shares, places: calc.places,
    onlineEra: oe ? { ...oe, paymentCostsEgp: costsEgp, fxEgp: fx.fxEgp, resultEgp: onlineEraEgp } : null,
    fx: { ...fx, rule: "each EUR movement at the CBE rate on its day, less the nominal EGP revenue" },
    paymentFeesSet: costs.fees != null,
  };
}
