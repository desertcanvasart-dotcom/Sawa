// Agency commission and billing (model phase 3), catalog departures only,
// behind catalogue_v2. Records and statements: nothing here pays anyone.
//
// Phase 5 (migration 061) replaces the fixed per-seat commission with the
// pool (shared/pool-model.js, server/pool-settlement.js): an agency booking's
// row is `basis = 'pool'`, decided when the departure is over from the
// departure's calculation, in EGP; the monthly statement pays it in EUR at
// the CBE rate on the statement date. An agency on billing pays the full EUR
// price. Rows made before 061 keep the per-seat rules below.
//
//   At booking     the commission per seat (EUR) is locked from the rate
//                  version in force for the departure; an agency approved for
//                  billing is invoiced the published price less commission.
//   When decided   earned in full when the traveler travels; 50% on a late
//                  cancellation where Sawa keeps a fee; nothing if the
//                  departure doesn't reach GoAhead.
//   Monthly        a statement per agency for the previous month, sent by the
//                  10th; Egyptian agencies see EGP at the rate on the statement
//                  date (Admin → Finance → Exchange rates).
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { todayIn } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import { zonedDateTimeToUtc } from "./tz.js";
import { shiftDate } from "../shared/catalogue.js";
import { commissionOutcome, commissionStatementTotals } from "../shared/settlement-rules.js";
import { poolStatementEur } from "../shared/pool-model.js";

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
const EGYPT = "EG";

export const mapCommission = (r) => ({
  pledgeId: r.pledge_id, agencyId: r.agency_id, departureId: Number(r.departure_id),
  rateVersionId: r.rate_version_id == null ? null : Number(r.rate_version_id), seats: Number(r.seats),
  perSeatEur: num(r.per_seat_eur), amountEur: num(r.amount_eur), state: r.state, earnedEur: num(r.earned_eur),
  stateReason: r.state_reason, lockedAt: r.locked_at, decidedAt: r.decided_at,
  statementId: r.statement_id == null ? null : Number(r.statement_id),
  // Phase 5 (061): pool shares, in EGP.
  basis: r.basis || "per_seat", earnedEgp: num(r.earned_egp), poolPerTravellerEgp: num(r.pool_per_traveller_egp), shareFactor: num(r.share_factor),
});

// Called in the booking's own transaction, after the pledge row exists (its
// insert trigger has locked the departure's rate version).
export async function recordAgencyBooking(c, { pledgeId, agency, catalogueDepartureId, now = Date.now() }) {
  if (!agency?.id || agency.id === "direct_customer") return null;
  const { poolModelAvailable } = await import("./pool-settlement.js");
  if (await poolModelAvailable(c)) return recordPoolBooking(c, { pledgeId, agency, catalogueDepartureId });
  const p = (await c.query("SELECT seats, booking_total FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  const dep = (await c.query(
    `SELECT cd.rate_version_id, rv.commission_per_seat FROM catalogue_departures cd
       LEFT JOIN catalogue_rate_versions rv ON rv.id = cd.rate_version_id WHERE cd.id = $1`, [catalogueDepartureId])).rows[0];
  const seats = Number(p.seats);
  const perSeat = dep?.commission_per_seat == null ? null : Number(dep.commission_per_seat);
  const amount = perSeat == null ? null : round2(perSeat * seats);
  await c.query(
    `INSERT INTO agency_commissions (pledge_id, agency_id, departure_id, rate_version_id, seats, per_seat_eur, amount_eur, state_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (pledge_id) DO NOTHING`,
    [pledgeId, agency.id, catalogueDepartureId, dep?.rate_version_id ?? null, seats, perSeat, amount,
      perSeat == null ? "No agency commission on the rate card for this product yet." : null]);
  let invoice = null;
  if (agency.billing_approved === true) {
    const gross = round2(Number(p.booking_total) || 0);
    const commission = amount || 0;
    // Pay at GoAhead (phase 4): every catalog booking under the flag is on it,
    // so the invoice is due at the payment deadline after GoAhead, and has no
    // due date until then (server/pay-at-goahead.js dates it).
    const payAtGoAhead = (await c.query("SELECT payment_mode FROM pledges WHERE id = $1", [pledgeId])).rows[0]?.payment_mode === "pay_at_goahead";
    const dueOn = payAtGoAhead ? null : shiftDate(todayIn(now), Number(agency.billing_due_days ?? 14));
    const r = await c.query(
      `INSERT INTO agency_invoices (pledge_id, agency_id, departure_id, gross_eur, commission_eur, amount_eur, due_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pledge_id) DO NOTHING RETURNING *`,
      [pledgeId, agency.id, catalogueDepartureId, gross, commission, round2(gross - commission), dueOn]);
    invoice = r.rows[0] || null;
  }
  return { perSeatEur: perSeat, amountEur: amount, invoice };
}

