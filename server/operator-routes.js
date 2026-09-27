// Admin and operator-portal routes for model phase 2: operators, documents,
// roster, rate card, assignment and manifest. No money moves.
//
// Admin routes: platform staff, like every /api/admin route (creating operator
// logins: super_admin only, like agency logins). They work with the
// catalogue_v2 flag off, as the phase 1 catalog screens do.
// Operator routes: operator logins only, and only with catalogue_v2 on; with
// it off they answer 404, so nothing new is reachable. Emails go out only with
// the flag on.
import { z } from "zod";
import { pool } from "./db/index.js";
import { CatalogueError, isMissingCatalogueTables, todayIn } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import {
  listOperators, getOperator, createOperator, updateOperator, setOperatorStatus, addDocument, setApprovals,
  addStrike, voidStrike, strikesFor, currentDocuments, documentGaps, mapDocument, mapOperator,
} from "./operators.js";
import {
  rosterMonth, setPlanLine, buildMonth, overrideEntry, publishMonth, decideSwap, requestSwap, operatorRoster,
} from "./roster.js";
import { ratesFor, saveRateDraft, publishRate, importRateCard, mapRate } from "./rates.js";
import { acknowledge, assignByAdmin, manifestFor, expectedAmountFor, mapAssignment } from "./assignments.js";
import { DOCUMENT_KINDS, STRIKE_KINDS, strikesInWindow, OPERATOR_STATUSES } from "../shared/operators.js";
import { parseReceiptDataUrl } from "./receipts.js";

export const DOCUMENT_BUCKET = "operator-documents";
const SIGNED_SECONDS = 120;

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13.");
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11.");
const text = (max) => z.string().trim().max(max).nullable().optional();
const operatorFields = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  tradingName: text(200), tourismLicenseNo: text(80), etaaNo: text(80),
  commercialRegistrationNo: text(80), taxRegistrationNo: text(80),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("")),
  whatsapp: text(40), phone: text(40), notes: text(2000), agencyId: text(80),
  contacts: z.array(z.object({ name: z.string().trim().max(120), role: text(80), phone: text(40), email: text(200) })).max(10).optional(),
}).strict();

