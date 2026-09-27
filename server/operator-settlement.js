// Operator settlement (model phase 3), catalog departures only, behind
// catalogue_v2. EGP, from the locked rate version: no conversion.
//
//   Advance     50% of the expected amount when the operator acknowledges,
//               due 2 Egyptian business days later (Sun–Thu, not a holiday).
//   Balance     after the departure completes: the final amount from the
//               frozen manifest (late cancellations and no-shows count, as in
//               phase 2), less penalties and service-failure deductions
//               (capped at the operator amount), plus force-majeure
//               reimbursements, less the advance. Due 7 days after the end.
//   Statement   per departure: draft → sent → accepted (automatically 30 days
//               after sending) or disputed → resolved.
//
// Records only: finance pays by bank transfer and records it (finance.js).
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { expectedAmountFor } from "./assignments.js";
import { notifyOperator, operatorRecipients } from "./operators.js";
import { applySetoffs, releaseSetoffs, syncBalanceReceivable, createReceivable, setoffLines } from "./receivables.js";
import { shiftDate } from "../shared/catalogue.js";
import { rateFieldsFor } from "../shared/operators.js";
import {
  advanceFor, operatorBalance, deductionRoom, egyptBusinessDaysAfter, balanceDueOn, statementAutoAcceptAt, collectionsDistribution,
} from "../shared/settlement-rules.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
const DEDUCTIONS = ["penalty", "service_failure"];

export async function holidaySet(db) {
  return new Set((await db.query("SELECT day FROM egypt_holidays")).rows.map((r) => ymd(r.day)));
}

export const mapPayable = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), operatorId: Number(r.operator_id),
  assignmentId: r.assignment_id == null ? null : Number(r.assignment_id), kind: r.kind, currency: r.currency,
  amount: num(r.amount), dueOn: ymd(r.due_on), state: r.state, holdReason: r.hold_reason, detail: r.detail || {},
  setoffEgp: num(r.setoff_egp) || 0,
  // What is left to transfer after set-off (Operator 9.4).
  netDue: r.amount == null ? null : Math.max(0, round2(Number(r.amount) - Number(r.setoff_egp || 0))),
  createdAt: r.created_at, paidAt: r.paid_at,
});

export const mapAdjustment = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), operatorId: Number(r.operator_id), kind: r.kind,
  penaltyCode: r.penalty_code, amountEgp: num(r.amount_egp), reason: r.reason, clauseRef: r.clause_ref,
  evidence: r.evidence || [], costLineIds: r.cost_line_ids || [], createdBy: r.created_by, createdAt: r.created_at,
  voidedAt: r.voided_at, voidedBy: r.voided_by, voidReason: r.void_reason,
});

// ---------------------------------------------------------------- advance
// In the acknowledgement's own transaction (assignments.js acknowledge).
export async function createAdvance(c, { assignment, now = Date.now() }) {
  const expected = await expectedAmountFor(c, assignment.departureId);
  const amount = advanceFor(expected.total);
  const dueOn = egyptBusinessDaysAfter(todayIn(now), 2, await holidaySet(c));
  const hold = amount == null ? `The rate card has no ${expected.missing.join(", ") || "amount"} for this product yet.` : null;
  const r = await c.query(
    `INSERT INTO operator_payables (departure_id, operator_id, assignment_id, kind, amount, due_on, state, hold_reason, detail)
     VALUES ($1, $2, $3, 'advance', $4, $5, $6, $7, $8)
     ON CONFLICT (assignment_id) WHERE kind = 'advance' DO NOTHING RETURNING *`,
    [assignment.departureId, assignment.operatorId, assignment.id, amount, dueOn, hold ? "on_hold" : "due", hold,
      JSON.stringify({ expectedTotal: expected.total, travelers: expected.travelers, band: expected.band, rateVersion: expected.rateVersion })]);
  if (!r.rows[0]) return null;
  // What the operator owes Sawa comes off this advance first (9.4).
  await applySetoffs(c, Number(r.rows[0].id));
  return mapPayable((await c.query("SELECT * FROM operator_payables WHERE id = $1", [r.rows[0].id])).rows[0]);
}

