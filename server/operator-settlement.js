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
import { shiftDate } from "../shared/catalogue.js";
import { rateFieldsFor } from "../shared/operators.js";
import {
  advanceFor, operatorBalance, deductionRoom, egyptBusinessDaysAfter, balanceDueOn, statementAutoAcceptAt,
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
  return r.rows[0] ? mapPayable(r.rows[0]) : null;
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
    await db.query(
      `UPDATE operator_payables SET amount = $2, state = 'due', hold_reason = NULL, updated_at = now(),
              detail = detail || $3::jsonb WHERE id = $1 AND state = 'on_hold'`,
      [p.id, amount, JSON.stringify({ expectedTotal: expected.total, pricedLater: true })]);
    priced += 1;
  }
  const cancelled = await db.query(
    `UPDATE operator_payables p SET state = 'cancelled', cancelled_at = now(), cancel_reason = 'Assignment replaced before payment.', updated_at = now()
       FROM catalogue_assignments a
      WHERE p.assignment_id = a.id AND p.kind = 'advance' AND p.state IN ('due', 'on_hold') AND a.state IN ('replaced', 'expired')`);
  return { advancesPriced: priced, advancesCancelled: cancelled.rowCount };
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

async function adjustmentsFor(c, departureId) {
  return (await c.query("SELECT * FROM operator_adjustments WHERE departure_id = $1 AND voided_at IS NULL ORDER BY id", [departureId])).rows.map(mapAdjustment);
}

// Everything the balance and the statement need, computed once.
export async function settlementFigures(c, departureId) {
  const d = await departureFacts(c, departureId);
  const party = await settlementParty(c, departureId);
  const expected = await expectedAmountFor(c, departureId);
  const adjustments = await adjustmentsFor(c, departureId);
  const deductions = adjustments.filter((a) => DEDUCTIONS.includes(a.kind)).reduce((s, a) => s + a.amountEgp, 0);
  const reimbursements = adjustments.filter((a) => a.kind === "reimbursement").reduce((s, a) => s + a.amountEgp, 0);
  const advanceRow = party ? (await c.query(
    "SELECT * FROM operator_payables WHERE assignment_id = $1 AND kind = 'advance' AND state <> 'cancelled'", [party.assignmentId])).rows[0] : null;
  const advance = advanceRow?.amount != null ? Number(advanceRow.amount) : 0;
  const bal = operatorBalance({ finalAmount: expected.total, advance, deductions, reimbursements });
  return { departure: d, party, expected, adjustments, deductions: round2(deductions), reimbursements: round2(reimbursements), advance, advanceRow, ...bal };
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
      await c.query(
        `INSERT INTO settlement_statements (departure_id, operator_id, snapshot) VALUES ($1, $2, $3)
         ON CONFLICT (departure_id) DO NOTHING`, [f.departure.id, f.party.operatorId, JSON.stringify(await statementSnapshot(c, f.departure.id, f))]);
    });
  }
  if (created) log(`settlement: ${created} balances created`);
  return { balancesCreated: created };
}

// After an adjustment or a resolved dispute: the unpaid balance and the
// statement follow.
async function refreshBalance(c, departureId) {
  const bal = (await c.query(
    "SELECT * FROM operator_payables WHERE departure_id = $1 AND kind = 'balance' AND state <> 'cancelled' FOR UPDATE", [departureId])).rows[0];
  if (!bal) return null;
  const f = await settlementFigures(c, departureId);
  if (bal.state !== "paid") {
    await c.query(
      `UPDATE operator_payables SET amount = $2, state = CASE WHEN $2::numeric IS NULL THEN 'on_hold' ELSE 'due' END,
              detail = $3, updated_at = now() WHERE id = $1`,
      [bal.id, f.balance, JSON.stringify({ operatorAmount: f.expected.total, advance: f.advance, deductions: f.deductionsApplied, reimbursements: f.reimbursements })]);
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
