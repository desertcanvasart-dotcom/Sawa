// Finance (model phase 3): what is owed and what was paid, the exchange-rate
// table, public holidays, penalty amounts and the margin report. Records
// only: no provider or bank is called, and no external rate source either.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { payableAccount } from "./bank-details.js";
import { departureMargin } from "../shared/settlement-rules.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// ---------------------------------------------------------------- reference tables
export async function listFxRates(db = pool, { from = null, to = null } = {}) {
  const r = await db.query(
    `SELECT * FROM fx_rates WHERE ($1::date IS NULL OR day >= $1) AND ($2::date IS NULL OR day <= $2) ORDER BY day DESC LIMIT 400`, [from, to]);
  return r.rows.map((x) => ({ day: ymd(x.day), egpPerEur: Number(x.egp_per_eur), sourceNote: x.source_note, enteredBy: x.entered_by, enteredAt: x.entered_at }));
}
export async function setFxRate(db, { day, egpPerEur, sourceNote = null, by }) {
  if (!isYmd(day)) throw new CatalogueError(422, "Use a date like 2026-11-13.");
  const rate = Number(egpPerEur);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new CatalogueError(422, "Enter EGP per 1 EUR, e.g. 55.25.");
  await db.query(
    `INSERT INTO fx_rates (day, egp_per_eur, source_note, entered_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (day) DO UPDATE SET egp_per_eur = EXCLUDED.egp_per_eur, source_note = EXCLUDED.source_note, entered_by = EXCLUDED.entered_by, entered_at = now()`,
    [day, rate, sourceNote ? String(sourceNote).slice(0, 200) : "CBE", by]);
  return { day, egpPerEur: rate };
}
export async function deleteFxRate(db, day) {
  await db.query("DELETE FROM fx_rates WHERE day = $1", [day]);
}

export async function listHolidays(db = pool) {
  return (await db.query("SELECT * FROM egypt_holidays ORDER BY day")).rows.map((h) => ({ day: ymd(h.day), name: h.name, createdBy: h.created_by }));
}
export async function setHoliday(db, { day, name, by }) {
  if (!isYmd(day)) throw new CatalogueError(422, "Use a date like 2026-10-06.");
  if (!String(name || "").trim()) throw new CatalogueError(422, "Name the holiday.");
  await db.query(
    `INSERT INTO egypt_holidays (day, name, created_by) VALUES ($1, $2, $3) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name`,
    [day, String(name).trim().slice(0, 120), by]);
  return { day, name };
}
export async function deleteHoliday(db, day) {
  await db.query("DELETE FROM egypt_holidays WHERE day = $1", [day]);
}

export async function listPenaltyRates(db = pool) {
  return (await db.query("SELECT * FROM operator_penalty_rates ORDER BY code")).rows.map((p) => ({
    code: p.code, label: p.label, clauseRef: p.clause_ref, perTraveler: p.per_traveler, amountEgp: Number(p.amount_egp), updatedBy: p.updated_by, updatedAt: p.updated_at,
  }));
}
export async function setPenaltyRate(db, { code, amountEgp, by }) {
  const amount = Number(amountEgp);
  if (!Number.isFinite(amount) || amount < 0) throw new CatalogueError(422, "Enter an amount of zero or more.");
  const r = await db.query("UPDATE operator_penalty_rates SET amount_egp = $2, updated_by = $3, updated_at = now() WHERE code = $1 RETURNING code", [code, round2(amount), by]);
  if (!r.rowCount) throw new CatalogueError(404, "Unknown penalty.");
  return { code, amountEgp: round2(amount) };
}