// Advances held for a missing rate are priced once the rate exists; advances
// of an assignment that was replaced, and not paid, are canceled.
export async function tidyAdvances(db) {
  const held = (await db.query("SELECT * FROM operator_payables WHERE kind = 'advance' AND state = 'on_hold'")).rows;
  let priced = 0;
  for (const p of held) {
    const expected = await expectedAmountFor(db, Number(p.departure_id));
    const amount = advanceFor(expected.total);
    if (amount == null) continue;
    await inTx(db, async (c) => {
      await c.query(
        `UPDATE operator_payables SET amount = $2, state = 'due', hold_reason = NULL, updated_at = now(),
                detail = detail || $3::jsonb WHERE id = $1 AND state = 'on_hold'`,
        [p.id, amount, JSON.stringify({ expectedTotal: expected.total, pricedLater: true })]);
      await applySetoffs(c, Number(p.id));
    });
    priced += 1;
  }
  const stale = (await db.query(
    `SELECT p.id FROM operator_payables p JOIN catalogue_assignments a ON a.id = p.assignment_id
      WHERE p.kind = 'advance' AND p.state IN ('due', 'on_hold') AND a.state IN ('replaced', 'expired')`)).rows;
  for (const { id } of stale) await inTx(db, (c) => cancelUnpaidAdvance(c, Number(id)));
  return { advancesPriced: priced, advancesCancelled: stale.length };
}

// An unpaid advance whose assignment is gone: any set-off on it goes back to
// the receivable, and the advance is canceled.
async function cancelUnpaidAdvance(c, payableId) {
  await releaseSetoffs(c, payableId);
  await c.query(
    `UPDATE operator_payables SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'Assignment replaced before payment.', updated_at = now()
      WHERE id = $1 AND state IN ('due', 'on_hold')`, [payableId]);
}

// ---------------------------------------------------------------- reassignment
// A departure is taken from an operator whose advance was already paid (or
// fully set off). Admin says why (decided 27 Sep 2026):
//   operator_fault      it canceled or didn't acknowledge: the whole advance
//                       becomes a receivable; a Schedule 6 penalty, if chosen,
//                       is a separate adjustment and receivable
//   not_operator_fault  Sawa or force majeure: the operator keeps its evidenced
//                       non-refundable costs (approved cost-sheet lines); the
//                       rest of the advance becomes a receivable
// An unpaid advance is simply canceled. The new operator gets its own advance
// on acknowledgement, as normal.
export const REASSIGN_REASONS = ["operator_fault", "not_operator_fault"];

export async function paidAdvanceOf(c, assignmentId) {
  return (await c.query(
    "SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance' AND state IN ('paid', 'offset')", [assignmentId])).rows[0] || null;
}

