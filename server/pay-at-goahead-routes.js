// Routes for model phase 4: pay at GoAhead and the cancellation tiers.
//
// Admin only (platform staff; publishing tiers and the payment settings:
// super admin). Like phases 1–3's admin screens they answer with the flag
// off, and nothing they do reaches a traveler until it is on: with it off no
// booking is on pay at GoAhead. The public routes are in server/app.js.
import { z } from "zod";
import { pool } from "./db/index.js";
import { CatalogueError } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import {
  isMissingTierTables, listTierVersions, tierVersionInForce, createTierDraft, saveTierDraft, publishTierDraft,
  discardTierDraft, tierLossReport,
} from "./cancellation-tiers.js";
import {
  payAtGoAheadOverview, setPayAtGoAheadSettings, attachLink, markRequestPaid, extendDeadline, cancellationQuote,
  cancelPayAtGoAheadBooking, completeRefund, decideUnlinkedSeat, unlinkedSummary,
} from "./pay-at-goahead.js";
import { listTermsVersions, termsVersionInForce, createTermsDraft, saveTermsDraft, publishTermsDraft, discardTermsDraft } from "./terms-versions.js";

export function registerPayAtGoAheadRoutes(app, { requireAuth, requireRole, h, logAudit, sendEmail, writeLimiter }) {
  const staff = [requireAuth, requireRole("super_admin", "ops_staff")];
  const superAdmin = [requireAuth, requireRole("super_admin")];
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
      if (isMissingTierTables(e) || (e?.code === "42P01" && /terms_versions/.test(e?.message || "")) || e?.code === "42703") {
        throw Object.assign(new CatalogueError(503, "Pay at GoAhead isn't switched on yet: migrations 051 and 052 have not been applied to this database."), { expose: true });
      }
      throw e;
    }
  });

  // ---------------------------------------------------------------- tiers
  app.get("/api/admin/cancellation-tiers", ...staff, route(async (_req, res) => {
    const [versions, inForce] = await Promise.all([listTierVersions(pool), tierVersionInForce(pool)]);
    res.json({ versions, inForceId: inForce?.id ?? null });
  }));

  app.post("/api/admin/cancellation-tiers/draft", ...staff, writeLimiter, route(async (req, res) => {
    res.status(201).json({ version: await createTierDraft(pool, { by: by(req) }) });
  }));

  app.put("/api/admin/cancellation-tiers/:id", ...staff, writeLimiter, route(async (req, res) => {
    const v = await saveTierDraft(pool, { versionId: id(req.params.id), rows: req.body?.rows, note: req.body?.note, by: by(req) });
    await logAudit(req, { action: "cancellation_tiers.save", entity: "cancellation_tier_version", entityId: v.id, detail: { version: v.version, rows: v.rows } });
    res.json({ version: v });
  }));

  app.post("/api/admin/cancellation-tiers/:id/publish", ...superAdmin, writeLimiter, route(async (req, res) => {
    const effectiveFrom = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.body?.effectiveFrom);
    if (!effectiveFrom.success) throw new CatalogueError(422, "Choose the date the tiers take effect.");
    const v = await publishTierDraft(pool, { versionId: id(req.params.id), effectiveFrom: effectiveFrom.data, by: by(req) });
    await logAudit(req, { action: "cancellation_tiers.publish", entity: "cancellation_tier_version", entityId: v.id, detail: { version: v.version, effectiveFrom: v.effectiveFrom } });
    res.json({ version: v });
  }));

  app.delete("/api/admin/cancellation-tiers/:id", ...staff, route(async (req, res) => {
    const r = await discardTierDraft(pool, id(req.params.id));
    await logAudit(req, { action: "cancellation_tiers.discard", entity: "cancellation_tier_version", entityId: r.discarded });
    res.json(r);
  }));

  // The loss check (clause 10.2) for a version: every active product, the
  // windows after its cut-off or GoAhead deadline, flagged where a
  // cancellation loses money.
  app.get("/api/admin/cancellation-tiers/:id/loss-check", ...staff, route(async (req, res) => {
    res.json(await tierLossReport(pool, { versionId: id(req.params.id) }));
  }));

  // ---------------------------------------------------------------- pay at GoAhead
  app.get("/api/admin/pay-at-goahead", ...staff, route(async (_req, res) => {
    res.json(await payAtGoAheadOverview(pool));
  }));

  app.put("/api/admin/pay-at-goahead/settings", ...superAdmin, writeLimiter, route(async (req, res) => {
    const value = await setPayAtGoAheadSettings(pool, { windowHours: req.body?.windowHours, offerHours: req.body?.offerHours, by: by(req) });
    await logAudit(req, { action: "pay_at_goahead.settings", entity: "finance_settings", entityId: "pay_at_goahead", detail: value });
    res.json({ settings: value });
  }));

  // Ops paste the Tab link they made (reference: the booking code); Sawa
  // emails it and the deadline starts.
  app.post("/api/admin/pay-requests/:id/link", ...staff, writeLimiter, route(async (req, res) => {
    const r = await attachLink(pool, { requestId: id(req.params.id), linkUrl: req.body?.linkUrl, by: by(req), send: send() });
    await logAudit(req, { action: "pay_request.link", entity: "payment_request", entityId: r.id, detail: { pledgeId: r.pledgeId, dueAt: r.dueAt, dueBoundBy: r.dueBoundBy } });
    res.json({ request: r });
  }));

  app.post("/api/admin/pay-requests/:id/paid", ...staff, writeLimiter, route(async (req, res) => {
    const r = await markRequestPaid(pool, { requestId: id(req.params.id), providerReference: req.body?.providerReference, by: by(req), send: send() });
    await logAudit(req, { action: "pay_request.paid", entity: "payment_request", entityId: r.id, detail: { pledgeId: r.pledgeId, amountEur: r.amountEur, reference: r.providerReference } });
    res.json({ request: r });
  }));

  // One traveler's later deadline, with a reason; the original is kept.
  app.post("/api/admin/pay-requests/:id/extend", ...staff, writeLimiter, route(async (req, res) => {
    const r = await extendDeadline(pool, { requestId: id(req.params.id), dueAt: req.body?.dueAt, reason: req.body?.reason, by: by(req) });
    await logAudit(req, {
      action: "pay_request.extend", entity: "payment_request", entityId: r.id,
      detail: { pledgeId: r.pledgeId, originalDueAt: r.originalDueAt, dueAt: r.dueAt, reason: r.extendReason },
    });
    res.json({ request: r });
  }));

  // What a cancellation would keep and refund, before it is made.
  app.get("/api/admin/pay-at-goahead/bookings/:pledgeId/cancellation-quote", ...staff, route(async (req, res) => {
    const { departure, request, ...quote } = await cancellationQuote(pool, { pledgeId: String(req.params.pledgeId) });
    res.json({ quote: { ...quote, paymentState: request?.state || null } });
  }));

  app.post("/api/admin/pay-at-goahead/bookings/:pledgeId/cancel", ...staff, writeLimiter, route(async (req, res) => {
    const reason = req.body?.reason === "admin" ? "admin" : "traveler";
    const r = await cancelPayAtGoAheadBooking(pool, { pledgeId: String(req.params.pledgeId), reason, by: by(req), send: send() });
    await logAudit(req, {
      action: "booking.cancel_pay_at_goahead", entity: "pledge", entityId: String(req.params.pledgeId),
      detail: { reason, retainedPct: r.retainedPct, fee: r.fee, refund: r.refund, tierVersion: r.tierVersion },
    });
    res.json({ cancellation: r });
  }));

  // The admin home and Finance: unpaid seats with no link, and those needing
  // a decision (migration 052).
  app.get("/api/admin/pay-at-goahead/summary", ...staff, route(async (_req, res) => {
    res.json(await unlinkedSummary(pool));
  }));

  // An admin decision on a seat whose link was never made, or made too late:
  // send the link with a short deadline, travel unsecured, or cancel.
  app.post("/api/admin/pay-requests/:id/decision", ...staff, writeLimiter, route(async (req, res) => {
    const r = await decideUnlinkedSeat(pool, {
      requestId: id(req.params.id), decision: req.body?.decision, reason: req.body?.reason,
      linkUrl: req.body?.linkUrl || null, dueAt: req.body?.dueAt || null, by: by(req), send: send(),
    });
    await logAudit(req, {
      action: "pay_request.decision", entity: "payment_request", entityId: r.id,
      detail: { pledgeId: r.pledgeId, decision: r.decision, reason: r.decisionReason, needed: r.decisionNeeded, dueAt: r.dueAt },
    });
    res.json({ request: r });
  }));

  // ---------------------------------------------------------------- Terms versions
  app.get("/api/admin/terms-versions", ...staff, route(async (_req, res) => {
    const [versions, catalogue, legacy] = await Promise.all([listTermsVersions(pool), termsVersionInForce(pool, "catalogue"), termsVersionInForce(pool, "legacy")]);
    res.json({ versions, inForce: { catalogue: catalogue?.id ?? null, legacy: legacy?.id ?? null } });
  }));
  app.post("/api/admin/terms-versions/draft", ...staff, writeLimiter, route(async (req, res) => {
    const v = await createTermsDraft(pool, { scope: req.body?.scope, by: by(req) });
    await logAudit(req, { action: "terms.draft", entity: "terms_version", entityId: v.id, detail: { scope: v.scope, version: v.version } });
    res.status(201).json({ version: v });
  }));
  app.put("/api/admin/terms-versions/:id", ...staff, writeLimiter, route(async (req, res) => {
    const v = await saveTermsDraft(pool, { versionId: id(req.params.id), title: req.body?.title, documentUrl: req.body?.documentUrl, body: req.body?.body, note: req.body?.note });
    await logAudit(req, { action: "terms.save", entity: "terms_version", entityId: v.id, detail: { scope: v.scope, version: v.version } });
    res.json({ version: v });
  }));
  app.post("/api/admin/terms-versions/:id/publish", ...superAdmin, writeLimiter, route(async (req, res) => {
    const v = await publishTermsDraft(pool, { versionId: id(req.params.id), effectiveFrom: req.body?.effectiveFrom, by: by(req) });
    await logAudit(req, { action: "terms.publish", entity: "terms_version", entityId: v.id, detail: { scope: v.scope, version: v.version, effectiveFrom: v.effectiveFrom } });
    res.json({ version: v });
  }));
  app.delete("/api/admin/terms-versions/:id", ...staff, route(async (req, res) => {
    const r = await discardTermsDraft(pool, id(req.params.id));
    await logAudit(req, { action: "terms.discard", entity: "terms_version", entityId: r.discarded });
    res.json(r);
  }));

  // Ops confirm a refund made in the provider.
  app.post("/api/admin/refunds/:id/done", ...staff, writeLimiter, route(async (req, res) => {
    const r = await completeRefund(pool, { refundId: id(req.params.id), providerReference: req.body?.providerReference, by: by(req) });
    await logAudit(req, { action: "refund.done", entity: "payment_refund", entityId: r.id, detail: { pledgeId: r.pledgeId, amountEur: r.amountEur, reference: r.providerReference } });
    res.json({ refund: r });
  }));
}
