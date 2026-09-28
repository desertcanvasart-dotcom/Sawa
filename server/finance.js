// Finance (model phase 3): what is owed and what was paid, the exchange-rate
// table, public holidays, penalty amounts and the margin report. Records
// only: no provider or bank is called. The rate table is also filled daily
// from an exchange-rate source since 064 (server/fx.js).
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { payableAccount } from "./bank-details.js";
import { receivablesByOperator, SOURCE_LABEL } from "./receivables.js";
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
  // 064: fetched rows say where from, and a pending or rejected one is shown
  // but never used (only `approved` rows are read anywhere else).
  return r.rows.map((x) => ({
    day: ymd(x.day), egpPerEur: Number(x.egp_per_eur), sourceNote: x.source_note, enteredBy: x.entered_by, enteredAt: x.entered_at,
    status: x.status || "approved", source: x.source || "manual", fetchedAt: x.fetched_at || null, providerAsOf: ymd(x.provider_as_of),
    previousEgpPerEur: x.previous_egp_per_eur == null ? null : Number(x.previous_egp_per_eur),
  }));
}
export async function setFxRate(db, { day, egpPerEur, sourceNote = null, by }) {
  if (!isYmd(day)) throw new CatalogueError(422, "Use a date like 2026-11-13.");
  const rate = Number(egpPerEur);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new CatalogueError(422, "Enter EGP per 1 EUR, e.g. 55.25.");
  await db.query(
    // Entered by hand: approved, and it replaces a fetched rate for the day
    // (including one waiting for approval).
    `INSERT INTO fx_rates (day, egp_per_eur, source_note, entered_by, status, source) VALUES ($1, $2, $3, $4, 'approved', 'manual')
     ON CONFLICT (day) DO UPDATE SET egp_per_eur = EXCLUDED.egp_per_eur, source_note = EXCLUDED.source_note, entered_by = EXCLUDED.entered_by, entered_at = now(),
       status = 'approved', source = 'manual', fetched_at = NULL, provider_as_of = NULL, decided_by = EXCLUDED.entered_by, decided_at = now()`,
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
// hold / draft where it can't be paid yet (its "standing").
export async function financeItems(db = pool, { from = null, to = null, party = null, standing = null, now = Date.now() } = {}) {
  const today = todayIn(now);
  const [payables, statements, invoices, payments, receivables] = await Promise.all([
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
    db.query(
      `SELECT r.*, o.legal_name, cd.date, c.code, c.title FROM operator_receivables r
         JOIN operators o ON o.id = r.operator_id JOIN catalogue_departures cd ON cd.id = r.departure_id
         JOIN catalogue_products c ON c.id = cd.product_id WHERE r.state <> 'cancelled'`),
  ]);
  const paidBy = new Map(payments.rows.map((p) => [`${p.payable_kind}:${p.payable_id}`, p]));
  const standingOf = (state, dueOn) => (state === "paid" ? "paid" : state === "offset" ? "offset" : state === "on_hold" ? "on_hold" : state === "draft" ? "draft"
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
      // What is left to transfer after set-off against what the operator owes.
      currency: "EGP", amount: p.amount == null ? null : Math.max(0, round2(Number(p.amount) - Number(p.setoff_egp || 0))),
      grossAmount: num(p.amount), setoffEgp: num(p.setoff_egp) || 0,
      dueOn: ymd(p.due_on), standing: standingOf(p.state, ymd(p.due_on)),
      holdReason: p.hold_reason, payment: payment("operator_payable", p.id),
    })),
    ...receivables.rows.map((r) => ({
      kind: "operator_receivable", id: Number(r.id), type: `Owed by operator: ${SOURCE_LABEL[r.source] || r.source}`,
      direction: "in", party: { kind: "operator", id: Number(r.operator_id), name: r.legal_name },
      departure: { id: Number(r.departure_id), date: ymd(r.date), label: `${r.code} ${r.title}` },
      currency: "EGP", amount: num(r.outstanding_egp), grossAmount: num(r.amount_egp), dueOn: null,
      standing: r.state === "settled" ? "paid" : "due", holdReason: r.reason, payment: null,
      note: "Set off automatically against the operator's next advance or balance.",
    })),
    ...statements.rows.map((s) => {
      // Sent by the 10th; due on the last day of the month it's sent.
      const due = s.sent_at ? new Date(Date.UTC(new Date(s.sent_at).getUTCFullYear(), new Date(s.sent_at).getUTCMonth() + 1, 0)).toISOString().slice(0, 10) : null;
      return {
        kind: "commission_statement", id: Number(s.id), type: `${s.basis === "pool" ? "Agency pool shares" : "Agency commission"}, ${s.period}`, direction: "out",
        party: { kind: "agency", id: s.agency_id, name: s.agency_name }, departure: null,
        currency: s.currency, amount: s.currency === "EGP" ? num(s.total_egp) : num(s.total_eur), amountEur: num(s.total_eur),
        dueOn: due, standing: standingOf(s.state, due), holdReason: s.hold_reason, payment: payment("commission_statement", s.id),
      };
    }),
    ...invoices.rows.map((i) => ({
      kind: "agency_invoice", id: Number(i.id), type: "Agency invoice (receivable)", direction: "in",
      party: { kind: "agency", id: i.agency_id, name: i.agency_name },
      departure: { id: Number(i.departure_id), date: ymd(i.date), label: `${i.code} ${i.title}` },
      currency: "EUR", amount: num(i.amount_eur), dueOn: ymd(i.due_on),
      // Pay at GoAhead: no due date until the payment deadline after GoAhead.
      standing: i.state === "due" && !i.due_on ? "on_hold" : standingOf(i.state, ymd(i.due_on)),
      holdReason: i.state === "due" && !i.due_on ? "Due at the payment deadline after GoAhead." : null, payment: payment("agency_invoice", i.id),
    })),
  ];
  return items
    .filter((x) => !from || (x.dueOn && x.dueOn >= from))
    .filter((x) => !to || (x.dueOn && x.dueOn <= to))
    .filter((x) => !party || `${x.party.kind}:${x.party.id}` === party || x.party.name?.toLowerCase().includes(String(party).toLowerCase()))
    .filter((x) => !standing || x.standing === standing)
    .sort((a, b) => String(a.dueOn || "9999").localeCompare(String(b.dueOn || "9999")));
}