export async function settleReplacedAdvance(c, { replaced, reason, penaltyCode = null, travelers = null, keptEgp = null, costLineIds = [], note = null, by }) {
  const unpaid = (await c.query(
    "SELECT id FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance' AND state IN ('due', 'on_hold')", [replaced.id])).rows[0];
  if (unpaid) await cancelUnpaidAdvance(c, Number(unpaid.id));
  const adv = await paidAdvanceOf(c, replaced.id);
  if (!adv) return { receivables: [], adjustments: [] };
  if (!REASSIGN_REASONS.includes(reason)) {
    throw Object.assign(new CatalogueError(409, "This operator's advance has been paid. Say why the departure is being reassigned: the operator's fault, or not."), { code: "reason_required" });
  }
  const operatorId = Number(replaced.operator_id);
  const departureId = Number(replaced.departure_id);
  const advance = Number(adv.amount);
  const out = { receivables: [], adjustments: [] };
  await c.query("UPDATE catalogue_assignments SET replaced_reason = $2 WHERE id = $1", [replaced.id, reason]);
  const why = note ? ` ${String(note).trim().slice(0, 500)}` : "";
  if (reason === "operator_fault") {
    out.receivables.push(await createReceivable(c, {
      operatorId, departureId, source: "reassignment_advance", amountEgp: advance, by, clauseRef: "Operator 9.4; 11",
      reason: `Advance repayable: the departure was reassigned through the operator's fault.${why}`,
    }));
    if (penaltyCode) {
      const rate = (await c.query("SELECT * FROM operator_penalty_rates WHERE code = $1", [penaltyCode])).rows[0];
      if (!rate) throw new CatalogueError(422, "Choose the penalty from Schedule 6.");
      const amount = round2(Number(rate.amount_egp) * (rate.per_traveler ? Math.max(1, Number(travelers) || 1) : 1));
      const a = (await c.query(
        `INSERT INTO operator_adjustments (departure_id, operator_id, kind, penalty_code, amount_egp, reason, clause_ref, created_by)
         VALUES ($1, $2, 'penalty', $3, $4, $5, $6, $7) RETURNING *`,
        [departureId, operatorId, penaltyCode, amount, `${rate.label}.${why}`, rate.clause_ref, by])).rows[0];
      out.adjustments.push(mapAdjustment(a));
      const pr = await createReceivable(c, {
        operatorId, departureId, source: "penalty", amountEgp: amount, sourceAdjustmentId: Number(a.id), by, clauseRef: rate.clause_ref,
        reason: `Penalty: ${rate.label}.`,
      });
      if (pr) out.receivables.push(pr);
    }
  } else {
    const kept = round2(Number(keptEgp) || 0);
    if (kept < 0 || kept > advance) throw new CatalogueError(422, `The costs kept must be between EGP 0 and the advance (EGP ${advance}).`);
    if (kept > 0) {
      const ids = [...new Set((costLineIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      const legacy = (await c.query("SELECT legacy_departure_id FROM catalogue_departures WHERE id = $1", [departureId])).rows[0]?.legacy_departure_id;
      const ok = ids.length ? (await c.query(
        "SELECT COUNT(*)::int AS n FROM departure_costs WHERE id = ANY($1::bigint[]) AND departure_id = $2 AND state = 'approved'", [ids, legacy])).rows[0].n : 0;
      if (!ids.length || ok !== ids.length) {
        throw new CatalogueError(422, "Costs the operator keeps must be evidenced: point to approved lines on this departure's cost sheet, with their receipts.");
      }
      const a = (await c.query(
        `INSERT INTO operator_adjustments (departure_id, operator_id, kind, amount_egp, reason, clause_ref, cost_line_ids, created_by)
         VALUES ($1, $2, 'reimbursement', $3, $4, 'Operator 14', $5, $6) RETURNING *`,
        [departureId, operatorId, kept, `Evidenced non-refundable costs kept from the advance; the departure was reassigned through no fault of the operator.${why}`,
          JSON.stringify(ids), by])).rows[0];
      out.adjustments.push(mapAdjustment(a));
    }
    const rest = round2(advance - kept);
    if (rest > 0) {
      out.receivables.push(await createReceivable(c, {
        operatorId, departureId, source: "reassignment_advance", amountEgp: rest, by, clauseRef: "Operator 9.4; 14",
        reason: `Advance repayable, less evidenced costs of EGP ${kept}: the departure was reassigned through no fault of the operator.${why}`,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- balance
async function settlementParty(c, departureId) {
  const r = (await c.query(
    `SELECT * FROM catalogue_assignments WHERE departure_id = $1 AND state = 'acknowledged' ORDER BY id DESC LIMIT 1`, [departureId])).rows[0];
  return r ? { assignmentId: Number(r.id), operatorId: Number(r.operator_id) } : null;
}

async function departureFacts(c, departureId) {
  const r = (await c.query(
    `SELECT cd.id, cd.date, cd.status, c.code, c.title, c.type, t.nights, sv.version AS spec_version,
            rv.id AS rate_id, rv.version AS rate_version
       FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
       LEFT JOIN tour_products t ON t.id = c.legacy_product_id
       LEFT JOIN catalogue_spec_versions sv ON sv.id = cd.spec_version_id
       LEFT JOIN catalogue_rate_versions rv ON rv.id = cd.rate_version_id
      WHERE cd.id = $1`, [departureId])).rows[0];
  if (!r) throw new CatalogueError(404, "Departure not found.");
  const date = ymd(r.date);
  return {
    id: Number(r.id), date, endDate: shiftDate(date, Number(r.nights) || 0), status: r.status, code: r.code, title: r.title,
    type: r.type, specVersion: r.spec_version, rateVersionId: r.rate_id == null ? null : Number(r.rate_id), rateVersion: r.rate_version,
  };
}

// The adjustments of the operator settling the departure. An earlier
// operator's (on a reassignment) are settled through its receivables.
async function adjustmentsFor(c, departureId, operatorId) {
  return (await c.query(
    "SELECT * FROM operator_adjustments WHERE departure_id = $1 AND voided_at IS NULL AND ($2::bigint IS NULL OR operator_id = $2) ORDER BY id",
    [departureId, operatorId])).rows.map(mapAdjustment);
}

// Everything the balance and the statement need, computed once.
export async function settlementFigures(c, departureId) {
  const d = await departureFacts(c, departureId);
  const party = await settlementParty(c, departureId);
  const expected = await expectedAmountFor(c, departureId);
  const adjustments = await adjustmentsFor(c, departureId, party?.operatorId ?? null);
  const deductions = adjustments.filter((a) => DEDUCTIONS.includes(a.kind)).reduce((s, a) => s + a.amountEgp, 0);
  const reimbursements = adjustments.filter((a) => a.kind === "reimbursement").reduce((s, a) => s + a.amountEgp, 0);
  const advanceRow = party ? (await c.query(
    "SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance' AND state <> 'cancelled'", [party.assignmentId])).rows[0] : null;
  const advance = advanceRow?.amount != null ? Number(advanceRow.amount) : 0;
  const bal = operatorBalance({ finalAmount: expected.total, advance, deductions, reimbursements });
  return { departure: d, party, expected, adjustments, deductions: round2(deductions), reimbursements: round2(reimbursements), advance, advanceRow, ...bal };
}

// How the departure's collections are distributed (decided 27 Sep 2026): Gross
// Collections, less payment costs, agency commission and the operator
// entitlement (the rate card, unchanged), leaving the collecting agent's
// commission; a Minimum Departure Guarantee where collections fall short.
// In EUR: the entitlement (EGP) is converted at the rate on the departure's
// date, or the latest before it. No rate: shown as missing, never guessed.
export async function departureDistribution(c, departureId, { entitlementEgp }) {
  const d = (await c.query("SELECT cd.date, cd.legacy_departure_id FROM catalogue_departures cd WHERE cd.id = $1", [departureId])).rows[0];
  const hasRequests = (await c.query("SELECT to_regclass('public.payment_requests') AS t")).rows[0].t != null;
  const charges = [];
  if (hasRequests) {
    for (const r of (await c.query("SELECT amount_eur FROM payment_requests WHERE departure_id = $1 AND state = 'paid'", [departureId])).rows) charges.push(Number(r.amount_eur));
  }
  for (const r of (await c.query(
    `SELECT b.amount FROM booking_payments b JOIN pledges p ON p.id = b.pledge_id WHERE p.departure_id = $1 AND b.state = 'paid'`, [d?.legacy_departure_id])).rows) {
    charges.push(Number(r.amount));
  }
  const refunded = hasRequests ? Number((await c.query(
    `SELECT COALESCE(SUM(f.amount_eur), 0) AS n FROM payment_refunds f JOIN payment_requests r ON r.id = f.request_id
      WHERE r.departure_id = $1 AND f.state <> 'cancelled'`, [departureId])).rows[0].n) : 0;
  const gross = round2(charges.reduce((s2, x) => s2 + x, 0) - refunded);
  const fees = (await c.query("SELECT value FROM finance_settings WHERE key = 'payment_fees'")).rows[0]?.value || null;
  const paymentCosts = fees ? round2(charges.reduce((s2, x) => s2 + x * (Number(fees.percent) / 100) + Number(fees.fixedEur || 0), 0)) : 0;
  const agency = Number((await c.query(
    "SELECT COALESCE(SUM(COALESCE(earned_eur, CASE WHEN state = 'pending' THEN amount_eur END)), 0) AS n FROM agency_commissions WHERE departure_id = $1",
    [departureId])).rows[0].n);
  const fx = d ? (await c.query("SELECT day, egp_per_eur FROM fx_rates WHERE day <= $1 ORDER BY day DESC LIMIT 1", [d.date])).rows[0] : null;
  const entitlementEur = entitlementEgp != null && fx ? round2(Number(entitlementEgp) / Number(fx.egp_per_eur)) : null;
  const out = collectionsDistribution({
    grossEur: gross, paymentCostsEur: paymentCosts, agencyCommissionEur: agency, entitlementEur, agentName: BRAND.legalName,
  });
  return {
    ...out, currency: "EUR", entitlementEgp: entitlementEgp ?? null,
    fx: fx ? { day: ymd(fx.day), egpPerEur: Number(fx.egp_per_eur) } : null,
    feesMissing: !fees,
    problem: out.problem || (entitlementEgp != null && !fx ? "exchange rate missing" : null),
  };
}

async function statementSnapshot(c, departureId, figures = null) {
  const f = figures || await settlementFigures(c, departureId);
  const manifest = (await c.query("SELECT frozen_at, travelers, seat_count FROM catalogue_manifests WHERE departure_id = $1", [departureId])).rows[0];
  const rate = f.departure.rateVersionId ? (await c.query("SELECT * FROM catalogue_rate_versions WHERE id = $1", [f.departure.rateVersionId])).rows[0] : null;
  const op = f.party ? (await c.query("SELECT id, legal_name FROM operators WHERE id = $1", [f.party.operatorId])).rows[0] : null;
  const perTraveler = rate ? num(rate.per_traveler ?? rate.land_per_traveler) : null;
  return {
    currency: "EGP",
    operator: op ? { id: Number(op.id), legalName: op.legal_name } : null,
    departure: { id: f.departure.id, code: f.departure.code, title: f.departure.title, date: f.departure.date, endDate: f.departure.endDate, specVersion: f.departure.specVersion },
    rateVersion: rate ? { id: Number(rate.id), version: rate.version, fields: rateFieldsFor(f.departure.type) } : null,
    manifestFrozenAt: manifest?.frozen_at || null,
    travelers: (manifest?.travelers || []).map((t) => ({ booking: t.booking, name: t.name, canceledAfterCutoff: !!t.canceledAfterCutoff })),
    travelerCount: f.expected.travelers,
    band: f.expected.band || null,
    perTraveler,
    lines: f.expected.lines,
    operatorAmount: f.expected.total,
    missing: f.expected.missing,
    adjustments: f.adjustments.map((a) => ({ id: a.id, kind: a.kind, amountEgp: a.amountEgp, reason: a.reason, clauseRef: a.clauseRef, penaltyCode: a.penaltyCode, evidence: a.evidence, costLineIds: a.costLineIds })),
    deductions: f.deductions, deductionsApplied: f.deductionsApplied, capped: f.capped, reimbursements: f.reimbursements,
    advance: f.advance, advanceState: f.advanceRow?.state || null,
    balance: f.balance,
    // Set-off (Operator 9.4): what this departure's payments were reduced by,
    // for what the operator owed on another departure; and anything the
    // operator owes Sawa from this one, with where it was recovered.
    ...(f.party ? await (async () => {
      const lines = await setoffLines(c, departureId, f.party.operatorId);
      const balanceSetoff = lines.taken.filter((t) => t.payable === "balance").reduce((sum, t) => sum + t.amountEgp, 0);
      return {
        setoffs: lines.taken,
        receivables: lines.receivables.map((r) => ({ id: r.id, source: r.source, amountEgp: r.amountEgp, outstandingEgp: r.outstandingEgp, reason: r.reason, setOffAgainst: r.setOffAgainst })),
        netBalance: f.balance == null ? null : round2(Math.max(0, f.balance) - balanceSetoff),
      };
    })() : { setoffs: [], receivables: [], netBalance: f.balance }),
    // The distribution of the departure's collections (27 Sep 2026).
    distribution: await departureDistribution(c, departureId, { entitlementEgp: f.expected.total }),
    collectingAgent: { name: BRAND.legalName, registrationNo: BRAND.registrationNumber, license: BRAND.agentLicense },
    generatedAt: new Date().toISOString(),
  };
}

// Departures that completed with an acknowledged operator get their balance
// and a draft statement. Once.
export async function createBalances({ db = pool, log = () => {} } = {}) {
  const due = (await db.query(
    `SELECT cd.id FROM catalogue_departures cd
      WHERE cd.status = 'completed'
        AND EXISTS (SELECT 1 FROM catalogue_assignments a WHERE a.departure_id = cd.id AND a.state = 'acknowledged')
        AND NOT EXISTS (SELECT 1 FROM operator_payables p WHERE p.departure_id = cd.id AND p.kind = 'balance' AND p.state <> 'cancelled')`)).rows;
  let created = 0;
  for (const { id } of due) {
    await inTx(db, async (c) => {
      const f = await settlementFigures(c, Number(id));
      if (!f.party) return;
      const hold = f.balance == null ? `The rate card has no ${f.expected.missing.join(", ") || "amount"} for this product.` : null;
      const ins = await c.query(
        `INSERT INTO operator_payables (departure_id, operator_id, assignment_id, kind, amount, due_on, state, hold_reason, detail)
         VALUES ($1, $2, $3, 'balance', $4, $5, $6, $7, $8)
         ON CONFLICT (departure_id) WHERE kind = 'balance' AND state <> 'cancelled' DO NOTHING RETURNING id`,
        [f.departure.id, f.party.operatorId, f.party.assignmentId, f.balance, balanceDueOn(f.departure.endDate),
          hold ? "on_hold" : "due", hold, JSON.stringify({ operatorAmount: f.expected.total, advance: f.advance, deductions: f.deductionsApplied, reimbursements: f.reimbursements })]);
      if (!ins.rows.length) return;
      created += 1;
      await settleBalanceSign(c, Number(ins.rows[0].id));
      await c.query(
        `INSERT INTO settlement_statements (departure_id, operator_id, snapshot) VALUES ($1, $2, $3)
         ON CONFLICT (departure_id) DO NOTHING`, [f.departure.id, f.party.operatorId, JSON.stringify(await statementSnapshot(c, f.departure.id, f))]);
    });
  }
  if (created) log(`settlement: ${created} balances created`);
  return { balancesCreated: created };
}

// A balance of zero or less has nothing to transfer ('offset'); below zero it
// becomes a receivable. A positive one first takes what the operator owes.
async function settleBalanceSign(c, payableId) {
  const p = (await c.query("SELECT * FROM operator_payables WHERE id = $1", [payableId])).rows[0];
  if (p.amount != null && Number(p.amount) <= 0) {
    await c.query("UPDATE operator_payables SET state = 'offset', paid_at = now(), updated_at = now() WHERE id = $1", [payableId]);
  }
  await syncBalanceReceivable(c, p);
  if (p.amount != null && Number(p.amount) > 0) await applySetoffs(c, payableId);
}

// After an adjustment or a resolved dispute: the unpaid balance and the
// statement follow.
async function refreshBalance(c, departureId) {
  const bal = (await c.query(
    "SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance' AND state <> 'cancelled' FOR UPDATE", [departureId])).rows[0];
  if (!bal) return null;
  const f = await settlementFigures(c, departureId);
  if (bal.state !== "paid") {
    await releaseSetoffs(c, Number(bal.id));
    await c.query(
      `UPDATE operator_payables SET amount = $2, state = CASE WHEN $2::numeric IS NULL THEN 'on_hold' ELSE 'due' END, paid_at = NULL,
              detail = $3, updated_at = now() WHERE id = $1`,
      [bal.id, f.balance, JSON.stringify({ operatorAmount: f.expected.total, advance: f.advance, deductions: f.deductionsApplied, reimbursements: f.reimbursements })]);
    await settleBalanceSign(c, Number(bal.id));
  }
  await c.query(
    "UPDATE settlement_statements SET snapshot = $2, updated_at = now() WHERE departure_id = $1 AND state IN ('draft', 'disputed')",
    [departureId, JSON.stringify(await statementSnapshot(c, departureId, f))]);
  return f;
}

// ---------------------------------------------------------------- adjustments
export async function addAdjustment(db, {
  departureId, kind, penaltyCode = null, travelers = null, amountEgp = null, reason, clauseRef, evidence = [], costLineIds = [], by,
}) {
  if (!["penalty", "service_failure", "reimbursement"].includes(kind)) throw new CatalogueError(422, "Unknown adjustment type.");
  if (!String(reason || "").trim()) throw new CatalogueError(422, "Give the reason.");
  return inTx(db, async (c) => {
    const f = await settlementFigures(c, departureId);
    if (!f.party) throw new CatalogueError(409, "No operator has acknowledged this departure, so there is nothing to adjust.");
    const st = (await c.query("SELECT state FROM settlement_statements WHERE departure_id = $1", [departureId])).rows[0];
    if (st && !["draft", "disputed"].includes(st.state)) {
      throw new CatalogueError(409, `The statement is ${st.state}. It can change only while it is a draft or disputed.`);
    }
    let amount = amountEgp == null ? null : round2(amountEgp);
    let clause = String(clauseRef || "").trim();
    if (kind === "penalty") {
      const rate = (await c.query("SELECT * FROM operator_penalty_rates WHERE code = $1", [penaltyCode])).rows[0];
      if (!rate) throw new CatalogueError(422, "Choose the penalty from Schedule 6.");
      const count = rate.per_traveler ? Math.max(1, Number(travelers) || 1) : 1;
      amount = round2(Number(rate.amount_egp) * count);
      clause = clause || rate.clause_ref;
    }
    if (kind === "reimbursement") {
      const ids = [...new Set((costLineIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (!ids.length) throw new CatalogueError(422, "Point to the approved cost-sheet lines (with their receipts) this reimburses.");
      const legacy = (await c.query("SELECT legacy_departure_id FROM catalogue_departures WHERE id = $1", [departureId])).rows[0]?.legacy_departure_id;
      const ok = (await c.query("SELECT COUNT(*)::int AS n FROM departure_costs WHERE id = ANY($1::bigint[]) AND departure_id = $2 AND state = 'approved'", [ids, legacy])).rows[0].n;
      if (ok !== ids.length) throw new CatalogueError(422, "Every line must be an approved line on this departure's cost sheet.");
      costLineIds = ids;
    }
    if (amount == null || !Number.isFinite(amount) || amount < 0) throw new CatalogueError(422, "Enter the amount in EGP.");
    if (!clause) throw new CatalogueError(422, "Give the agreement clause this relies on.");
    if (DEDUCTIONS.includes(kind)) {
      const room = deductionRoom(f.expected.total, f.deductions);
      if (room == null) throw new CatalogueError(409, "The operator amount for this departure isn't known yet, so deductions can't be checked against it.");
      if (amount > room) {
        throw new CatalogueError(422, `Deductions are capped at the operator amount for this departure (EGP ${f.expected.total}). At most EGP ${room} more can be deducted.`);
      }
    }
    const list = Array.isArray(evidence) ? evidence.map((e) => String(e || "").trim()).filter(Boolean).slice(0, 20) : [];
    const r = await c.query(
      `INSERT INTO operator_adjustments (departure_id, operator_id, kind, penalty_code, amount_egp, reason, clause_ref, evidence, cost_line_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [departureId, f.party.operatorId, kind, kind === "penalty" ? penaltyCode : null, amount, String(reason).trim(), clause,
        JSON.stringify(list), JSON.stringify(costLineIds || []), by]);
    await refreshBalance(c, departureId);
    return mapAdjustment(r.rows[0]);
  });
}

export async function voidAdjustment(db, { id, reason, by }) {
  if (!String(reason || "").trim()) throw new CatalogueError(422, "Say why this adjustment is voided.");
  return inTx(db, async (c) => {
    const a = (await c.query("SELECT * FROM operator_adjustments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!a || a.voided_at) throw new CatalogueError(404, "Adjustment not found, or already voided.");
    const st = (await c.query("SELECT state FROM settlement_statements WHERE departure_id = $1", [a.departure_id])).rows[0];
    if (st && !["draft", "disputed"].includes(st.state)) throw new CatalogueError(409, `The statement is ${st.state}.`);
    await c.query("UPDATE operator_adjustments SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1", [id, by, String(reason).trim()]);
    await refreshBalance(c, Number(a.departure_id));
    return { id: Number(id), voided: true };
  });
}

// ---------------------------------------------------------------- statements
export const mapStatementRow = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), operatorId: Number(r.operator_id), state: r.state, snapshot: r.snapshot,
  createdAt: r.created_at, sentAt: r.sent_at, sentBy: r.sent_by, acceptedAt: r.accepted_at, autoAccepted: r.auto_accepted,
  disputeReason: r.dispute_reason, disputedAt: r.disputed_at, disputedBy: r.disputed_by,
  resolutionNote: r.resolution_note, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
  autoAcceptOn: r.sent_at && r.state === "sent" ? new Date(statementAutoAcceptAt(new Date(r.sent_at).getTime())).toISOString() : null,
});

export async function sendStatement(db, { departureId, by, send = null }) {
  return inTx(db, async (c) => {
    const st = (await c.query("SELECT * FROM settlement_statements WHERE departure_id = $1 FOR UPDATE", [departureId])).rows[0];
    if (!st) throw new CatalogueError(404, "No statement for this departure yet.");
    if (st.state !== "draft") throw new CatalogueError(409, `This statement is already ${st.state}.`);
    const snapshot = await statementSnapshot(c, departureId);
    if (snapshot.balance == null) throw new CatalogueError(409, "The balance isn't known (the rate card is missing an amount), so the statement can't be sent.");
    const r = await c.query(
      "UPDATE settlement_statements SET state = 'sent', snapshot = $2, sent_at = now(), sent_by = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [st.id, JSON.stringify(snapshot), by]);
    const title = `Settlement statement: ${snapshot.departure.title} on ${snapshot.departure.date}`;
    const balance = `EGP ${Number(snapshot.balance).toLocaleString("en-US")}`;
    const { settlementStatementEmail } = await import("./email.js");
    const to = send ? (await operatorRecipients(c, Number(st.operator_id)))[0] : null;
    await notifyOperator(c, {
      operatorId: Number(st.operator_id), kind: "statement", title,
      body: `Balance ${balance}. It is accepted automatically 30 days after today unless you dispute it in the portal.`,
      departureId, dedupeKey: `statement:${st.id}:sent`,
      email: to ? settlementStatementEmail({ to, operatorName: snapshot.operator?.legalName || "", title: snapshot.departure.title, dateLabel: snapshot.departure.date, balance, portalUrl: `${site()}/portal` }) : null,
      send,
    });
    return mapStatementRow(r.rows[0]);
  });
}

export async function disputeStatement(db, { departureId, operatorId, reason, by }) {
  if (String(reason || "").trim().length < 5) throw new CatalogueError(422, "Say what is wrong with the statement.");
  const r = await db.query(
    `UPDATE settlement_statements SET state = 'disputed', dispute_reason = $3, disputed_at = now(), disputed_by = $4, updated_at = now()
      WHERE departure_id = $1 AND operator_id = $2 AND state = 'sent' RETURNING *`,
    [departureId, operatorId, String(reason).trim().slice(0, 2000), by]);
  if (!r.rows.length) throw new CatalogueError(409, "Only a statement that has been sent, and not yet accepted, can be disputed.");
  return mapStatementRow(r.rows[0]);
}

export async function resolveStatement(db, { departureId, note, by }) {
  if (String(note || "").trim().length < 5) throw new CatalogueError(422, "Write how the dispute was resolved.");
  return inTx(db, async (c) => {
    const st = (await c.query("SELECT * FROM settlement_statements WHERE departure_id = $1 FOR UPDATE", [departureId])).rows[0];
    if (!st || st.state !== "disputed") throw new CatalogueError(409, "Only a disputed statement can be resolved.");
    await refreshBalance(c, departureId);
    const r = await c.query(
      `UPDATE settlement_statements SET state = 'resolved', resolution_note = $2, resolved_at = now(), resolved_by = $3, updated_at = now()
        WHERE id = $1 RETURNING *`, [st.id, String(note).trim().slice(0, 2000), by]);
    await notifyOperator(c, {
      operatorId: Number(st.operator_id), kind: "statement", title: "Your statement dispute was resolved",
      body: String(note).trim().slice(0, 2000), departureId, dedupeKey: `statement:${st.id}:resolved`,
    });
    return mapStatementRow(r.rows[0]);
  });
}

// Daily: a statement sent 30 days ago and not disputed is accepted.
export async function autoAcceptStatements({ db = pool, now = Date.now() } = {}) {
  const r = await db.query(
    `UPDATE settlement_statements SET state = 'accepted', accepted_at = now(), auto_accepted = true, updated_at = now()
      WHERE state = 'sent' AND sent_at <= $1 RETURNING id`, [new Date(now - 30 * 86400000)]);
  return { statementsAccepted: r.rowCount };
}

export async function statementFor(db, departureId) {
  const r = (await db.query("SELECT * FROM settlement_statements WHERE departure_id = $1", [departureId])).rows[0];
  return r ? mapStatementRow(r) : null;
}

// Run by the scheduler with the assignment tick.
export async function runSettlementTick({ db = pool, now = Date.now(), log = () => {} } = {}) {
  const advances = await tidyAdvances(db);
  const balances = await createBalances({ db, log });
  const accepted = await autoAcceptStatements({ db, now });
  return { ...advances, ...balances, ...accepted };
}
