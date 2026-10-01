// Routes for model phase 3: finance, operator settlement, bank details,
// agency commission, and the booking-details link. Records only.
//
// Admin routes: platform staff (recording a payment that differs from what is
// due, and agency billing settings: super admin). They work with the flag off,
// like phases 1–2's admin screens; nothing they do reaches anyone outside Sawa
// until the flag is on. Operator, agency and public routes answer 404 with
// catalogue_v2 off.
import { z } from "zod";
import { pool } from "./db/index.js";
import { CatalogueError, isMissingCatalogueTables, todayIn } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import {
  financeItems, overdueSummary, recordPayment, receivablesByOperator, listFxRates, setFxRate, deleteFxRate, listHolidays, setHoliday, deleteHoliday,
  listPenaltyRates, setPenaltyRate, feeSetting, setFeeSetting, marginReport, legacyOpenDepartures,
} from "./finance.js";
import {
  settlementFigures, addAdjustment, voidAdjustment, sendStatement, disputeStatement, resolveStatement, statementFor,
  mapPayable, mapStatementRow,
} from "./operator-settlement.js";
import { bankAccountsFor, submitBankDetails, decideBankDetails } from "./bank-details.js";
import { agencyOperator } from "./operators.js";
import { mapCommission, mapStatement, buildCommissionStatement } from "./commissions.js";
import { bookingDetailsByToken, saveBookingDetailsByToken } from "./booking-details.js";
import { statementPdf } from "./pdf.js";
import {
  fxOverview, runFxDaily, releaseHeldPayments, decideFxRate, afterManualRate, setTravellerBuffer, setExchangeRateMode, exchangeRateSummary,
} from "./fx.js";
import { mapReceivable } from "./receivables.js";

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13.");