export { receivablesByOperator };

export async function overdueSummary(db = pool, now = Date.now()) {
  const items = await financeItems(db, { now, standing: "overdue" });
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
    if (kind === "operator_receivable") {
      // Money the operator pays back. Part payments are normal; more than is
      // outstanding is refused.
      const r = (await c.query("SELECT * FROM operator_receivables WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw new CatalogueError(404, "Not found.");
      if (r.state !== "open") throw new CatalogueError(409, r.state === "settled" ? "Nothing is outstanding." : "This receivable was canceled.");
      const outstanding = Number(r.outstanding_egp);
      if (value > outstanding + 0.004) throw new CatalogueError(422, `Only EGP ${outstanding} is outstanding.`);
      const left = round2(outstanding - value);
      const pay = await c.query(
        `INSERT INTO finance_payments (payable_kind, payable_id, direction, currency, amount, due_amount, differs, paid_on, bank_reference, recorded_by)
         VALUES ('operator_receivable', $1, 'in', 'EGP', $2, $3, false, $4, $5, $6) RETURNING id`,
        [id, value, outstanding, paidOn, String(bankReference).trim().slice(0, 120), user?.email || null]);
      await c.query(
        `UPDATE operator_receivables SET outstanding_egp = $2, state = CASE WHEN $2::numeric = 0 THEN 'settled' ELSE 'open' END,
                settled_at = CASE WHEN $2::numeric = 0 THEN now() ELSE NULL END WHERE id = $1`, [id, left]);
      return { id: Number(pay.rows[0].id), kind, payableId: id, amount: value, due: outstanding, currency: "EGP", differs: false, outstanding: left };
    }
    if (kind === "operator_payable") {
      const p = (await c.query("SELECT * FROM operator_payables WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!p) throw new CatalogueError(404, "Not found.");
      if (p.state !== "due") {
        throw new CatalogueError(409, p.state === "paid" ? "Already paid." : p.state === "offset" ? "Nothing to transfer: this was set off against what the operator owes."
          : p.state === "on_hold" ? `On hold: ${p.hold_reason}` : `This is ${p.state}.`);
      }
      if (Number(p.amount) - Number(p.setoff_egp || 0) <= 0) throw new CatalogueError(409, "Nothing is owed to the operator on this line.");
      if (p.kind === "balance") {
        const st = (await c.query("SELECT state FROM settlement_statements WHERE departure_id = $1", [p.departure_id])).rows[0];
        if (st?.state === "disputed") throw new CatalogueError(409, "The operator disputes this statement. Resolve the dispute first.");
      }
      const acct = await payableAccount(c, Number(p.operator_id));
      if (!acct.ok) throw new CatalogueError(409, acct.reason);
      bankAccountId = acct.accountId;
      due = round2(Number(p.amount) - Number(p.setoff_egp || 0)); currency = "EGP";
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
      markPaid = async () => {
        await c.query("UPDATE agency_invoices SET state = 'paid', paid_at = now() WHERE id = $1", [id]);
        // Pay at GoAhead (phase 4): the invoice is the seat's payment, so
        // the seat's request is paid too and isn't released at the deadline.
        if (await hasPayRequests(c)) {
          await c.query(
            `UPDATE payment_requests SET state = 'paid', paid_at = now(), provider_reference = $2, recorded_by = $3
              WHERE pledge_id = $1 AND payer = 'agency' AND state IN ('awaiting_link', 'sent')`,
            [i.pledge_id, `bank transfer ${String(bankReference).trim().slice(0, 100)}`, user?.email || null]);
        }
      };
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

// Migration 051 applied? (The finance screens work before it.)
async function hasPayRequests(c) {
  const r = await c.query("SELECT to_regclass('public.payment_requests') AS t");
  return r.rows[0].t != null;
}

// ---------------------------------------------------------------- margin
// Before migration 061: per catalog departure, EUR charged (by charge date, net of refunds),
// operator cost (EGP) converted at the rate on each charge date, commissions
// and payment fees → margin in EUR. A missing rate is shown, never guessed.
export async function marginReport(db = pool, { from, to }) {
  const deps = (await db.query(
    `SELECT cd.id, cd.date, cd.status, cd.legacy_departure_id, c.code, c.title
       FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
      WHERE cd.date BETWEEN $1 AND $2 AND cd.status IN ('go_ahead', 'completed') ORDER BY cd.date`, [from, to])).rows;
  if (!deps.length) return [];
  const rates = new Map((await db.query("SELECT day, egp_per_eur FROM fx_rates WHERE status = 'approved'")).rows.map((r) => [ymd(r.day), Number(r.egp_per_eur)]));
  const fees = await feeSetting(db);
  const { expectedAmountFor } = await import("./assignments.js");
  const payAtGoAhead = await hasPayRequests(db);
  const tiers = payAtGoAhead ? await import("./cancellation-tiers.js") : null;
  const fx = tiers ? await tiers.latestFxRate(db) : null;
  const out = [];
  // Phase 5 (migration 061): the one calculation (server/pool-settlement.js).
  // The collecting agent's result in EGP: its commission, the pool on direct places,
  // less any Minimum Departure Guarantee, less payment costs, plus the FX line
  // (EUR collected at the CBE rate on each day, against nominal EGP revenue).
  const poolSettlement = await import("./pool-settlement.js");
  if (await poolSettlement.poolModelAvailable(db)) {
    for (const d of deps) {
      const money = await poolSettlement.departureMoney(db, Number(d.id));
      out.push({
        departure: { id: Number(d.id), date: ymd(d.date), status: d.status, label: `${d.code} ${d.title}` },
        model: "pool", currency: "EGP", ...money,
        marginEgp: money?.onlineEra?.resultEgp ?? null,
        problem: !money?.complete ? `rate card incomplete (${(money?.missing || []).slice(0, 3).join(", ")})`
          : money.fx.missingRates.length ? `exchange rate missing for ${money.fx.missingRates.join(", ")}`
          : !money.paymentFeesSet ? "payment fee setting missing" : null,
        lossWarnings: tiers ? await tiers.departureLossWarnings(db, { departureId: Number(d.id), fx }) : [],
      });
    }
    return out;
  }
  for (const d of deps) {
    const charges = (await db.query(
      `SELECT b.amount, b.paid_at, b.state FROM booking_payments b JOIN pledges p ON p.id = b.pledge_id
        WHERE p.departure_id = $1 AND b.state = 'paid' AND b.paid_at IS NOT NULL`, [d.legacy_departure_id])).rows
      .map((b) => ({ amountEur: Number(b.amount), day: todayIn(new Date(b.paid_at).getTime()) }));
    // Pay at GoAhead (phase 4): the full-price payments, by the day each was
    // recorded paid, less what was refunded (by the day of the refund).
    if (payAtGoAhead) {
      const paid = (await db.query(
        "SELECT amount_eur, paid_at FROM payment_requests WHERE departure_id = $1 AND paid_at IS NOT NULL AND state IN ('paid')", [d.id])).rows;
      for (const r of paid) charges.push({ amountEur: Number(r.amount_eur), day: todayIn(new Date(r.paid_at).getTime()) });
      const back = (await db.query(
        `SELECT f.amount_eur, COALESCE(f.done_at, f.created_at) AS at FROM payment_refunds f JOIN payment_requests r ON r.id = f.request_id
          WHERE r.departure_id = $1 AND f.state <> 'cancelled' AND f.amount_eur > 0`, [d.id])).rows;
      for (const f of back) charges.push({ amountEur: -Number(f.amount_eur), day: todayIn(new Date(f.at).getTime()) });
    }
    const balance = (await db.query("SELECT detail FROM operator_payables WHERE departure_id = $1 AND kind = 'balance' AND state <> 'cancelled'", [d.id])).rows[0];
    let operatorEgp = balance?.detail?.operatorAmount ?? null;
    if (operatorEgp == null) operatorEgp = (await expectedAmountFor(db, Number(d.id))).total;
    const commissions = (await db.query(
      "SELECT COALESCE(SUM(COALESCE(earned_eur, CASE WHEN state = 'pending' THEN amount_eur END)), 0) AS n FROM agency_commissions WHERE departure_id = $1", [d.id])).rows[0].n;
    const feesEur = fees ? round2(charges.reduce((s, ch) => s + ch.amountEur * (fees.percent / 100) + (fees.fixedEur || 0), 0)) : null;
    out.push({
      departure: { id: Number(d.id), date: ymd(d.date), status: d.status, label: `${d.code} ${d.title}` },
      ...departureMargin({ charges, operatorEgp, commissionsEur: Number(commissions), feesEur, rates }),
      // Phase 4: tier windows where a cancellation would lose money
      // (clause 10.2), under the departure's locked rate.
      lossWarnings: tiers ? await tiers.departureLossWarnings(db, { departureId: Number(d.id), fx }) : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------- legacy
// Legacy departures (not sold through the catalog) still to run, and the date
// of the last one. They keep the old Settlements module until they are done.
//
// "Still to run" is not canceled or closed AND ending today or later: nothing
// marks a date closed after it runs, so without the date a tour that ran long
// ago would count as open for ever.
//
// canRetire: none still to run, and every legacy payout paid: no Wednesday run
// in draft, no transfer due, and no ended date that went ahead with money
// collected but has never been in an approved run. Shown on Admin → Finance;
// switching the old module off is a separate, deliberate decision.
export async function legacyOpenDepartures(db = pool, { today = todayIn() } = {}) {
  const r = (await db.query(
    `SELECT COUNT(*)::int AS n, MAX(COALESCE(d.end_date, d.start_date, d.date)) AS last
       FROM departures d
      WHERE d.status NOT IN ('cancelled', 'closed')
        AND COALESCE(d.end_date, d.start_date, d.date) >= $1::date
        AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id)`, [today])).rows[0];
  const has = async (t) => (await db.query("SELECT to_regclass($1) AS t", [`public.${t}`])).rows[0].t != null;
  let draftRuns = 0, duePayouts = 0, unsettled = 0;
  if (await has("payout_runs")) {
    draftRuns = (await db.query("SELECT COUNT(*)::int AS n FROM payout_runs WHERE state = 'draft'")).rows[0].n;
    duePayouts = (await db.query("SELECT COUNT(*)::int AS n FROM payout_transfers WHERE state = 'due'")).rows[0].n;
    if (await has("booking_payments")) {
      unsettled = (await db.query(
        `SELECT COUNT(*)::int AS n FROM departures d
          WHERE d.status IN ('minimum_reached', 'supplier_confirmed')
            AND COALESCE(d.end_date, d.start_date, d.date) < $1::date
            AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id)
            AND EXISTS (SELECT 1 FROM pledges p JOIN booking_payments b ON b.pledge_id = p.id
                         WHERE p.departure_id = d.id AND b.state = 'paid')
            AND NOT EXISTS (SELECT 1 FROM payout_lines l JOIN payout_runs pr ON pr.id = l.run_id
                             WHERE l.departure_id = d.id AND pr.state = 'approved')`, [today])).rows[0].n;
    }
  }
  return {
    open: r.n, lastDate: ymd(r.last), draftRuns, duePayouts, unsettled,
    canRetire: r.n === 0 && draftRuns === 0 && duePayouts === 0 && unsettled === 0,
  };
}