// Phase 5: the agency's row waits for the departure's pool; an agency on
// billing is invoiced the full EUR price (priced again when its payment
// request goes out, at the tier the departure is in then).
async function recordPoolBooking(c, { pledgeId, agency, catalogueDepartureId }) {
  const p = (await c.query("SELECT seats, booking_total, payment_mode FROM pledges WHERE id = $1", [pledgeId])).rows[0];
  await c.query(
    `INSERT INTO agency_commissions (pledge_id, agency_id, departure_id, rate_version_id, seats, basis, state_reason)
     VALUES ($1, $2, $3, $4, $5, 'pool', $6) ON CONFLICT (pledge_id) DO NOTHING`,
    [pledgeId, agency.id, catalogueDepartureId, null, Number(p.seats),
      "Paid from the departure's pool once it is over."]);
  let invoice = null;
  if (agency.billing_approved === true) {
    const gross = round2(Number(p.booking_total) || 0);
    const r = await c.query(
      `INSERT INTO agency_invoices (pledge_id, agency_id, departure_id, gross_eur, commission_eur, amount_eur, due_on)
       VALUES ($1, $2, $3, $4, 0, $4, $5) ON CONFLICT (pledge_id) DO NOTHING RETURNING *`,
      [pledgeId, agency.id, catalogueDepartureId, gross, p.payment_mode === "pay_at_goahead" ? null : shiftDate(todayIn(), Number(agency.billing_due_days ?? 14))]);
    invoice = r.rows[0] || null;
  }
  return { basis: "pool", invoice };
}

// Decide every pending commission whose departure or booking is settled.
// Pool rows (phase 5) are decided by server/pool-settlement.js.
export async function decideCommissions({ db = pool, now = Date.now(), log = () => {} } = {}) {
  const rows = (await db.query(
    `SELECT ac.*, cd.status AS dep_status, cd.date, c.type, t.default_time,
            p.status AS pledge_status, p.cancelled_reason, p.cancelled_at, p.payment_mode,
            (SELECT MIN(created_at) FROM catalogue_events e WHERE e.departure_id = cd.id AND e.type = 'go_ahead') AS go_ahead_at,
            EXISTS (SELECT 1 FROM payment_requests r WHERE r.pledge_id = p.id AND r.state = 'paid') AS paid,
            (SELECT COALESCE(SUM(CASE WHEN f.kind = 'cancellation' THEN f.fee_retained_eur ELSE -f.amount_eur END), 0)
               FROM payment_refunds f WHERE f.pledge_id = p.id AND f.state <> 'cancelled') AS fee_kept
       FROM agency_commissions ac
       JOIN catalogue_departures cd ON cd.id = ac.departure_id
       JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
       JOIN pledges p ON p.id = ac.pledge_id
      WHERE ac.state = 'pending' ${await hasBasis(db) ? "AND ac.basis = 'per_seat'" : ""}`)).rows;
  let decided = 0;
  for (const r of rows) {
    const outcome = commissionOutcome({
      departureStatus: r.dep_status, reachedGoAhead: r.go_ahead_at != null || r.dep_status === "go_ahead" || r.dep_status === "completed",
      pledgeStatus: r.pledge_status, cancelledReason: r.cancelled_reason,
      cancelledAtMs: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
      goAheadAtMs: r.go_ahead_at ? new Date(r.go_ahead_at).getTime() : null,
      startMs: zonedDateTimeToUtc(ymd(r.date), String(r.default_time || "08:00").slice(0, 5)), productType: r.type,
      payAtGoAhead: r.payment_mode === "pay_at_goahead", paid: r.paid === true, feeKept: Number(r.fee_kept) > 0,
    });
    if (!outcome) continue;
    const earned = r.amount_eur == null ? null : round2(Number(r.amount_eur) * outcome.share);
    const upd = await db.query(
      `UPDATE agency_commissions SET state = $2, earned_eur = $3, state_reason = $4, decided_at = now()
        WHERE pledge_id = $1 AND state = 'pending'`, [r.pledge_id, outcome.state, earned, outcome.reason]);
    if (!upd.rowCount) continue;
    decided += 1;
    if (outcome.state === "void") {
      await db.query(
        "UPDATE agency_invoices SET state = 'void', void_reason = $2 WHERE pledge_id = $1 AND state = 'due'",
        [r.pledge_id, outcome.reason]);
    }
  }
  if (decided) log(`commissions: ${decided} decided`);
  return { decided };
}