// Payment provider fees for the margin report: { percent, fixedEur } per charge.
export async function feeSetting(db = pool) {
  const r = (await db.query("SELECT value FROM finance_settings WHERE key = 'payment_fees'")).rows[0];
  return r?.value || null;
}
export async function setFeeSetting(db, { percent, fixedEur, by }) {
  const p = Number(percent);
  const f = Number(fixedEur || 0);
  if (!Number.isFinite(p) || p < 0 || p > 20 || !Number.isFinite(f) || f < 0) throw new CatalogueError(422, "Enter the provider's fee: a percentage (0–20) and a fixed amount in EUR.");
  const value = { percent: p, fixedEur: round2(f) };
  await db.query(
    `INSERT INTO finance_settings (key, value, updated_by) VALUES ('payment_fees', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(value), by]);
  return value;
}

// ---------------------------------------------------------------- what is owed
// One list for operator advances and balances, agency commission statements
// and agency invoices. Status: due, overdue (past its due date), paid, or on
// hold / draft where it can't be paid yet.
export async function financeItems(db = pool, { from = null, to = null, party = null, status = null, now = Date.now() } = {}) {
  const today = todayIn(now);
  const [payables, statements, invoices, payments] = await Promise.all([
    db.query(
      `SELECT p.*, o.legal_name, cd.date, c.code, c.title FROM operator_payables p
         JOIN operators o ON o.id = p.operator_id JOIN catalogue_departures cd ON cd.id = p.departure_id
         JOIN catalogue_products c ON c.id = cd.product_id WHERE p.state <> 'cancelled'`),
    db.query(
      `SELECT s.*, a.name AS agency_name FROM commission_statements s JOIN agencies a ON a.id = s.agency_id`),
    db.query(
      `SELECT i.*, a.name AS agency_name, cd.date, c.code, c.title FROM agency_invoices i JOIN agencies a ON a.id = i.agency_id
         JOIN catalogue_departures cd ON cd.id = i.departure_id JOIN catalogue_products c ON c.id = cd.product_id WHERE i.state <> 'void'`),
    db.query("SELECT * FROM finance_payments"),
  ]);
  const paidBy = new Map(payments.rows.map((p) => [`${p.payable_kind}:${p.payable_id}`, p]));
  const statusOf = (state, dueOn) => (state === "paid" ? "paid" : state === "on_hold" ? "on_hold" : state === "draft" ? "draft"
    : dueOn && dueOn < today ? "overdue" : "due");
  const payment = (kind, id) => {
    const p = paidBy.get(`${kind}:${id}`);
    return p ? { amount: Number(p.amount), paidOn: ymd(p.paid_on), bankReference: p.bank_reference, differs: p.differs, overrideBy: p.override_by, recordedBy: p.recorded_by } : null;
  };
  const items = [
    ...payables.rows.map((p) => ({
      kind: "operator_payable", id: Number(p.id), type: p.kind === "advance" ? "Operator advance" : "Operator balance",
      direction: "out", party: { kind: "operator", id: Number(p.operator_id), name: p.legal_name },
      departure: { id: Number(p.departure_id), date: ymd(p.date), label: `${p.code} ${p.title}` },
      currency: "EGP", amount: num(p.amount), dueOn: ymd(p.due_on), status: statusOf(p.state, ymd(p.due_on)),
      holdReason: p.hold_reason, payment: payment("operator_payable", p.id),
    })),
    ...statements.rows.map((s) => {
      // Sent by the 10th; due on the last day of the month it's sent.
      const due = s.sent_at ? new Date(Date.UTC(new Date(s.sent_at).getUTCFullYear(), new Date(s.sent_at).getUTCMonth() + 1, 0)).toISOString().slice(0, 10) : null;
      return {
        kind: "commission_statement", id: Number(s.id), type: `Agency commission, ${s.period}`, direction: "out",
        party: { kind: "agency", id: s.agency_id, name: s.agency_name }, departure: null,
        currency: s.currency, amount: s.currency === "EGP" ? num(s.total_egp) : num(s.total_eur), amountEur: num(s.total_eur),
        dueOn: due, status: statusOf(s.state, due), holdReason: s.hold_reason, payment: payment("commission_statement", s.id),
      };
    }),
    ...invoices.rows.map((i) => ({
      kind: "agency_invoice", id: Number(i.id), type: "Agency invoice (receivable)", direction: "in",
      party: { kind: "agency", id: i.agency_id, name: i.agency_name },
      departure: { id: Number(i.departure_id), date: ymd(i.date), label: `${i.code} ${i.title}` },
      currency: "EUR", amount: num(i.amount_eur), dueOn: ymd(i.due_on), status: statusOf(i.state, ymd(i.due_on)),
      holdReason: null, payment: payment("agency_invoice", i.id),
    })),
  ];
  return items
    .filter((x) => !from || (x.dueOn && x.dueOn >= from))
    .filter((x) => !to || (x.dueOn && x.dueOn <= to))
    .filter((x) => !party || `${x.party.kind}:${x.party.id}` === party || x.party.name?.toLowerCase().includes(String(party).toLowerCase()))
    .filter((x) => !status || x.status === status)
    .sort((a, b) => String(a.dueOn || "9999").localeCompare(String(b.dueOn || "9999")));
}

export async function overdueSummary(db = pool, now = Date.now()) {
  const items = await financeItems(db, { now, status: "overdue" });
  return { overdue: items.length, operator: items.filter((i) => i.party.kind === "operator").length, agency: items.filter((i) => i.party.kind === "agency").length };
}

// ---------------------------------------------------------------- payments
// Finance records a bank transfer against one item. A different amount from
// what is due is refused unless a super admin overrides it with a reason. A
// payment to an operator needs verified bank details and no pending change.
export async function recordPayment(db, { kind, id, amount, paidOn, bankReference, override = false, overrideReason = null, user }) {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) throw new CatalogueError(422, "Enter the amount paid.");
  if (!isYmd(paidOn)) throw new CatalogueError(422, "Enter the date the transfer was made.");
  if (!String(bankReference || "").trim()) throw new CatalogueError(422, "Enter the bank reference.");
  return inTx(db, async (c) => {
    let due; let currency; let direction = "out"; let bankAccountId = null; let markPaid;
    if (kind === "operator_payable") {
      const p = (await c.query("SELECT * FROM operator_payables WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!p) throw new CatalogueError(404, "Not found.");
      if (p.state !== "due") throw new CatalogueError(409, p.state === "paid" ? "Already paid." : p.state === "on_hold" ? `On hold: ${p.hold_reason}` : `This is ${p.state}.`);
      if (Number(p.amount) <= 0) throw new CatalogueError(409, "Nothing is owed to the operator on this line.");
      if (p.kind === "balance") {
        const st = (await c.query("SELECT state FROM settlement_statements WHERE departure_id = $1", [p.departure_id])).rows[0];
        if (st?.state === "disputed") throw new CatalogueError(409, "The operator disputes this statement. Resolve the dispute first.");
      }
      const acct = await payableAccount(c, Number(p.operator_id));
      if (!acct.ok) throw new CatalogueError(409, acct.reason);
      bankAccountId = acct.accountId;
      due = Number(p.amount); currency = "EGP";
      markPaid = () => c.query("UPDATE operator_payables SET state = 'paid', paid_at = now(), updated_at = now() WHERE id = $1", [id]);
    } else if (kind === "commission_statement") {
      const s = (await c.query("SELECT * FROM commission_statements WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new CatalogueError(404, "Not found.");
      if (s.state !== "sent") throw new CatalogueError(409, s.state === "paid" ? "Already paid." : "Send the statement before recording its payment.");
      currency = s.currency;
      due = Number(s.currency === "EGP" ? s.total_egp : s.total_eur);
      markPaid = () => c.query("UPDATE commission_statements SET state = 'paid', paid_at = now() WHERE id = $1", [id]);
    } else if (kind === "agency_invoice") {
      const i = (await c.query("SELECT * FROM agency_invoices WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!i) throw new CatalogueError(404, "Not found.");
      if (i.state !== "due") throw new CatalogueError(409, i.state === "paid" ? "Already paid." : "This invoice is void.");
      direction = "in"; currency = "EUR"; due = Number(i.amount_eur);
      markPaid = () => c.query("UPDATE agency_invoices SET state = 'paid', paid_at = now() WHERE id = $1", [id]);
    } else {
      throw new CatalogueError(422, "Unknown item.");
    }
    const differs = Math.abs(value - due) >= 0.005;
    if (differs) {
      if (!override) {
        throw Object.assign(new CatalogueError(409, `The amount (${currency} ${value}) differs from what is due (${currency} ${due}). Only a super admin can record a different amount, with a reason.`),
          { warning: { due, amount: value, currency } });
      }
      if (user?.role !== "super_admin") throw new CatalogueError(403, "Only a super admin can record an amount that differs from what is due.");
      if (!String(overrideReason || "").trim()) throw new CatalogueError(422, "Give the reason for the different amount.");
    }
    const r = await c.query(
      `INSERT INTO finance_payments (payable_kind, payable_id, direction, currency, amount, due_amount, differs, paid_on, bank_reference,
                                     bank_account_id, override_by, override_reason, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [kind, id, direction, currency, value, due, differs, paidOn, String(bankReference).trim().slice(0, 120), bankAccountId,
        differs ? user?.email || null : null, differs ? String(overrideReason).trim().slice(0, 500) : null, user?.email || null]);
    await markPaid();
    return { id: Number(r.rows[0].id), kind, payableId: id, amount: value, due, currency, differs };
  });
}

