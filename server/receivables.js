// What an operator owes Sawa, and set-off (model phase 3; Operator Supply
// Agreement 9.4). EGP.
//
// A receivable arises from a negative balance (deductions and the advance
// exceed the operator amount), from an advance on a departure taken away
// from the operator, or from a penalty on one. It is recovered:
//   - automatically, from the operator's next advances and balances, oldest
//     receivable first, each set-off recorded as a line (operator_setoffs) and
//     shown on the statements of both departures; and/or
//   - by a payment from the operator that finance records.
// A payable whose whole amount is set off is 'offset': nothing to transfer.
import { CatalogueError } from "./catalogue.js";

const num = (v) => (v == null ? null : Number(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export const mapReceivable = (r) => ({
  id: Number(r.id), operatorId: Number(r.operator_id), departureId: Number(r.departure_id), source: r.source,
  sourcePayableId: r.source_payable_id == null ? null : Number(r.source_payable_id),
  sourceAdjustmentId: r.source_adjustment_id == null ? null : Number(r.source_adjustment_id),
  amountEgp: num(r.amount_egp), outstandingEgp: num(r.outstanding_egp), state: r.state, reason: r.reason, clauseRef: r.clause_ref,
  createdBy: r.created_by, createdAt: r.created_at, settledAt: r.settled_at,
});

export const SOURCE_LABEL = {
  negative_balance: "Negative balance",
  reassignment_advance: "Advance on a departure reassigned",
  penalty: "Penalty",
};

// Remove every active set-off on a payable (before it is recomputed or
// canceled), giving the amounts back to their receivables.
export async function releaseSetoffs(c, payableId) {
  const rows = (await c.query(
    "UPDATE operator_setoffs SET released_at = now() WHERE payable_id = $1 AND released_at IS NULL RETURNING receivable_id, amount_egp", [payableId])).rows;
  for (const s of rows) {
    await c.query(
      `UPDATE operator_receivables SET outstanding_egp = outstanding_egp + $2, state = 'open', settled_at = NULL
        WHERE id = $1 AND state <> 'cancelled'`, [s.receivable_id, s.amount_egp]);
  }
  await c.query(
    `UPDATE operator_payables SET setoff_egp = 0, updated_at = now(),
            state = CASE WHEN state = 'offset' AND amount > 0 THEN 'due' ELSE state END,
            paid_at = CASE WHEN state = 'offset' AND amount > 0 THEN NULL ELSE paid_at END
      WHERE id = $1`, [payableId]);
  return rows.length;
}

// Set the operator's open receivables off against one unpaid payable, oldest
// first, as far as its amount goes.
export async function applySetoffs(c, payableId) {
  const p = (await c.query("SELECT * FROM operator_payables WHERE id = $1 FOR UPDATE", [payableId])).rows[0];
  if (!p || p.state !== "due" || !(Number(p.amount) > 0)) return 0;
  let room = round2(Number(p.amount) - Number(p.setoff_egp));
  if (room <= 0) return 0;
  const open = (await c.query(
    `SELECT * FROM operator_receivables WHERE operator_id = $1 AND state = 'open' AND outstanding_egp > 0
        AND (source_payable_id IS NULL OR source_payable_id <> $2)
      ORDER BY created_at, id FOR UPDATE`, [p.operator_id, p.id])).rows;
  let applied = 0;
  for (const r of open) {
    if (room <= 0) break;
    const take = round2(Math.min(room, Number(r.outstanding_egp)));
    if (take <= 0) continue;
    await c.query("INSERT INTO operator_setoffs (receivable_id, payable_id, amount_egp) VALUES ($1, $2, $3)", [r.id, p.id, take]);
    const left = round2(Number(r.outstanding_egp) - take);
    await c.query(
      `UPDATE operator_receivables SET outstanding_egp = $2, state = CASE WHEN $2::numeric = 0 THEN 'settled' ELSE 'open' END,
              settled_at = CASE WHEN $2::numeric = 0 THEN now() ELSE NULL END WHERE id = $1`, [r.id, left]);
    room = round2(room - take);
    applied = round2(applied + take);
  }
  if (applied > 0) {
    await c.query(
      `UPDATE operator_payables SET setoff_egp = setoff_egp + $2, updated_at = now(),
              state = CASE WHEN amount - (setoff_egp + $2) <= 0 THEN 'offset' ELSE state END,
              paid_at = CASE WHEN amount - (setoff_egp + $2) <= 0 THEN now() ELSE paid_at END
        WHERE id = $1`, [p.id, applied]);
  }
  return applied;
}

// Apply open receivables to every unpaid payable of the operator, earliest
// due first. Run whenever a receivable or a payable appears.
export async function applyOpenReceivables(c, operatorId) {
  const due = (await c.query(
    "SELECT id FROM operator_payables WHERE operator_id = $1 AND state = 'due' AND amount > 0 ORDER BY due_on NULLS LAST, id", [operatorId])).rows;
  let applied = 0;
  for (const { id } of due) applied += await applySetoffs(c, Number(id));
  return round2(applied);
}

export async function createReceivable(c, {
  operatorId, departureId, source, amountEgp, reason, clauseRef = "Operator 9.4", sourcePayableId = null, sourceAdjustmentId = null, by = null,
}) {
  const amount = round2(amountEgp);
  if (!(amount > 0)) return null;
  const r = (await c.query(
    `INSERT INTO operator_receivables (operator_id, departure_id, source, source_payable_id, source_adjustment_id, amount_egp, outstanding_egp, reason, clause_ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9) RETURNING *`,
    [operatorId, departureId, source, sourcePayableId, sourceAdjustmentId, amount, reason, clauseRef, by])).rows[0];
  await applyOpenReceivables(c, operatorId);
  return mapReceivable((await c.query("SELECT * FROM operator_receivables WHERE id = $1", [r.id])).rows[0]);
}

// A balance of zero or less has nothing to transfer; below zero the operator
// owes the difference. Keeps the receivable in step when the balance is
// recomputed (an adjustment, a resolved dispute).
export async function syncBalanceReceivable(c, payable, { by = null } = {}) {
  const amount = payable.amount == null ? null : Number(payable.amount);
  const existing = (await c.query(
    "SELECT * FROM operator_receivables WHERE source_payable_id = $1 AND source = 'negative_balance' AND state <> 'cancelled' FOR UPDATE", [payable.id])).rows[0];
  const recovered = existing ? round2(Number(existing.amount_egp) - Number(existing.outstanding_egp)) : 0;
  if (amount != null && amount < 0) {
    const owed = round2(-amount);
    if (!existing) {
      return createReceivable(c, {
        operatorId: Number(payable.operator_id), departureId: Number(payable.departure_id), source: "negative_balance",
        amountEgp: owed, sourcePayableId: Number(payable.id), by,
        reason: "The deductions and the advance exceed the operator amount for this departure.",
      });
    }
    if (owed < recovered) throw new CatalogueError(409, `EGP ${recovered} of this balance has already been recovered; the new balance would owe less than that. Record the difference by hand.`);
    await c.query(
      `UPDATE operator_receivables SET amount_egp = $2, outstanding_egp = $3, state = CASE WHEN $3::numeric = 0 THEN 'settled' ELSE 'open' END WHERE id = $1`,
      [existing.id, owed, round2(owed - recovered)]);
    await applyOpenReceivables(c, Number(payable.operator_id));
    return null;
  }
  if (existing) {
    if (recovered > 0) throw new CatalogueError(409, `EGP ${recovered} of this departure's negative balance has already been recovered, so the balance can't turn positive here. Record the difference by hand.`);
    await c.query("UPDATE operator_receivables SET state = 'cancelled', cancelled_at = now(), outstanding_egp = 0 WHERE id = $1", [existing.id]);
  }
  return null;
}

// Set-offs taken from a departure's payables, and what became of the
// receivables that arose on it: for its statement.
export async function setoffLines(c, departureId, operatorId) {
  const taken = (await c.query(
    `SELECT s.amount_egp, p.kind, r.source, r.departure_id AS from_departure, c.code, cd.date
       FROM operator_setoffs s JOIN operator_payables p ON p.id = s.payable_id
       JOIN operator_receivables r ON r.id = s.receivable_id
       JOIN catalogue_departures cd ON cd.id = r.departure_id JOIN catalogue_products c ON c.id = cd.product_id
      WHERE p.departure_id = $1 AND p.operator_id = $2 AND s.released_at IS NULL ORDER BY s.id`, [departureId, operatorId])).rows
    .map((x) => ({
      payable: x.kind, amountEgp: Number(x.amount_egp), source: x.source,
      fromDeparture: `${x.code} ${x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date}`, fromDepartureId: Number(x.from_departure),
    }));
  const owed = (await c.query(
    "SELECT * FROM operator_receivables WHERE departure_id = $1 AND operator_id = $2 AND state <> 'cancelled' ORDER BY id", [departureId, operatorId])).rows;
  const receivables = [];
  for (const r of owed) {
    const recovered = (await c.query(
      `SELECT s.amount_egp, p.kind, c.code, cd.date FROM operator_setoffs s JOIN operator_payables p ON p.id = s.payable_id
         JOIN catalogue_departures cd ON cd.id = p.departure_id JOIN catalogue_products c ON c.id = cd.product_id
        WHERE s.receivable_id = $1 AND s.released_at IS NULL ORDER BY s.id`, [r.id])).rows;
    receivables.push({
      ...mapReceivable(r),
      setOffAgainst: recovered.map((x) => ({ payable: x.kind, amountEgp: Number(x.amount_egp), departure: `${x.code} ${x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date}` })),
    });
  }
  return { taken, receivables };
}

export async function receivablesByOperator(db) {
  const r = await db.query(
    `SELECT r.operator_id, o.legal_name, SUM(r.outstanding_egp) AS outstanding, COUNT(*)::int AS n
       FROM operator_receivables r JOIN operators o ON o.id = r.operator_id
      WHERE r.state = 'open' AND r.outstanding_egp > 0 GROUP BY r.operator_id, o.legal_name ORDER BY SUM(r.outstanding_egp) DESC`);
  return r.rows.map((x) => ({ operatorId: Number(x.operator_id), name: x.legal_name, outstandingEgp: Number(x.outstanding), count: x.n }));
}