async function hasBasis(db) {
  return (await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_commissions' AND column_name = 'basis'")).rowCount > 0;
}

const previousMonth = (today) => {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const monthEnd = (period) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export async function rateOn(db, day) {
  const r = (await db.query("SELECT egp_per_eur FROM fx_rates WHERE day = $1 AND status = 'approved'", [day])).rows[0];
  return r ? Number(r.egp_per_eur) : null;
}

// Build (or rebuild, while not sent) an agency's statement for a period, from
// the commissions on departures dated in that month.
export async function buildCommissionStatement(db, agencyId, period, { now = Date.now() } = {}) {
  return inTx(db, async (c) => {
    const agency = (await c.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0];
    const existing = (await c.query("SELECT * FROM commission_statements WHERE agency_id = $1 AND period = $2 FOR UPDATE", [agencyId, period])).rows[0];
    if (existing && existing.state !== "draft") return existing;
    const lines = (await c.query(
      `SELECT ac.*, cd.date, c.code, c.title, p.customers, p.booking_code
         FROM agency_commissions ac
         JOIN catalogue_departures cd ON cd.id = ac.departure_id
         JOIN catalogue_products c ON c.id = cd.product_id
         JOIN pledges p ON p.id = ac.pledge_id
        WHERE ac.agency_id = $1 AND cd.date BETWEEN $2 AND $3
        ORDER BY cd.date, ac.pledge_id`, [agencyId, `${period}-01`, monthEnd(period)])).rows.map((r) => ({
      pledgeId: r.pledge_id, booking: r.booking_code || String(r.pledge_id).slice(-8), client: r.customers,
      date: ymd(r.date), product: `${r.code} ${r.title}`, seats: Number(r.seats), perSeatEur: num(r.per_seat_eur),
      amountEur: num(r.amount_eur), status: r.state, earnedEur: r.state === "pending" ? 0 : (num(r.earned_eur) ?? 0), note: r.state_reason,
      basis: r.basis || "per_seat", departureId: Number(r.departure_id),
      ...(r.basis === "pool" ? { earnedEgp: r.state === "pending" ? 0 : (num(r.earned_egp) ?? 0), poolPerTravellerEgp: num(r.pool_per_traveller_egp), shareFactor: num(r.share_factor) } : {}),
    }));
    if (!lines.length) return null;
    if (lines.some((l) => l.basis === "pool")) return writePoolStatement(c, { agencyId, period, existing, lines, now });
    const egp = String(agency.country_code || "").toUpperCase() === EGYPT;
    const fxDay = todayIn(now);
    const rate = egp ? await rateOn(c, fxDay) : null;
    const totals = commissionStatementTotals(lines, rate);
    const hold = egp && rate == null ? `No EGP rate for ${fxDay} yet: enter it in Admin → Finance → Exchange rates.`
      : lines.some((l) => l.status === "pending") ? "Some seats are not decided yet." : null;
    const vals = [agencyId, period, egp ? "EGP" : "EUR", totals.totalEur, egp ? fxDay : null, rate, totals.totalEgp, JSON.stringify(lines), hold];
    const row = existing
      ? (await c.query(
        `UPDATE commission_statements SET currency = $3, total_eur = $4, fx_day = $5, egp_per_eur = $6, total_egp = $7, lines = $8, hold_reason = $9
          WHERE agency_id = $1 AND period = $2 RETURNING *`, vals)).rows[0]
      : (await c.query(
        `INSERT INTO commission_statements (agency_id, period, currency, total_eur, fx_day, egp_per_eur, total_egp, lines, hold_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, vals)).rows[0];
    await c.query(
      `UPDATE agency_commissions ac SET statement_id = $3 FROM catalogue_departures cd
        WHERE ac.departure_id = cd.id AND ac.agency_id = $1 AND cd.date BETWEEN $2 AND $4`,
      [agencyId, `${period}-01`, row.id, monthEnd(period)]);
    return row;
  });
}

// Phase 5: an agency's pool shares for the month. They add up in EGP and are
// paid in EUR at the CBE rate on the statement date. The statement shows, for
// each departure, the whole calculation (revenue, operating cost, operator
// fee, entitlement, agent commission, pool, pool per traveler), so every
// share can be checked; and, where the agency also operated the departure,
// that its operator entitlement is on its operator statement.
async function writePoolStatement(c, { agencyId, period, existing, lines, now }) {
  const depIds = [...new Set(lines.map((l) => l.departureId))];
  const econ = new Map((await c.query(
    "SELECT departure_id, stage, headcount, economics FROM catalogue_departure_economics WHERE departure_id = ANY($1::bigint[])", [depIds])).rows
    .map((r) => [Number(r.departure_id), r]));
  const operated = new Set((await c.query(
    `SELECT a.departure_id FROM catalogue_assignments a JOIN operators o ON o.id = a.operator_id
      WHERE a.departure_id = ANY($1::bigint[]) AND a.state = 'acknowledged' AND o.agency_id = $2`, [depIds, agencyId])).rows.map((r) => Number(r.departure_id)));
  const departures = depIds.map((id) => {
    const r = econ.get(id);
    const e = r?.economics || {};
    const mine = lines.filter((l) => l.departureId === id);
    return {
      departureId: id, date: mine[0].date, product: mine[0].product, stage: r?.stage || null, headcount: r ? Number(r.headcount) : null,
      calculation: e.complete ? {
        tier: e.tier, revenue: e.revenue, operatingCost: e.operatingCost, operatorFeePct: e.operatorFeePct, operatorFeeOverride: e.feeOverride != null, operatorFee: e.operatorFee,
        entitlement: e.entitlement, commissionPct: e.commissionPct, commission: e.commission, pool: e.pool, poolPerTraveller: e.poolPerTraveller,
      } : null,
      places: mine.reduce((n, l) => n + l.seats, 0),
      shareEgp: round2(mine.reduce((n, l) => n + (l.earnedEgp ?? 0), 0)),
      youOperated: operated.has(id),
      ...(operated.has(id) ? { operatorNote: `Your agency also operated this departure: its operator entitlement (EGP ${e.entitlement ?? "—"}) is paid on your operator statement, separately from this pool share.` } : {}),
    };
  });
  const fxDay = todayIn(now);
  const rate = await rateOn(c, fxDay);
  const totalEgp = round2(lines.reduce((n, l) => n + (l.earnedEgp ?? 0), 0));
  const perSeatEur = round2(lines.filter((l) => l.basis !== "pool").reduce((n, l) => n + (l.earnedEur || 0), 0));
  const poolEur = poolStatementEur(totalEgp, rate);
  const unpriced = departures.filter((d) => d.stage === "final" && !d.calculation && lines.some((l) => l.departureId === d.departureId && l.status === "pending"));
  const hold = rate == null ? `No CBE rate for ${fxDay} yet: enter it in Admin → Finance → Exchange rates. Pool shares are paid in EUR at the statement date's rate.`
    : unpriced.length ? `The rate card has no selling prices for ${unpriced.map((d) => `${d.product} on ${d.date}`).join(", ")}, so there is no pool to share yet.`
    : lines.some((l) => l.status === "pending") ? "Some departures are not over yet." : null;
  const totalEur = poolEur == null ? perSeatEur : round2(perSeatEur + poolEur);
  // Each line carries its departure's calculation (mapStatement lists each once).
  const withDeparture = lines.map((l) => ({ ...l, departure: departures.find((d) => d.departureId === l.departureId) }));
  const vals = [agencyId, period, "EUR", totalEur, fxDay, rate, totalEgp, JSON.stringify(withDeparture), hold];
  const row = existing
    ? (await c.query(
      `UPDATE commission_statements SET currency = $3, total_eur = $4, fx_day = $5, egp_per_eur = $6, total_egp = $7, lines = $8, hold_reason = $9, basis = 'pool'
        WHERE agency_id = $1 AND period = $2 RETURNING *`, vals)).rows[0]
    : (await c.query(
      `INSERT INTO commission_statements (agency_id, period, currency, total_eur, fx_day, egp_per_eur, total_egp, lines, hold_reason, basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pool') RETURNING *`, vals)).rows[0];
  await c.query(
    `UPDATE agency_commissions ac SET statement_id = $3 FROM catalogue_departures cd
      WHERE ac.departure_id = cd.id AND ac.agency_id = $1 AND cd.date BETWEEN $2 AND $4`,
    [agencyId, `${period}-01`, row.id, monthEnd(period)]);
  return row;
}

export const mapStatement = (r) => ({
  id: Number(r.id), agencyId: r.agency_id, period: r.period, state: r.state, currency: r.currency,
  totalEur: num(r.total_eur), fxDay: ymd(r.fx_day), egpPerEur: num(r.egp_per_eur), totalEgp: num(r.total_egp),
  lines: r.lines || [], holdReason: r.hold_reason, createdAt: r.created_at, sentAt: r.sent_at, emailedTo: r.emailed_to, paidAt: r.paid_at,
  basis: r.basis || "per_seat",
  // Phase 5: each departure once, with its calculation.
  departures: [...new Map((r.lines || []).filter((l) => l.departure).map((l) => [l.departure.departureId, l.departure])).values()],
});

// Daily: for the previous month, build each agency's statement and send it
// (by the 10th). A statement waiting on an EGP rate or undecided seats is held
// and retried next day.
export async function runCommissionStatements({ db = pool, now = Date.now(), send = null, env = process.env, log = () => {} } = {}) {
  if (!catalogueV2Enabled(env)) return { skipped: "catalogue_v2 is off" };
  const period = previousMonth(todayIn(now));
  const agencies = (await db.query(
    `SELECT DISTINCT ac.agency_id FROM agency_commissions ac JOIN catalogue_departures cd ON cd.id = ac.departure_id
      WHERE cd.date BETWEEN $1 AND $2`, [`${period}-01`, monthEnd(period)])).rows;
  const out = { built: 0, sent: 0, held: 0 };
  for (const { agency_id: agencyId } of agencies) {
    const st = await buildCommissionStatement(db, agencyId, period, { now });
    if (!st || st.state !== "draft") continue;
    out.built += 1;
    if (st.hold_reason) { out.held += 1; continue; }
    const owners = (await db.query(
      "SELECT email FROM app_users WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' ORDER BY created_at", [agencyId])).rows;
    const agency = (await db.query("SELECT name FROM agencies WHERE id = $1", [agencyId])).rows[0];
    const s = mapStatement(st);
    const totalLabel = s.basis === "pool" ? `EUR ${s.totalEur.toLocaleString("en-US")} (EGP ${s.totalEgp.toLocaleString("en-US")} at ${s.egpPerEur} EGP per EUR, the CBE rate on ${s.fxDay})`
      : s.currency === "EGP" ? `EGP ${s.totalEgp.toLocaleString("en-US")} (EUR ${s.totalEur.toLocaleString("en-US")} at ${s.egpPerEur})`
      : `EUR ${s.totalEur.toLocaleString("en-US")}`;
    if (send) {
      const { commissionStatementEmail } = await import("./email.js");
      for (const o of owners) {
        await send(commissionStatementEmail({
          to: o.email, agencyName: agency?.name || agencyId, period, totalLabel,
          seats: s.lines.reduce((n, l) => n + l.seats, 0), portalUrl: `${site()}/agency`, pool: s.basis === "pool",
        })).catch((e) => log(`commission statement email to ${o.email} failed: ${e.message}`));
      }
    }
    await db.query(
      "UPDATE commission_statements SET state = 'sent', sent_at = now(), emailed_to = $2 WHERE id = $1 AND state = 'draft'",
      [st.id, owners.map((o) => o.email).join(", ") || null]);
    out.sent += 1;
  }
  if (out.built) log(`commission statements for ${period}: ${out.sent} sent, ${out.held} held`);
  return out;
}

export { previousMonth, monthEnd };