// ---------------------------------------------------------------- margin
// Per catalog departure: EUR charged (by charge date, net of refunds),
// operator cost (EGP) converted at the rate on each charge date, commissions
// and payment fees → margin in EUR. A missing rate is shown, never guessed.
export async function marginReport(db = pool, { from, to }) {
  const deps = (await db.query(
    `SELECT cd.id, cd.date, cd.status, cd.legacy_departure_id, c.code, c.title
       FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
      WHERE cd.date BETWEEN $1 AND $2 AND cd.status IN ('go_ahead', 'completed') ORDER BY cd.date`, [from, to])).rows;
  if (!deps.length) return [];
  const rates = new Map((await db.query("SELECT day, egp_per_eur FROM fx_rates")).rows.map((r) => [ymd(r.day), Number(r.egp_per_eur)]));
  const fees = await feeSetting(db);
  const { expectedAmountFor } = await import("./assignments.js");
  const out = [];
  for (const d of deps) {
    const charges = (await db.query(
      `SELECT b.amount, b.paid_at, b.state FROM booking_payments b JOIN pledges p ON p.id = b.pledge_id
        WHERE p.departure_id = $1 AND b.state = 'paid' AND b.paid_at IS NOT NULL`, [d.legacy_departure_id])).rows
      .map((b) => ({ amountEur: Number(b.amount), day: todayIn(new Date(b.paid_at).getTime()) }));
    const balance = (await db.query("SELECT detail FROM operator_payables WHERE departure_id = $1 AND kind = 'balance' AND state <> 'cancelled'", [d.id])).rows[0];
    let operatorEgp = balance?.detail?.operatorAmount ?? null;
    if (operatorEgp == null) operatorEgp = (await expectedAmountFor(db, Number(d.id))).total;
    const commissions = (await db.query(
      "SELECT COALESCE(SUM(COALESCE(earned_eur, CASE WHEN state = 'pending' THEN amount_eur END)), 0) AS n FROM agency_commissions WHERE departure_id = $1", [d.id])).rows[0].n;
    const feesEur = fees ? round2(charges.reduce((s, ch) => s + ch.amountEur * (fees.percent / 100) + (fees.fixedEur || 0), 0)) : null;
    out.push({
      departure: { id: Number(d.id), date: ymd(d.date), status: d.status, label: `${d.code} ${d.title}` },
      ...departureMargin({ charges, operatorEgp, commissionsEur: Number(commissions), feesEur, rates }),
    });
  }
  return out;
}

// ---------------------------------------------------------------- legacy
// Legacy departures (not sold through the catalog) that are still open, and
// the date of the last one. They keep the existing settlement tools.
export async function legacyOpenDepartures(db = pool) {
  const r = (await db.query(
    `SELECT COUNT(*)::int AS n, MAX(COALESCE(d.end_date, d.start_date, d.date)) AS last
       FROM departures d
      WHERE d.status NOT IN ('cancelled', 'closed')
        AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id)`)).rows[0];
  return { open: r.n, lastDate: ymd(r.last) };
}