export function registerOperatorRoutes(app, { requireAuth, requireRole, h, logAudit, provisionUser, supabaseAdmin, sendEmail }) {
  const staff = [requireAuth, requireRole("super_admin", "ops_staff")];
  const superAdmin = [requireAuth, requireRole("super_admin")];
  const operatorOnly = [requireAuth, requireRole("operator_owner", "operator_staff")];
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
        throw Object.assign(new CatalogueError(503, "Operators aren't switched on yet: migration 049 has not been applied to this database."), { expose: true });
      }
      throw e;
    }
  });
  // Operator routes exist only with the flag on.
  const portal = (fn) => route(async (req, res) => {
    if (!catalogueV2Enabled()) throw new CatalogueError(404, "Not found.");
    if (!req.user?.operatorId) throw new CatalogueError(403, "This login isn't linked to an operator.");
    await fn(req, res);
  });

  let bucketReady = null;
  const ensureBucket = () => {
    bucketReady ??= (async () => {
      const { data } = await supabaseAdmin.storage.getBucket(DOCUMENT_BUCKET);
      if (data) return;
      const { error } = await supabaseAdmin.storage.createBucket(DOCUMENT_BUCKET, { public: false });
      if (error && !/already exists/i.test(error.message || "")) throw new Error(error.message);
    })().catch((e) => { bucketReady = null; throw e; });
    return bucketReady;
  };

  // ============================================================== operators
  app.get("/api/admin/operators", ...staff, route(async (_req, res) => {
    const [operators, agencies, products] = await Promise.all([
      listOperators(pool),
      pool.query("SELECT id, name FROM agencies ORDER BY name"),
      pool.query("SELECT id, catalogue_no, code, title, status FROM catalogue_products ORDER BY catalogue_no"),
    ]);
    res.json({ operators, agencies: agencies.rows, products: products.rows.map((p) => ({ ...p, id: Number(p.id) })) });
  }));

  app.post("/api/admin/operators", ...staff, route(async (req, res) => {
    const fields = operatorFields.parse(req.body || {});
    const op = await createOperator(pool, fields, by(req));
    await logAudit(req, { action: "operator.create", entity: "operator", entityId: op.id, detail: { legalName: op.legalName, agencyId: op.agencyId } });
    res.status(201).json({ operator: op });
  }));

  app.get("/api/admin/operators/:id", ...staff, route(async (req, res) => {
    const oid = id(req.params.id);
    const [operator, docs, strikes, approvals, users] = await Promise.all([
      getOperator(pool, oid),
      pool.query("SELECT * FROM operator_documents WHERE operator_id = $1 ORDER BY kind, uploaded_at DESC", [oid]),
      strikesFor(pool, oid),
      pool.query("SELECT product_id FROM operator_product_approvals WHERE operator_id = $1", [oid]),
      pool.query("SELECT id, email, full_name, role, status FROM app_users WHERE operator_id = $1 ORDER BY email", [oid]),
    ]);
    const current = docs.rows.map(mapDocument).filter((d) => !d.supersededAt);
    res.json({
      operator, documents: docs.rows.map(mapDocument), documentGaps: documentGaps(current, todayIn()),
      strikes, strikes90: strikesInWindow(strikes).length,
      approvedProductIds: approvals.rows.map((r) => Number(r.product_id)), users: users.rows,
    });
  }));

  app.patch("/api/admin/operators/:id", ...staff, route(async (req, res) => {
    const fields = operatorFields.parse(req.body || {});
    const op = await updateOperator(pool, id(req.params.id), fields);
    await logAudit(req, { action: "operator.update", entity: "operator", entityId: op.id, detail: Object.keys(fields) });
    res.json({ operator: op });
  }));

  app.post("/api/admin/operators/:id/status", ...staff, route(async (req, res) => {
    const input = z.object({ status: z.enum(OPERATOR_STATUSES), reason: text(300) }).parse(req.body || {});
    const op = await setOperatorStatus(pool, id(req.params.id), input.status, { by: by(req), reason: input.reason || null });
    await logAudit(req, { action: "operator.status", entity: "operator", entityId: op.id, detail: input });
    res.json({ operator: op });
  }));

  // A document: its number and expiry, and (optionally) the file itself, as a
  // data URL, into a private bucket.
  app.post("/api/admin/operators/:id/documents", ...staff, route(async (req, res) => {
    const oid = id(req.params.id);
    const input = z.object({
      kind: z.enum(DOCUMENT_KINDS), number: text(120), expiresOn: ymdSchema,
      filename: text(200), dataUrl: z.string().max(12_000_000).optional(),
    }).parse(req.body || {});
    let fileRef = null;
    if (input.dataUrl) {
      if (!supabaseAdmin) throw new CatalogueError(500, "Storage is not configured.");
      const file = parseReceiptDataUrl(input.dataUrl);
      if (file.error) throw new CatalogueError(422, file.error);
      await ensureBucket();
      fileRef = `operator/${oid}/${input.kind}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${file.ext}`;
      const { error } = await supabaseAdmin.storage.from(DOCUMENT_BUCKET).upload(fileRef, file.buffer, { contentType: file.contentType, upsert: false });
      if (error) throw new CatalogueError(502, "Upload failed: " + error.message);
    }
    const result = await addDocument(pool, oid, { kind: input.kind, number: input.number, expiresOn: input.expiresOn, fileRef }, { by: by(req) });
    await logAudit(req, {
      action: "operator.document", entity: "operator", entityId: oid,
      detail: { kind: input.kind, expiresOn: input.expiresOn, hasFile: !!fileRef, reactivated: result.reactivated },
    });
    res.status(201).json(result);
  }));

  app.get("/api/admin/operators/:id/documents/:docId/file", ...staff, route(async (req, res) => {
    const row = (await pool.query("SELECT file_ref FROM operator_documents WHERE id = $1 AND operator_id = $2", [id(req.params.docId), id(req.params.id)])).rows[0];
    if (!row?.file_ref) throw new CatalogueError(404, "No file on this document.");
    if (!supabaseAdmin) throw new CatalogueError(500, "Storage is not configured.");
    const { data, error } = await supabaseAdmin.storage.from(DOCUMENT_BUCKET).createSignedUrl(row.file_ref, SIGNED_SECONDS);
    if (error || !data?.signedUrl) throw new CatalogueError(502, "Couldn't open the file. Please try again.");
    res.json({ url: data.signedUrl, expiresInSeconds: SIGNED_SECONDS });
  }));

  app.put("/api/admin/operators/:id/approvals", ...staff, route(async (req, res) => {
    const input = z.object({ productIds: z.array(z.number().int().positive()).max(100) }).parse(req.body || {});
    const ids = await setApprovals(pool, id(req.params.id), input.productIds, by(req));
    await logAudit(req, { action: "operator.approvals", entity: "operator", entityId: req.params.id, detail: { productIds: ids } });
    res.json({ approvedProductIds: ids });
  }));

  app.post("/api/admin/operators/:id/strikes", ...staff, route(async (req, res) => {
    const input = z.object({
      kind: z.enum(STRIKE_KINDS.filter((k) => k !== "missed_acknowledgement")),
      note: z.string().trim().min(3).max(2000), departureId: z.number().int().positive().nullable().optional(),
    }).parse(req.body || {});
    const strike = await addStrike(pool, { operatorId: id(req.params.id), kind: input.kind, note: input.note, departureId: input.departureId || null, by: by(req) });
    await logAudit(req, { action: "operator.strike", entity: "operator", entityId: req.params.id, detail: input });
    res.status(201).json({ strike });
  }));

  app.post("/api/admin/operator-strikes/:id/void", ...staff, route(async (req, res) => {
    const strike = await voidStrike(pool, id(req.params.id), { by: by(req), reason: req.body?.reason });
    await logAudit(req, { action: "operator.strike.void", entity: "operator_strike", entityId: strike.id, detail: { reason: strike.voidReason } });
    res.json({ strike });
  }));

  // An operator login (owner or staff). Super admin only, like agency logins.
  app.post("/api/admin/operators/:id/users", ...superAdmin, route(async (req, res) => {
    const oid = id(req.params.id);
    await getOperator(pool, oid);
    const input = z.object({
      email: z.string().trim().email(), fullName: text(120), role: z.enum(["operator_owner", "operator_staff"]),
    }).parse(req.body || {});
    const user = await provisionUser({ email: input.email, fullName: input.fullName, role: input.role, operatorId: oid });
    await logAudit(req, { action: "operator.user.create", entity: "operator", entityId: oid, detail: { email: input.email, role: input.role } });
    res.status(201).json({ userId: user.id, tempPassword: user.tempPassword });
  }));

  // ============================================================== roster
  app.get("/api/admin/roster", ...staff, route(async (req, res) => {
    const month = monthSchema.parse(String(req.query.month || todayIn().slice(0, 7)));
    const [roster, operators, products] = await Promise.all([
      rosterMonth(pool, month),
      listOperators(pool),
      pool.query(`SELECT id, catalogue_no, code, title, type, status FROM catalogue_products WHERE status = 'active' ORDER BY catalogue_no`),
    ]);
    res.json({
      ...roster,
      operators: operators.map((o) => ({
        id: o.id, legalName: o.legalName, status: o.status, strikes90: o.strikes90, flagged: o.strikes90 >= 3,
        approvedProductIds: o.approvedProductIds,
      })),
      products: products.rows.map((p) => ({ ...p, id: Number(p.id) })),
    });
  }));

  app.put("/api/admin/roster/:month/plan", ...staff, route(async (req, res) => {
    const month = monthSchema.parse(req.params.month);
    const input = z.object({ productId: z.number().int().positive(), weekday: z.number().int().min(0).max(6), operatorId: z.number().int().positive().nullable() }).parse(req.body || {});
    const line = await setPlanLine(pool, { month, ...input });
    await logAudit(req, { action: "roster.plan", entity: "roster_month", entityId: month, detail: input });
    res.json({ line });
  }));

  app.post("/api/admin/roster/:month/build", ...staff, route(async (req, res) => {
    const month = monthSchema.parse(req.params.month);
    const result = await buildMonth(pool, month, by(req));
    await logAudit(req, { action: "roster.build", entity: "roster_month", entityId: month, detail: { written: result.written, skipped: result.skipped.length } });
    res.json(result);
  }));

  app.put("/api/admin/roster/entries", ...staff, route(async (req, res) => {
    const input = z.object({ productId: z.number().int().positive(), date: ymdSchema, operatorId: z.number().int().positive().nullable() }).parse(req.body || {});
    const entry = await overrideEntry(pool, { ...input, by: by(req) });
    await logAudit(req, { action: "roster.override", entity: "roster_entry", entityId: `${input.productId}:${input.date}`, detail: input });
    res.json({ entry });
  }));

  app.post("/api/admin/roster/:month/publish", ...staff, route(async (req, res) => {
    const month = monthSchema.parse(req.params.month);
    try {
      const result = await publishMonth(pool, month, { by: by(req) });
      await logAudit(req, { action: "roster.publish", entity: "roster_month", entityId: month, detail: result });
      res.json(result);
    } catch (e) {
      if (e.problems) return res.status(e.status || 422).json({ error: e.message, problems: e.problems });
      throw e;
    }
  }));

  app.post("/api/admin/roster/swaps/:id/decide", ...staff, route(async (req, res) => {
    const input = z.object({ approve: z.boolean() }).parse(req.body || {});
    const swap = await decideSwap(pool, { swapId: id(req.params.id), approve: input.approve, by: by(req) });
    await logAudit(req, { action: input.approve ? "roster.swap.approve" : "roster.swap.reject", entity: "roster_swap", entityId: swap.id, detail: swap });
    res.json({ swap });
  }));

  // ============================================================== rate card
  app.get("/api/admin/rates", ...staff, route(async (_req, res) => {
    const [products, versions] = await Promise.all([
      pool.query("SELECT id, catalogue_no, code, title, type, status FROM catalogue_products ORDER BY catalogue_no"),
      pool.query("SELECT * FROM catalogue_rate_versions ORDER BY product_id, version"),
    ]);
    const by = new Map();
    for (const v of versions.rows.map(mapRate)) (by.get(v.productId) || by.set(v.productId, []).get(v.productId)).push(v);
    res.json({ products: products.rows.map((p) => ({ ...p, id: Number(p.id), versions: by.get(Number(p.id)) || [] })) });
  }));

  app.put("/api/admin/rates/:productId/draft", ...staff, route(async (req, res) => {
    const version = await saveRateDraft(pool, id(req.params.productId), req.body?.values || {}, { by: by(req) });
    await logAudit(req, { action: "rates.draft", entity: "catalogue_product", entityId: version.productId, detail: { version: version.version } });
    res.json({ version });
  }));

  app.post("/api/admin/rates/:productId/versions/:versionId/publish", ...staff, route(async (req, res) => {
    const effectiveFrom = req.body?.effectiveFrom ? ymdSchema.parse(req.body.effectiveFrom) : null;
    const version = await publishRate({ productId: id(req.params.productId), versionId: id(req.params.versionId), effectiveFrom, by: by(req) });
    await logAudit(req, { action: "rates.publish", entity: "catalogue_product", entityId: version.productId, detail: { version: version.version, effectiveFrom: version.effectiveFrom } });
    res.json({ version });
  }));

  app.post("/api/admin/rates/import", ...staff, route(async (req, res) => {
    const m = /^data:[^;]+;base64,(.+)$/.exec(String(req.body?.dataUrl || ""));
    if (!m) throw new CatalogueError(422, "Choose the rate card spreadsheet (.xlsx).");
    const buffer = Buffer.from(m[1], "base64");
    if (buffer.length > 5_000_000) throw new CatalogueError(413, "That file is too large for a rate card.");
    let result;
    try {
      result = await importRateCard({ buffer, filename: String(req.body?.filename || "rate-card.xlsx").slice(0, 200), by: by(req) });
    } catch (e) {
      if (/xlsx|zip/i.test(e.message)) throw new CatalogueError(422, `That file couldn't be read as a spreadsheet: ${e.message}`);
      throw e;
    }
    await logAudit(req, { action: "rates.import", entity: "catalogue", entityId: null, detail: { imported: result.imported.length, skipped: result.skipped.length, problems: result.problems.length } });
    res.json(result);
  }));

  // ============================================================== assignment
  app.post("/api/admin/catalogue/departures/:id/assign", ...staff, route(async (req, res) => {
    const input = z.object({
      operatorId: z.number().int().positive(),
      // Phase 3: why, when the current operator's advance has been paid.
      reason: z.enum(["operator_fault", "not_operator_fault"]).optional(),
      penaltyCode: z.string().max(60).nullable().optional(), travelers: z.number().int().min(1).max(12).nullable().optional(),
      keptEgp: z.coerce.number().min(0).nullable().optional(), costLineIds: z.array(z.number().int().positive()).max(50).optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body || {});
    const { operatorId, ...reassign } = input;
    let assignment;
    try {
      assignment = await assignByAdmin(pool, { departureId: id(req.params.id), operatorId, by: by(req), send: send(), reassign });
    } catch (e) {
      if (e.code === "reason_required") return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
    await logAudit(req, { action: "catalogue.departure.assign", entity: "catalogue_departure", entityId: req.params.id, detail: input });
    res.json({ assignment });
  }));

  app.get("/api/admin/catalogue/departures/:id/manifest", ...staff, route(async (req, res) => {
    res.json(await manifestFor(pool, { departureId: id(req.params.id) }));
  }));

  app.get("/api/admin/catalogue/departures/:id/expected", ...staff, route(async (req, res) => {
    res.json(await expectedAmountFor(pool, id(req.params.id)));
  }));

  app.get("/api/admin/catalogue/alerts", ...staff, route(async (_req, res) => {
    const r = await pool.query(
      `SELECT a.*, cd.date, c.title, c.code FROM catalogue_admin_alerts a
         JOIN catalogue_departures cd ON cd.id = a.departure_id JOIN catalogue_products c ON c.id = cd.product_id
        WHERE a.resolved_at IS NULL ORDER BY cd.date`);
    res.json({ alerts: r.rows.map((a) => ({ id: Number(a.id), departureId: Number(a.departure_id), kind: a.kind, detail: a.detail, createdAt: a.created_at, date: a.date instanceof Date ? a.date.toISOString().slice(0, 10) : a.date, title: a.title, code: a.code })) });
  }));

  // ============================================================== operator portal
  app.get("/api/operator/me", ...operatorOnly, portal(async (req, res) => {
    const oid = req.user.operatorId;
    const [operator, docs, strikes] = await Promise.all([getOperator(pool, oid), currentDocuments(pool, oid), strikesFor(pool, oid)]);
    res.json({
      operator: { id: operator.id, legalName: operator.legalName, status: operator.status },
      documents: docs, documentGaps: documentGaps(docs, todayIn()),
      strikes: strikes.filter((s) => !s.voidedAt).map((s) => ({ kind: s.kind, note: s.note, createdAt: s.createdAt })),
      strikes90: strikesInWindow(strikes).length,
    });
  }));

  app.get("/api/operator/assignments", ...operatorOnly, portal(async (req, res) => {
    const r = await pool.query(
      `SELECT a.*, cd.date, cd.status AS departure_status, c.title, c.code, sv.version AS spec_version, s.seats_sold,
              (SELECT frozen_at FROM catalogue_manifests m WHERE m.departure_id = cd.id) AS frozen_at
         FROM catalogue_assignments a
         JOIN catalogue_departures cd ON cd.id = a.departure_id
         JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
         JOIN catalogue_products c ON c.id = cd.product_id
         LEFT JOIN catalogue_spec_versions sv ON sv.id = cd.spec_version_id
        WHERE a.operator_id = $1 AND a.state IN ('offered', 'acknowledged', 'expired')
        ORDER BY cd.date DESC LIMIT 200`, [req.user.operatorId]);
    const out = [];
    for (const a of r.rows) {
      const live = a.state === "offered" || a.state === "acknowledged";
      out.push({
        ...mapAssignment(a), date: a.date instanceof Date ? a.date.toISOString().slice(0, 10) : a.date,
        title: a.title, code: a.code, specVersion: a.spec_version, seatsSold: Number(a.seats_sold) || 0,
        manifestFrozenAt: a.frozen_at, manifestAvailable: live && !a.manifest_access_revoked_at,
        expected: live ? await expectedAmountFor(pool, Number(a.departure_id)) : null,
      });
    }
    res.json({ assignments: out });
  }));

  app.post("/api/operator/assignments/:id/acknowledge", ...operatorOnly, portal(async (req, res) => {
    const a = await acknowledge(pool, { assignmentId: id(req.params.id), operatorId: req.user.operatorId, by: req.user.email });
    await logAudit(req, { action: "operator.assignment.acknowledge", entity: "catalogue_assignment", entityId: a.id, detail: { departureId: a.departureId } });
    res.json({ assignment: a });
  }));

  app.get("/api/operator/departures/:id/manifest", ...operatorOnly, portal(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await manifestFor(pool, { departureId: id(req.params.id), operatorId: req.user.operatorId, user: req.user }));
  }));

  app.get("/api/operator/roster", ...operatorOnly, portal(async (req, res) => {
    const from = req.query.from ? ymdSchema.parse(String(req.query.from)) : todayIn();
    res.json({ entries: await operatorRoster(pool, req.user.operatorId, { from }) });
  }));

  // Who a date can be swapped to: other active operators approved for the
  // product (every operator can see the whole roster, OSA 4.4).
  app.get("/api/operator/swap-targets", ...operatorOnly, portal(async (req, res) => {
    const entryId = id(req.query.entryId);
    const r = await pool.query(
      `SELECT o.id, o.legal_name FROM roster_entries e
         JOIN operator_product_approvals ap ON ap.product_id = e.product_id
         JOIN operators o ON o.id = ap.operator_id AND o.status = 'active'
        WHERE e.id = $1 AND e.operator_id = $2 AND o.id <> $2 ORDER BY o.legal_name`, [entryId, req.user.operatorId]);
    res.json({ operators: r.rows.map((o) => ({ id: Number(o.id), legalName: o.legal_name })) });
  }));

  app.post("/api/operator/swaps", ...operatorOnly, portal(async (req, res) => {
    const input = z.object({ entryId: z.number().int().positive(), toOperatorId: z.number().int().positive(), note: text(500) }).parse(req.body || {});
    const swap = await requestSwap(pool, { ...input, fromOperatorId: req.user.operatorId, by: req.user.email });
    await logAudit(req, { action: "roster.swap.request", entity: "roster_swap", entityId: swap.id, detail: input });
    res.status(201).json({ swap });
  }));

  app.get("/api/operator/swaps", ...operatorOnly, portal(async (req, res) => {
    const r = await pool.query(
      `SELECT s.*, e.date, c.title, t.legal_name AS to_name FROM roster_swaps s
         JOIN roster_entries e ON e.id = s.entry_id JOIN catalogue_products c ON c.id = e.product_id
         JOIN operators t ON t.id = s.to_operator_id
        WHERE s.from_operator_id = $1 ORDER BY s.requested_at DESC LIMIT 100`, [req.user.operatorId]);
    res.json({ swaps: r.rows.map((s) => ({ id: Number(s.id), date: s.date instanceof Date ? s.date.toISOString().slice(0, 10) : s.date, title: s.title, toName: s.to_name, state: s.state, requestedAt: s.requested_at, decidedAt: s.decided_at })) });
  }));

  app.get("/api/operator/notifications", ...operatorOnly, portal(async (req, res) => {
    const r = await pool.query(
      "SELECT id, kind, title, body, departure_id, created_at, read_at FROM operator_notifications WHERE operator_id = $1 ORDER BY created_at DESC LIMIT 100",
      [req.user.operatorId]);
    res.json({ notifications: r.rows.map((n) => ({ id: Number(n.id), kind: n.kind, title: n.title, body: n.body, departureId: n.departure_id == null ? null : Number(n.departure_id), createdAt: n.created_at, readAt: n.read_at })) });
  }));

  app.post("/api/operator/notifications/:id/read", ...operatorOnly, portal(async (req, res) => {
    await pool.query("UPDATE operator_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND operator_id = $2", [id(req.params.id), req.user.operatorId]);
    res.json({ ok: true });
  }));
}

export { mapOperator };