export function registerFinanceRoutes(app, { requireAuth, requireRole, h, logAudit, sendEmail, opsRecipient, writeLimiter }) {
  const staff = [requireAuth, requireRole("super_admin", "ops_staff")];
  const superAdmin = [requireAuth, requireRole("super_admin")];
  const operatorOnly = [requireAuth, requireRole("operator_owner", "operator_staff")];
  const agencyOnly = [requireAuth, requireRole("agency_owner", "agency_agent")];
  const send = () => (catalogueV2Enabled() ? sendEmail : null);
  const by = (req) => req.user?.email || req.user?.id || null;
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new CatalogueError(404, "Not found.");
    return n;
  };
  const route = (fn) => h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (isMissingCatalogueTables(e)) {
        throw Object.assign(new CatalogueError(503, "Finance isn't switched on yet: migration 050 has not been applied to this database."), { expose: true });
      }
      if (e?.warning) return res.status(e.status || 409).json({ error: e.message, warning: e.warning });
      throw e;
    }
  });
  const flagged = (fn) => route(async (req, res) => {
    if (!catalogueV2Enabled()) throw new CatalogueError(404, "Not found.");
    await fn(req, res);
  });
  const portal = (fn) => flagged(async (req, res) => {
    if (!req.user?.operatorId) throw new CatalogueError(403, "This login isn't linked to an operator.");
    await fn(req, res);
  });

  // ============================================================== admin
  app.get("/api/admin/features", ...staff, h(async (_req, res) => {
    res.json({ catalogueV2: catalogueV2Enabled() });
  }));

  app.get("/api/admin/finance", ...staff, route(async (req, res) => {
    const q = z.object({
      from: ymdSchema.optional(), to: ymdSchema.optional(), party: z.string().max(120).optional(),
      standing: z.enum(["due", "overdue", "paid", "on_hold", "draft"]).optional(),
    }).parse(req.query || {});
    const [items, overdue, legacy, receivables] = await Promise.all([financeItems(pool, q), overdueSummary(pool), legacyOpenDepartures(pool), receivablesByOperator(pool)]);
    res.json({ items, overdue, legacy, receivables, today: todayIn() });
  }));

  app.get("/api/admin/finance/overdue", ...staff, route(async (_req, res) => {
    res.json(await overdueSummary(pool));
  }));

  app.post("/api/admin/finance/payments", ...staff, route(async (req, res) => {
    const input = z.object({
      kind: z.enum(["operator_payable", "commission_statement", "agency_invoice", "operator_receivable"]), id: z.number().int().positive(),
      amount: z.coerce.number().positive(), paidOn: ymdSchema, bankReference: z.string().trim().min(2).max(120),
      override: z.boolean().optional(), overrideReason: z.string().trim().max(500).optional(),
    }).parse(req.body || {});
    const payment = await recordPayment(pool, { ...input, user: req.user });
    await logAudit(req, { action: "finance.payment", entity: input.kind, entityId: input.id, detail: payment });
    res.status(201).json({ payment });
  }));

  // Reference tables.
  app.get("/api/admin/finance/settings", ...staff, route(async (_req, res) => {
    const [fx, holidays, penalties, fees] = await Promise.all([listFxRates(pool), listHolidays(pool), listPenaltyRates(pool), feeSetting(pool)]);
    res.json({ fxRates: fx, holidays, penalties, fees });
  }));
  app.put("/api/admin/finance/fx-rates/:day", ...staff, route(async (req, res) => {
    const out = await setFxRate(pool, { day: ymdSchema.parse(req.params.day), egpPerEur: req.body?.egpPerEur, sourceNote: req.body?.sourceNote, by: by(req) });
    await logAudit(req, { action: "finance.fx_rate", entity: "fx_rate", entityId: out.day, detail: out });
    // The rate is saved either way; a follow-up that fails (before 064) is
    // logged, not hidden.
    await afterManualRate(pool, { by: by(req) })
      .then((r) => (r?.changed ? releaseHeldPayments({ send: sendEmail }) : null))
      .catch((e) => console.error("[finance] after a manual rate: pending alert and traveler rate not updated —", e.message));
    res.json(out);
  }));

  // 064 — the automatic rate. Before the migration these answer 503.
  const fxRoute = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e?.code === "42P01" || e?.code === "42703") {
        throw Object.assign(new CatalogueError(503, "The automatic exchange rate isn't switched on yet: migration 064 has not been applied to this database."), { expose: true });
      }
      throw e;
    }
  };
  app.get("/api/admin/finance/fx", ...staff, route(async (_req, res) => {
    res.json(await fxRoute(() => fxOverview(pool)));
  }));
  // Fetch today's rate now (the daily job does the same; a day that already
  // has a rate is left alone).
  app.post("/api/admin/finance/fx/fetch", ...staff, writeLimiter, route(async (req, res) => {
    const out = await fxRoute(() => runFxDaily({ db: pool, send: sendEmail }));
    await logAudit(req, { action: "finance.fx_fetch", entity: "fx_rate", entityId: out.market?.day || null, detail: out });
    res.json(out);
  }));
  app.post("/api/admin/finance/fx-rates/:day/:decision", ...staff, route(async (req, res) => {
    const decision = String(req.params.decision);
    if (!["approve", "reject"].includes(decision)) throw new CatalogueError(404, "Not found.");
    const out = await fxRoute(() => decideFxRate(pool, { day: ymdSchema.parse(req.params.day), approve: decision === "approve", by: by(req) }));
    if (out.traveller?.changed) await releaseHeldPayments({ send: sendEmail });
    await logAudit(req, { action: `finance.fx_rate.${decision}`, entity: "fx_rate", entityId: req.params.day, detail: out });
    res.json(out);
  }));
  app.put("/api/admin/finance/traveller-rate/buffer", ...staff, route(async (req, res) => {
    const out = await fxRoute(() => setTravellerBuffer(pool, { bufferPct: req.body?.bufferPct, by: by(req) }));
    await logAudit(req, { action: "finance.traveller_rate.buffer", entity: "finance_settings", entityId: "traveller_rate", detail: out });
    res.json(out);
  }));
  // Phase 7: the exchange-rate mode (automatic or manual), one site-wide
  // setting, from Finance or any rate card. Recorded in the rate's history and
  // the audit log, with the reason.
  app.get("/api/admin/finance/exchange-rate", ...staff, route(async (_req, res) => {
    res.json(await fxRoute(() => exchangeRateSummary(pool)));
  }));
  app.put("/api/admin/finance/exchange-rate", ...staff, writeLimiter, route(async (req, res) => {
    const out = await fxRoute(() => setExchangeRateMode(pool, {
      mode: req.body?.mode, egpPerEur: req.body?.egpPerEur, reason: req.body?.reason, by: by(req) }));
    await logAudit(req, { action: `finance.exchange_rate.${out.mode}`, entity: "fx_traveller_rate", entityId: out.rate.id, detail: { ...out, reason: req.body?.reason || null } });
    await releaseHeldPayments({ send: sendEmail });
    res.json({ ...out, summary: await exchangeRateSummary(pool) });
  }));
  app.delete("/api/admin/finance/fx-rates/:day", ...staff, route(async (req, res) => {
    await deleteFxRate(pool, ymdSchema.parse(req.params.day));
    await logAudit(req, { action: "finance.fx_rate.delete", entity: "fx_rate", entityId: req.params.day });
    res.json({ ok: true });
  }));
  app.put("/api/admin/finance/holidays/:day", ...staff, route(async (req, res) => {
    const out = await setHoliday(pool, { day: ymdSchema.parse(req.params.day), name: req.body?.name, by: by(req) });
    await logAudit(req, { action: "finance.holiday", entity: "holiday", entityId: out.day, detail: out });
    res.json(out);
  }));
  app.delete("/api/admin/finance/holidays/:day", ...staff, route(async (req, res) => {
    await deleteHoliday(pool, ymdSchema.parse(req.params.day));
    await logAudit(req, { action: "finance.holiday.delete", entity: "holiday", entityId: req.params.day });
    res.json({ ok: true });
  }));
  app.put("/api/admin/finance/penalties/:code", ...staff, route(async (req, res) => {
    const out = await setPenaltyRate(pool, { code: String(req.params.code), amountEgp: req.body?.amountEgp, by: by(req) });
    await logAudit(req, { action: "finance.penalty_rate", entity: "penalty_rate", entityId: out.code, detail: out });
    res.json(out);
  }));
  app.put("/api/admin/finance/fees", ...staff, route(async (req, res) => {
    const out = await setFeeSetting(pool, { percent: req.body?.percent, fixedEur: req.body?.fixedEur, by: by(req) });
    await logAudit(req, { action: "finance.fees", entity: "finance_settings", entityId: "payment_fees", detail: out });
    res.json(out);
  }));

  app.get("/api/admin/finance/margin", ...staff, route(async (req, res) => {
    const from = req.query.from ? ymdSchema.parse(String(req.query.from)) : `${todayIn().slice(0, 7)}-01`;
    const to = req.query.to ? ymdSchema.parse(String(req.query.to)) : todayIn();
    res.json({ from, to, rows: await marginReport(pool, { from, to }) });
  }));

  // Settlement of one catalog departure.
  app.get("/api/admin/catalogue/departures/:id/settlement", ...staff, route(async (req, res) => {
    const depId = id(req.params.id);
    const f = await settlementFigures(pool, depId);
    const payables = (await pool.query("SELECT * FROM operator_payables WHERE departure_id = $1 ORDER BY id", [depId])).rows.map(mapPayable);
    const legacy = (await pool.query("SELECT legacy_departure_id FROM catalogue_departures WHERE id = $1", [depId])).rows[0]?.legacy_departure_id;
    const costLines = legacy ? (await pool.query(
      "SELECT id, category, description, amount, state, receipt_url FROM departure_costs WHERE departure_id = $1 AND state = 'approved' ORDER BY id", [legacy]).catch((e) => {
      if (isMissingCatalogueTables(e)) return { rows: [] };
      throw e;
    })).rows.map((c) => ({ id: Number(c.id), category: c.category, description: c.description, amount: Number(c.amount), hasReceipt: !!c.receipt_url })) : [];
    res.json({
      departure: f.departure, operator: f.party, expected: f.expected, adjustments: f.adjustments,
      deductions: f.deductions, deductionsApplied: f.deductionsApplied, capped: f.capped, reimbursements: f.reimbursements,
      advance: f.advance, balance: f.balance, payables, statement: await statementFor(pool, depId),
      receivables: (await pool.query("SELECT * FROM operator_receivables WHERE departure_id = $1 AND state <> 'cancelled' ORDER BY id", [depId])).rows.map(mapReceivable),
      penalties: await listPenaltyRates(pool), costLines,
      // The cost sheet lives on the legacy departure row; lines are added
      // through POST /api/admin/settlements/:legacyId/costs.
      legacyDepartureId: legacy != null ? Number(legacy) : null,
    });
  }));

  app.post("/api/admin/catalogue/departures/:id/adjustments", ...staff, route(async (req, res) => {
    const input = z.object({
      kind: z.enum(["penalty", "service_failure", "reimbursement"]), penaltyCode: z.string().max(60).nullable().optional(),
      travelers: z.number().int().min(1).max(12).nullable().optional(), amountEgp: z.coerce.number().min(0).nullable().optional(),
      reason: z.string().trim().min(3).max(2000), clauseRef: z.string().trim().max(120).optional(),
      evidence: z.array(z.string().trim().max(1000)).max(20).optional(), costLineIds: z.array(z.number().int().positive()).max(50).optional(),
    }).parse(req.body || {});
    const adj = await addAdjustment(pool, { departureId: id(req.params.id), ...input, by: by(req) });
    await logAudit(req, { action: "settlement.adjustment", entity: "catalogue_departure", entityId: req.params.id, detail: adj });
    res.status(201).json({ adjustment: adj });
  }));

  app.post("/api/admin/operator-adjustments/:id/void", ...staff, route(async (req, res) => {
    const out = await voidAdjustment(pool, { id: id(req.params.id), reason: req.body?.reason, by: by(req) });
    await logAudit(req, { action: "settlement.adjustment.void", entity: "operator_adjustment", entityId: req.params.id, detail: { reason: req.body?.reason } });
    res.json(out);
  }));

  app.post("/api/admin/catalogue/departures/:id/statement/send", ...staff, route(async (req, res) => {
    const st = await sendStatement(pool, { departureId: id(req.params.id), by: by(req), send: send() });
    await logAudit(req, { action: "settlement.statement.send", entity: "catalogue_departure", entityId: req.params.id, detail: { balance: st.snapshot?.balance } });
    res.json({ statement: st });
  }));

  app.post("/api/admin/catalogue/departures/:id/statement/resolve", ...staff, route(async (req, res) => {
    const st = await resolveStatement(pool, { departureId: id(req.params.id), note: req.body?.note, by: by(req) });
    await logAudit(req, { action: "settlement.statement.resolve", entity: "catalogue_departure", entityId: req.params.id, detail: { note: st.resolutionNote } });
    res.json({ statement: st });
  }));

  app.get("/api/admin/catalogue/departures/:id/statement.pdf", ...staff, route(async (req, res) => {
    const st = await statementFor(pool, id(req.params.id));
    if (!st) throw new CatalogueError(404, "No statement for this departure yet.");
    res.set("Content-Type", "application/pdf").set("Content-Disposition", `inline; filename="statement-${req.params.id}.pdf"`).send(statementPdf(st));
  }));

  // Operator bank details (admin side).
  app.get("/api/admin/operators/:id/bank", ...staff, route(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ accounts: await bankAccountsFor(pool, id(req.params.id), { user: req.user }) });
  }));
  app.post("/api/admin/operators/:id/bank", ...staff, route(async (req, res) => {
    const account = await submitBankDetails(pool, id(req.params.id), req.body || {}, { user: req.user, send: send(), adminEmail: opsRecipient() });
    await logAudit(req, { action: "operator.bank.submit", entity: "operator", entityId: req.params.id, detail: { accountId: account.id } });
    res.status(201).json({ account });
  }));
  app.post("/api/admin/operator-bank/:id/decide", ...staff, route(async (req, res) => {
    const input = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).parse(req.body || {});
    const account = await decideBankDetails(pool, id(req.params.id), { ...input, user: req.user });
    await logAudit(req, { action: input.approve ? "operator.bank.verify" : "operator.bank.reject", entity: "operator", entityId: account.operatorId, detail: { accountId: account.id } });
    res.json({ account });
  }));

  // Agency commission (admin side) and billing settings.
  app.get("/api/admin/commissions", ...staff, route(async (req, res) => {
    const agencyId = req.query.agencyId ? String(req.query.agencyId) : null;
    const [lines, statements, agencies] = await Promise.all([
      pool.query(`SELECT ac.*, cd.date, c.code, c.title, a.name AS agency_name FROM agency_commissions ac
                    JOIN catalogue_departures cd ON cd.id = ac.departure_id JOIN catalogue_products c ON c.id = cd.product_id
                    JOIN agencies a ON a.id = ac.agency_id
                   WHERE ($1::text IS NULL OR ac.agency_id = $1) ORDER BY cd.date DESC LIMIT 500`, [agencyId]),
      pool.query("SELECT * FROM commission_statements WHERE ($1::text IS NULL OR agency_id = $1) ORDER BY period DESC, agency_id", [agencyId]),
      pool.query("SELECT id, name, country_code, billing_approved, billing_due_days FROM agencies ORDER BY name"),
    ]);
    res.json({
      commissions: lines.rows.map((r) => ({ ...mapCommission(r), date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date, product: `${r.code} ${r.title}`, agencyName: r.agency_name })),
      statements: statements.rows.map(mapStatement),
      agencies: agencies.rows.map((a) => ({ id: a.id, name: a.name, countryCode: a.country_code, billingApproved: a.billing_approved, billingDueDays: a.billing_due_days })),
    });
  }));
  app.post("/api/admin/commission-statements/rebuild", ...staff, route(async (req, res) => {
    const input = z.object({ agencyId: z.string().min(1), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body || {});
    const st = await buildCommissionStatement(pool, input.agencyId, input.period);
    res.json({ statement: st ? mapStatement(st) : null });
  }));
  app.patch("/api/admin/agencies/:id/billing", ...superAdmin, route(async (req, res) => {
    const input = z.object({
      countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).nullable().optional(),
      billingApproved: z.boolean().optional(), billingDueDays: z.number().int().min(0).max(120).optional(),
    }).parse(req.body || {});
    const r = await pool.query(
      `UPDATE agencies SET country_code = CASE WHEN $2 THEN $3 ELSE country_code END,
              billing_approved = COALESCE($4, billing_approved), billing_due_days = COALESCE($5, billing_due_days)
        WHERE id = $1 RETURNING id, name, country_code, billing_approved, billing_due_days`,
      [String(req.params.id), "countryCode" in input, input.countryCode ? input.countryCode.toUpperCase() : null,
        input.billingApproved ?? null, input.billingDueDays ?? null]);
    if (!r.rows.length) throw new CatalogueError(404, "Agency not found.");
    await logAudit(req, { action: "agency.billing", entity: "agency", entityId: req.params.id, detail: input });
    const a = r.rows[0];
    res.json({ agency: { id: a.id, name: a.name, countryCode: a.country_code, billingApproved: a.billing_approved, billingDueDays: a.billing_due_days } });
  }));

  // ============================================================== operator portal
  app.get("/api/operator/statements", ...operatorOnly, portal(async (req, res) => {
    const r = await pool.query(
      "SELECT * FROM settlement_statements WHERE operator_id = $1 AND state <> 'draft' ORDER BY sent_at DESC LIMIT 200", [req.user.operatorId]);
    const payables = (await pool.query(
      "SELECT * FROM operator_payables WHERE operator_id = $1 AND state <> 'cancelled' ORDER BY due_on DESC NULLS LAST LIMIT 200", [req.user.operatorId])).rows.map(mapPayable);
    const receivables = (await pool.query(
      "SELECT * FROM operator_receivables WHERE operator_id = $1 AND state <> 'cancelled' ORDER BY created_at DESC LIMIT 200", [req.user.operatorId])).rows.map(mapReceivable);
    res.json({ statements: r.rows.map(mapStatementRow), payables, receivables });
  }));
  const ownStatement = async (req) => {
    const st = await statementFor(pool, id(req.params.id));
    if (!st || st.operatorId !== req.user.operatorId || st.state === "draft") throw new CatalogueError(404, "Statement not found.");
    return st;
  };
  app.get("/api/operator/statements/:id.pdf", ...operatorOnly, portal(async (req, res) => {
    const st = await ownStatement(req);
    res.set("Content-Type", "application/pdf").set("Content-Disposition", `inline; filename="statement-${req.params.id}.pdf"`).send(statementPdf(st));
  }));
  app.post("/api/operator/statements/:id/dispute", ...operatorOnly, portal(async (req, res) => {
    await ownStatement(req);
    const st = await disputeStatement(pool, { departureId: id(req.params.id), operatorId: req.user.operatorId, reason: req.body?.reason, by: req.user.email });
    await logAudit(req, { action: "settlement.statement.dispute", entity: "catalogue_departure", entityId: req.params.id, detail: { reason: st.disputeReason } });
    res.json({ statement: st });
  }));
  app.get("/api/operator/bank", ...operatorOnly, portal(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ accounts: await bankAccountsFor(pool, req.user.operatorId, { user: req.user, reveal: false }) });
  }));
  app.post("/api/operator/bank", ...operatorOnly, writeLimiter, portal(async (req, res) => {
    if (req.user.role !== "operator_owner") throw new CatalogueError(403, "Only the operator's owner can change its bank details.");
    const account = await submitBankDetails(pool, req.user.operatorId, req.body || {}, { user: req.user, send: send(), adminEmail: opsRecipient() });
    await logAudit(req, { action: "operator.bank.submit", entity: "operator", entityId: req.user.operatorId, detail: { accountId: account.id } });
    res.status(201).json({ account: { ...account, accountNumber: account.accountNumber ? `•••• ${String(account.accountNumber).slice(-4)}` : null, iban: account.iban ? `•••• ${String(account.iban).slice(-4)}` : null } });
  }));

  // An agency's bank details, from its dashboard (068). Same rules as the
  // operator portal: a change waits for an admin to verify it (Operators → the
  // company → Bank details), the holder must be the company's legal name, and
  // the agency and Sawa's admin are emailed about every change. Works with the
  // catalogue_v2 flag off.
  const agencyOperatorId = async (req, { create = false } = {}) => {
    if (!req.user?.agencyId) throw new CatalogueError(403, "This account is not linked to an agency.");
    const op = await agencyOperator(pool, req.user.agencyId, { create, by: req.user.email || req.user.id });
    return op?.id ?? null;
  };
  const masked = (a) => ({ ...a, accountNumber: a.accountNumber ? `•••• ${String(a.accountNumber).slice(-4)}` : null, iban: a.iban ? `•••• ${String(a.iban).slice(-4)}` : null });
  app.get("/api/agency/bank", ...agencyOnly, route(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const oid = await agencyOperatorId(req);
    res.json({ accounts: oid ? await bankAccountsFor(pool, oid, { user: req.user, reveal: false }) : [] });
  }));
  app.post("/api/agency/bank", ...agencyOnly, writeLimiter, route(async (req, res) => {
    if (req.user.role !== "agency_owner") throw new CatalogueError(403, "Only the agency's owner can change its bank details.");
    const oid = await agencyOperatorId(req, { create: true });
    const account = await submitBankDetails(pool, oid, req.body || {}, { user: req.user, send: sendEmail, adminEmail: opsRecipient() });
    await logAudit(req, { action: "operator.bank.submit", entity: "operator", entityId: oid, detail: { accountId: account.id, agencyId: req.user.agencyId } });
    res.status(201).json({ account: masked(account) });
  }));

  // ============================================================== agency portal
  app.get("/api/agency/commissions", ...agencyOnly, flagged(async (req, res) => {
    if (!req.user.agencyId) throw new CatalogueError(403, "This account is not linked to an agency.");
    const [lines, statements, invoices] = await Promise.all([
      pool.query(`SELECT ac.*, cd.date, c.code, c.title, p.customers FROM agency_commissions ac
                    JOIN catalogue_departures cd ON cd.id = ac.departure_id JOIN catalogue_products c ON c.id = cd.product_id
                    JOIN pledges p ON p.id = ac.pledge_id WHERE ac.agency_id = $1 ORDER BY cd.date DESC LIMIT 500`, [req.user.agencyId]),
      pool.query("SELECT * FROM commission_statements WHERE agency_id = $1 AND state <> 'draft' ORDER BY period DESC", [req.user.agencyId]),
      pool.query(`SELECT i.*, cd.date, c.title FROM agency_invoices i JOIN catalogue_departures cd ON cd.id = i.departure_id
                    JOIN catalogue_products c ON c.id = cd.product_id WHERE i.agency_id = $1 ORDER BY i.due_on DESC LIMIT 200`, [req.user.agencyId]),
    ]);
    res.json({
      commissions: lines.rows.map((r) => ({ ...mapCommission(r), date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date, product: `${r.code} ${r.title}`, client: r.customers })),
      statements: statements.rows.map(mapStatement),
      invoices: invoices.rows.map((i) => ({
        id: Number(i.id), pledgeId: i.pledge_id, title: i.title, date: i.date instanceof Date ? i.date.toISOString().slice(0, 10) : i.date,
        grossEur: Number(i.gross_eur), commissionEur: Number(i.commission_eur), amountEur: Number(i.amount_eur),
        dueOn: i.due_on instanceof Date ? i.due_on.toISOString().slice(0, 10) : i.due_on, state: i.state,
      })),
    });
  }));

  // ============================================================== booking details link
  app.get("/api/public/booking-details/:token", flagged(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await bookingDetailsByToken(String(req.params.token).slice(0, 200)));
  }));
  app.post("/api/public/booking-details/:token", writeLimiter, flagged(async (req, res) => {
    const out = await saveBookingDetailsByToken(String(req.params.token).slice(0, 200), req.body || {});
    await logAudit(req, { action: "booking.details.complete", entity: "pledge", entityId: out.pledgeId });
    res.json({ ok: true });
  }));
}
