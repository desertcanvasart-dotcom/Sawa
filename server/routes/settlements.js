// Settlements and the Wednesday payouts (044): the finance desk's runs, costs, adjustments, receipts and payouts
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { CURRENCY_SYMBOL } from "../../shared/currency.js";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole, isPlatform } from "../auth.js";
import { DIRECT_BOOKINGS_OPERATOR } from "../brand.js";
import { pool, withTransaction } from "../db/index.js";
import { mapPledge, mapProduct, mapDeparture, isoDate } from "../db/mappers.js";
import { directOperatorId, operatorForDeparture, bookingClosesAtMs } from "../domain.js";
import { loadOperatorInputs, withDepositTimes } from "../operator-lookup.js";
import { isMissingPaymentsTable, paymentsByPledge, cleanLinkUrl } from "../payments.js";
import { isReceiptRef, receiptDisplayName, receiptKind, mayAttachReceipt, RECEIPT_BUCKET, RECEIPT_MAX_BYTES, RECEIPT_MIME_TYPES, parseReceiptDataUrl, receiptKey, RECEIPT_PREFIX, receiptRefKey, SIGNED_LINK_SECONDS } from "../receipts.js";
import { isMissingSettlementTables, cairoDay, settleDeparture, payoutBlocker, endedBy, BLOCKER_LABEL, LINE_CATEGORIES, payDateOnOrAfter, COST_CATEGORIES, INCOME_CATEGORIES, lineKind, runWindow, payoutLines } from "../settlement.js";
import { supabaseAdmin } from "../supabase.js";
import { routeContext } from "../route-context.js";

const {
  AppError, depDateLabel, app, h, uploadLimiter, parse, writeLimiter,
} = routeContext();

// ---- Settlements and the Wednesday payouts (044) ---------------------------
//
// The arithmetic is in settlement.js; these routes load what it needs, record
// Sawa's decisions and the runs, and show each agency its own figures. Every
// write is Sawa's except an operator submitting its cost lines.
//
// Until migration 044 is applied the reads answer { available: false } and
// the writes say settlements aren't switched on.
const settlementsNotOn = () => Object.assign(
  new AppError(503, "Settlements aren't switched on yet — migration 044 has not been applied to this database."), { expose: true });

async function withSettlements(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSettlementTables(e) || isMissingPaymentsTable(e)) throw settlementsNotOn();
    throw e;
  }
}

const mapCost = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), category: r.category, description: r.description,
  amount: Number(r.amount),
  // A pasted link is shown as a link; an uploaded file only by name — it is
  // opened through GET /api/cost-receipts/:id, which issues a signed link.
  receiptUrl: isReceiptRef(r.receipt_url) ? null : r.receipt_url || null,
  receiptFile: isReceiptRef(r.receipt_url) ? receiptDisplayName(r.receipt_url) : null,
  receiptKind: receiptKind(r.receipt_url),
  kind: r.kind === "income" ? "income" : "cost",
  basis: r.basis === "person" ? "person" : "group",
  unitAmount: r.unit_amount != null ? Number(r.unit_amount) : null,
  quantity: r.quantity != null ? Number(r.quantity) : null,
  submittedByAgencyId: r.submitted_by_agency_id || null,
  submittedBy: r.submitted_by || null, state: r.state, approvedAmount: r.approved_amount != null ? Number(r.approved_amount) : null,
  reviewNote: r.review_note || null, reviewedBy: r.reviewed_by || null,
  reviewedAt: r.reviewed_at instanceof Date ? r.reviewed_at.toISOString() : r.reviewed_at || null,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
});
const mapAdjustment = (r) => ({
  id: Number(r.id), departureId: Number(r.departure_id), agencyId: r.agency_id || null, amount: Number(r.amount),
  reason: r.reason, createdBy: r.created_by || null, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
});
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};

// Catalog departures (catalogue_v2) are settled by the rate card, under
// Operators and Finance, and never by this module: the old profit share would
// pay the same date twice. A departure is a catalog one by TYPE (it backs a
// catalogue_departures row), whatever its payments or cost sheet say. Its cost
// sheet and receipts still work: force-majeure reimbursements point at them,
// and they feed the new settlement only.
const CATALOGUE_REFUSAL = "This is a catalog departure. It is settled under Operators and Finance (the rate card), not in Settlements.";
async function hasCatalogueTable(db) {
  return (await db.query("SELECT to_regclass('public.catalogue_departures') AS t")).rows[0].t != null;
}
async function catalogueDepartureIds(db, ids) {
  if (!ids.length || !(await hasCatalogueTable(db))) return new Set();
  return new Set((await db.query(
    "SELECT legacy_departure_id AS id FROM catalogue_departures WHERE legacy_departure_id = ANY($1::int[])", [ids])).rows.map((r) => Number(r.id)));
}
async function refuseCatalogueDeparture(db, depId) {
  if ((await catalogueDepartureIds(db, [depId])).size) throw new AppError(409, CATALOGUE_REFUSAL);
}

// Everything the settlement of these departures needs, in one read. Without
// `ids`: every departure confirmed to run (GoAhead), and any other with money
// collected, a cost line or a sign-off. Catalog departures are left out either
// way, and listed in `excludedCatalogue` (the payout run logs them).
//
// GoAhead is what puts a date on the list. It used to take money collected or
// a cost line — but cost lines (and their receipts) are only added from this
// list, so a new tour never appeared and there was nowhere to enter its costs.
async function loadSettlements(db, ids = null) {
  let depRows = (await db.query(
    ids
      ? `SELECT * FROM departures WHERE id = ANY($1::int[]) ORDER BY COALESCE(end_date, start_date, date) DESC, id DESC`
      : `SELECT * FROM departures d WHERE
           d.status IN ('minimum_reached', 'supplier_confirmed')
           OR EXISTS (SELECT 1 FROM pledges p JOIN booking_payments b ON b.pledge_id = p.id
                    WHERE p.departure_id = d.id AND b.state IN ('paid', 'refunded'))
           OR EXISTS (SELECT 1 FROM departure_costs c WHERE c.departure_id = d.id)
           OR EXISTS (SELECT 1 FROM departure_settlements s WHERE s.departure_id = d.id)
         ORDER BY COALESCE(d.end_date, d.start_date, d.date) DESC, d.id DESC`,
    ids ? [ids] : [])).rows;
  const catalogue = await catalogueDepartureIds(db, depRows.map((d) => d.id));
  const excludedCatalogue = depRows.filter((d) => catalogue.has(Number(d.id))).map((d) => Number(d.id));
  depRows = depRows.filter((d) => !catalogue.has(Number(d.id)));
  const depIds = depRows.map((d) => d.id);
  const [pledgeRows, costRows, adjRows, signRows, paidRows, agencies, inputs] = await Promise.all([
    db.query(`SELECT * FROM pledges WHERE departure_id = ANY($1::int[]) ORDER BY created_at ASC, id ASC`, [depIds]),
    db.query(`SELECT * FROM departure_costs WHERE departure_id = ANY($1::int[]) ORDER BY id`, [depIds]),
    db.query(`SELECT * FROM settlement_adjustments WHERE departure_id = ANY($1::int[]) ORDER BY id`, [depIds]),
    db.query(`SELECT * FROM departure_settlements WHERE departure_id = ANY($1::int[])`, [depIds]),
    db.query(`SELECT l.departure_id, l.agency_id, r.pay_date, SUM(l.amount) AS amount
                FROM payout_lines l JOIN payout_runs r ON r.id = l.run_id
               WHERE r.state = 'approved' AND l.departure_id = ANY($1::int[])
               GROUP BY l.departure_id, l.agency_id, r.pay_date`, [depIds]),
    db.query(`SELECT * FROM agencies`),
    loadOperatorInputs(db),
  ]);
  const pledgesByDep = groupBy(pledgeRows.rows.map(mapPledge).map((p, i) => ({ ...p, departureId: pledgeRows.rows[i].departure_id })), "departureId");
  const payments = await paymentsByPledge(db, pledgeRows.rows.map((r) => r.id));
  const products = new Map((await db.query(`SELECT * FROM tour_products WHERE id = ANY($1::text[])`,
    [[...new Set(depRows.map((d) => d.tour_product_id).filter(Boolean))]])).rows.map((r) => [r.id, mapProduct(r)]));
  return {
    departures: depRows.map((r) => mapDeparture(r, [])),
    excludedCatalogue,
    productOf: (d) => products.get(d.tourProductId) || null,
    pledgesByDep,
    payments,
    costsByDep: groupBy(costRows.rows.map(mapCost), "departureId"),
    adjByDep: groupBy(adjRows.rows.map(mapAdjustment), "departureId"),
    signoff: new Map(signRows.rows.map((r) => [Number(r.departure_id), r])),
    paidRows: paidRows.rows.map((r) => ({ departureId: Number(r.departure_id), agencyId: r.agency_id, payDate: isoDate(r.pay_date), amount: Number(r.amount) })),
    agencyName: new Map(agencies.rows.map((a) => [a.id, a.name])),
    directAgencyId: directOperatorId(agencies.rows, DIRECT_BOOKINGS_OPERATOR),
    referralAgencies: inputs.referralAgencies,
    depositPaidAt: inputs.depositPaidAt,
  };
}

// One departure's settlement, sign-offs and payouts so far, as of an instant.
function settlementView(d, L, { asOfMs = Infinity, endedByDay = cairoDay(Date.now()) } = {}) {
  const pledges = L.pledgesByDep.get(d.id) || [];
  const costs = L.costsByDep.get(d.id) || [];
  const adjustments = L.adjByDep.get(d.id) || [];
  const sign = L.signoff.get(d.id) || null;
  const s = settleDeparture({
    pledges, paymentsByPledge: L.payments, costs, adjustments,
    directAgencyId: L.directAgencyId, referralAgencies: L.referralAgencies, asOfMs,
  });
  const operatorAgencyId = operatorForDeparture({ ...d, pledges: withDepositTimes(pledges, L.depositPaidAt) }, {
    listingAgencyId: L.productOf(d)?.agencyId || null, directAgencyId: L.directAgencyId,
    referralAgencies: L.referralAgencies, lockAtMs: bookingClosesAtMs(d, L.productOf(d)),
  });
  const paidOut = L.paidRows.filter((r) => r.departureId === d.id);
  const blocker = payoutBlocker({
    ended: endedBy(d, endedByDay), costsFinal: !!sign?.costs_final_at, loss: s.loss,
    lossDecided: !!sign?.loss_decided_at, pendingCosts: costs.filter((c) => c.state === "submitted").length,
  });
  const name = (id) => (id ? L.agencyName.get(id) || id : "Sawa");
  return {
    departure: { id: d.id, route: d.route, status: d.status, date: d.date, startDate: d.startDate, endDate: d.endDate },
    dateLabel: depDateLabel(d),
    operatorAgencyId, operatorName: operatorAgencyId ? name(operatorAgencyId) : null,
    settlement: { ...s, shares: s.shares.map((x) => ({ ...x, name: name(x.agencyId), paidOut: Math.round(paidOut.filter((p) => p.agencyId === x.agencyId).reduce((n, p) => n + p.amount, 0) * 100) / 100 })) },
    costs, adjustments: adjustments.map((a) => ({ ...a, name: name(a.agencyId) })),
    // Travellers booked on the date (paid or not) — the default head count
    // for a per-person cost line.
    travellers: pledges.filter((p) => p.status !== "cancelled").reduce((n, p) => n + (Number(p.seats) || 0), 0),
    costsFinalAt: sign?.costs_final_at || null, lossDecidedAt: sign?.loss_decided_at || null, lossNote: sign?.loss_note || null,
    blocker, blockerLabel: blocker ? BLOCKER_LABEL[blocker] : null,
    paidOut,
  };
}

app.get("/api/admin/settlements", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  let L;
  try { L = await loadSettlements(pool); } catch (e) {
    if (isMissingSettlementTables(e) || isMissingPaymentsTable(e)) return res.json({ available: false, items: [] });
    throw e;
  }
  res.json({
    available: true,
    items: L.departures.map((d) => settlementView(d, L)),
    agencies: Object.fromEntries(L.agencyName),
    categories: LINE_CATEGORIES,
    nextPayDate: payDateOnOrAfter(cairoDay(Date.now())),
  });
}));

// A line on the cost sheet is money out (a cost, or a commission we pay) or
// money in (a shop commission, optional tours sold) — its category says which.
// It is priced per group (transport, a guide: `amount` is the total) or per
// person (meals, entrance fees: `unitAmount` × `quantity` people). The line's
// total is what the settlement reads either way.
const costSchema = z.object({
  category: z.enum([...COST_CATEGORIES, ...INCOME_CATEGORIES]),
  description: z.string().trim().min(1, "Describe the line.").max(300),
  basis: z.enum(["group", "person"]).default("group"),
  amount: z.coerce.number().positive("Enter the amount.").optional(),
  unitAmount: z.coerce.number().positive("Enter the price per person.").optional(),
  quantity: z.coerce.number().int().min(1, "Enter how many people.").max(500).optional(),
  receiptUrl: z.string().trim().max(1000).optional(),
}).superRefine((c, ctx) => {
  if (c.basis === "person" && (c.unitAmount == null || c.quantity == null)) {
    ctx.addIssue({ code: "custom", message: "A per-person cost needs the price per person and the number of people." });
  }
  if (c.basis === "group" && c.amount == null) ctx.addIssue({ code: "custom", message: "Enter the amount." });
});
const cents = (n) => Math.round(Number(n) * 100) / 100;

// Write one line. Migrations 045 (per-person pricing) and 046 (kind) may not
// have run yet: before 045 a per-person line keeps its breakdown in the
// description; before 046 a commission we pay is saved as "Other", and income
// is refused — stored as a cost it would be taken off the profit instead.
async function costColumns(db) {
  const r = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'departure_costs' AND table_schema = current_schema()`);
  return new Set(r.rows.map((x) => x.column_name));
}
async function insertCost(db, depId, input, { receipt, agencyId = null, email = null, approved = false }) {
  const person = input.basis === "person";
  const kind = lineKind(input.category);
  const total = person ? cents(input.unitAmount * input.quantity) : cents(input.amount);
  const has = await costColumns(db);
  let category = input.category;
  let description = input.description;
  if (!has.has("kind")) {
    if (kind === "income") throw Object.assign(new AppError(503, "Extra income can't be recorded yet — migration 046 has not been applied to this database."), { expose: true });
    if (category === "commission_paid") { category = "other"; description = `Commission we pay: ${description}`; }
  }
  const cols = ["departure_id", "category", "description", "amount", "receipt_url", "submitted_by_agency_id", "submitted_by"];
  const vals = [depId, category, description, total, receipt, agencyId, email];
  if (has.has("basis")) {
    cols.push("basis", "unit_amount", "quantity");
    vals.push(input.basis, person ? cents(input.unitAmount) : null, person ? input.quantity : null);
  } else if (person) {
    vals[2] = `${description} — ${CURRENCY_SYMBOL}${cents(input.unitAmount)} × ${input.quantity} people`;
  }
  vals[2] = String(vals[2]).slice(0, 300);
  if (has.has("kind")) { cols.push("kind"); vals.push(kind); }
  if (approved) { cols.push("state", "approved_amount", "reviewed_by", "reviewed_at"); vals.push("approved", total, email, new Date()); }
  return (await db.query(
    `INSERT INTO departure_costs (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, vals)).rows[0];
}
// A cost line's receipt: a pasted https link, or a file uploaded through
// POST /api/cost-receipts — which an agency may attach only if it uploaded it.
const receiptUrlOf = (raw, user) => {
  if (!raw) return null;
  if (isReceiptRef(raw)) {
    if (!mayAttachReceipt(raw, { agencyId: user?.agencyId || null, staff: isPlatform(user) })) {
      throw new AppError(422, "That receipt file can't be attached — upload it again.");
    }
    return raw;
  }
  const u = cleanLinkUrl(raw);
  if (!u) throw new AppError(422, "The receipt link must be an https link.");
  return u;
};

// The private bucket receipts go in, created the first time it is needed.
let receiptBucketReady = null;
function ensureReceiptBucket() {
  receiptBucketReady ??= (async () => {
    const { data } = await supabaseAdmin.storage.getBucket(RECEIPT_BUCKET);
    if (data) return;
    const { error } = await supabaseAdmin.storage.createBucket(RECEIPT_BUCKET, {
      public: false, fileSizeLimit: RECEIPT_MAX_BYTES, allowedMimeTypes: RECEIPT_MIME_TYPES,
    });
    if (error && !/already exists/i.test(error.message || "")) throw new Error(error.message);
  })().catch((e) => { receiptBucketReady = null; throw e; });
  return receiptBucketReady;
}

// Upload a receipt: JSON { filename, dataUrl }. Staff, and agencies (who
// submit costs for dates they operate). Returns the reference to send as the
// cost line's receiptUrl.
app.post("/api/cost-receipts", requireAuth, requireRole("super_admin", "ops_staff", "agency_owner", "agency_agent"), uploadLimiter, h(async (req, res) => {
  if (!supabaseAdmin) throw new AppError(500, "Storage is not configured.");
  const { filename, dataUrl } = req.body || {};
  const file = parseReceiptDataUrl(dataUrl);
  if (file.error) throw new AppError(422, file.error);
  const key = receiptKey({ agencyId: isPlatform(req.user) ? null : req.user.agencyId, filename, ext: file.ext });
  try {
    await ensureReceiptBucket();
  } catch (e) {
    throw new AppError(500, "Receipt storage isn't available: " + e.message);
  }
  const { error } = await supabaseAdmin.storage.from(RECEIPT_BUCKET).upload(key, file.buffer, { contentType: file.contentType, upsert: false });
  if (error) throw new AppError(500, "Upload failed: " + error.message);
  const ref = `${RECEIPT_PREFIX}${key}`;
  await logAudit(req, { action: "receipt.upload", entity: "cost_receipt", entityId: key, detail: { bytes: file.buffer.length, type: file.contentType } });
  res.status(201).json({ ref, name: receiptDisplayName(ref) });
}));

// Open an uploaded receipt: a signed link valid for two minutes, for Sawa
// staff or the agency that submitted the cost line.
app.get("/api/cost-receipts/:costId", requireAuth, requireRole("super_admin", "ops_staff", "agency_owner", "agency_agent"), h(async (req, res) => {
  const row = await withSettlements(async () =>
    (await pool.query(`SELECT receipt_url, submitted_by_agency_id FROM departure_costs WHERE id = $1`, [Number(req.params.costId)])).rows[0]);
  if (!row || !isReceiptRef(row.receipt_url)) throw new AppError(404, "No receipt file on this cost line.");
  // An agency login with no agency must not match a Sawa-entered line (no
  // agency either): the same NULL-owner gap as the listing takeover.
  if (!isPlatform(req.user) && (!req.user.agencyId || row.submitted_by_agency_id !== req.user.agencyId)) throw new AppError(403, "This receipt isn't yours to open.");
  if (!supabaseAdmin) throw new AppError(500, "Storage is not configured.");
  const { data, error } = await supabaseAdmin.storage.from(RECEIPT_BUCKET).createSignedUrl(receiptRefKey(row.receipt_url), SIGNED_LINK_SECONDS);
  if (error || !data?.signedUrl) throw new AppError(502, "Couldn't open the receipt. Please try again.");
  res.json({ url: data.signedUrl, name: receiptDisplayName(row.receipt_url), expiresInSeconds: SIGNED_LINK_SECONDS });
}));
async function departureExists(id) {
  const d = (await pool.query(`SELECT id FROM departures WHERE id = $1`, [id])).rows[0];
  if (!d) throw new AppError(404, "Departure not found.");
}

// Sawa adds a cost line itself: approved as entered.
app.post("/api/admin/settlements/:depId/costs", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const input = parse(costSchema, req.body);
  const depId = Number(req.params.depId);
  await departureExists(depId);
  const row = await withSettlements(() =>
    insertCost(pool, depId, input, { receipt: receiptUrlOf(input.receiptUrl, req.user), email: req.user.email || null, approved: true }));
  await logAudit(req, { action: "settlement.cost_added", entity: "departure", entityId: String(depId), detail: { costId: Number(row.id), kind: lineKind(input.category), category: input.category, amount: Number(row.amount) } });
  res.status(201).json({ cost: mapCost(row) });
}));

// The operator submits its cost lines; Sawa reviews them.
app.post("/api/agency/departures/:depId/costs", requireAuth, requireRole("agency_owner", "agency_agent"), writeLimiter, h(async (req, res) => {
  const input = parse(costSchema, req.body);
  const depId = Number(req.params.depId);
  await departureExists(depId);
  // Who "operates" a date here is the old profit-share rule; a catalog date's
  // operator is its rate-card assignment, and Sawa records its costs.
  if ((await catalogueDepartureIds(pool, [depId])).size) {
    throw new AppError(409, "This is a catalog departure: Sawa records its costs (Operators and Finance). Send the receipts to Sawa.");
  }
  const row = await withSettlements(async () => {
    const L = await loadSettlements(pool, [depId]);
    const d = L.departures[0];
    const view = settlementView(d, L);
    if (view.operatorAgencyId !== req.user.agencyId) throw new AppError(403, "Only the agency operating this date can submit its costs.");
    if (view.costsFinalAt) throw new AppError(409, "Sawa has closed this cost sheet. Contact Sawa to add a cost.");
    return insertCost(pool, depId, input, { receipt: receiptUrlOf(input.receiptUrl, req.user), agencyId: req.user.agencyId, email: req.user.email || null });
  });
  await logAudit(req, { action: "settlement.cost_submitted", entity: "departure", entityId: String(depId), detail: { costId: Number(row.id), kind: lineKind(input.category), category: input.category, amount: Number(row.amount) } });
  res.status(201).json({ cost: mapCost(row) });
}));

const reviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  approvedAmount: z.coerce.number().min(0).optional(),
  note: z.string().trim().max(300).optional(),
});
app.post("/api/admin/departure-costs/:id/review", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const input = parse(reviewSchema, req.body);
  const row = await withSettlements(async () => {
    const cur = (await pool.query(`SELECT * FROM departure_costs WHERE id = $1`, [Number(req.params.id)])).rows[0];
    if (!cur) throw new AppError(404, "Cost line not found.");
    const sign = (await pool.query(`SELECT costs_final_at FROM departure_settlements WHERE departure_id = $1`, [cur.departure_id])).rows[0];
    if (sign?.costs_final_at) throw new AppError(409, "This cost sheet is final. Reopen it to change a line.");
    const approved = input.decision === "approve" ? Math.round((input.approvedAmount ?? Number(cur.amount)) * 100) / 100 : null;
    return (await pool.query(
      `UPDATE departure_costs SET state = $2, approved_amount = $3, review_note = $4, reviewed_by = $5, reviewed_at = now()
        WHERE id = $1 RETURNING *`,
      [cur.id, input.decision === "approve" ? "approved" : "rejected", approved, input.note || null, req.user.email || null])).rows[0];
  });
  await logAudit(req, { action: "settlement.cost_reviewed", entity: "departure", entityId: String(row.departure_id),
    detail: { costId: Number(row.id), decision: input.decision, asked: Number(row.amount), approved: row.approved_amount != null ? Number(row.approved_amount) : null, note: input.note || null } });
  res.json({ cost: mapCost(row) });
}));

// Sawa marks the cost sheet final (or reopens it). Final is what lets the
// departure into a Wednesday run.
app.post("/api/admin/settlements/:depId/costs-final", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const depId = Number(req.params.depId);
  const final = req.body?.final !== false;
  await departureExists(depId);
  await refuseCatalogueDeparture(pool, depId);
  await withSettlements(async () => {
    if (final) {
      const pending = (await pool.query(`SELECT COUNT(*)::int AS n FROM departure_costs WHERE departure_id = $1 AND state = 'submitted'`, [depId])).rows[0].n;
      if (pending) throw new AppError(409, `Review the ${pending} cost line${pending === 1 ? "" : "s"} still waiting first.`);
    }
    await pool.query(
      `INSERT INTO departure_settlements (departure_id, costs_final_at, costs_final_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (departure_id) DO UPDATE SET costs_final_at = $2, costs_final_by = $3, updated_at = now()`,
      [depId, final ? new Date() : null, final ? req.user.email || null : null]);
  });
  await logAudit(req, { action: final ? "settlement.costs_final" : "settlement.costs_reopened", entity: "departure", entityId: String(depId), detail: {} });
  res.json({ ok: true, final });
}));

const adjustmentSchema = z.object({
  agencyId: z.string().trim().max(120).nullable().optional(),
  amount: z.coerce.number().refine((n) => n !== 0 && Math.abs(n) < 1e7, "Enter a non-zero amount."),
  reason: z.string().trim().min(3, "Say why — this is Sawa's decision on record.").max(300),
});
app.post("/api/admin/settlements/:depId/adjustments", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const input = parse(adjustmentSchema, req.body);
  const depId = Number(req.params.depId);
  await departureExists(depId);
  await refuseCatalogueDeparture(pool, depId);
  if (input.agencyId && !(await pool.query(`SELECT 1 FROM agencies WHERE id = $1`, [input.agencyId])).rowCount) throw new AppError(422, "Unknown agency.");
  const row = await withSettlements(async () => (await pool.query(
    `INSERT INTO settlement_adjustments (departure_id, agency_id, amount, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [depId, input.agencyId || null, Math.round(input.amount * 100) / 100, input.reason, req.user.email || null])).rows[0]);
  await logAudit(req, { action: "settlement.adjustment", entity: "departure", entityId: String(depId), detail: { agencyId: input.agencyId || null, amount: Number(row.amount), reason: input.reason } });
  res.status(201).json({ adjustment: mapAdjustment(row) });
}));

app.post("/api/admin/settlements/:depId/loss-decision", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const note = String(req.body?.note || "").trim().slice(0, 500);
  if (note.length < 3) throw new AppError(422, "Record Sawa's decision — who absorbs the loss, and why.");
  const depId = Number(req.params.depId);
  await departureExists(depId);
  await refuseCatalogueDeparture(pool, depId);
  await withSettlements(() => pool.query(
    `INSERT INTO departure_settlements (departure_id, loss_decided_at, loss_decided_by, loss_note, updated_at) VALUES ($1, now(), $2, $3, now())
     ON CONFLICT (departure_id) DO UPDATE SET loss_decided_at = now(), loss_decided_by = $2, loss_note = $3, updated_at = now()`,
    [depId, req.user.email || null, note]));
  await logAudit(req, { action: "settlement.loss_decision", entity: "departure", entityId: String(depId), detail: { note } });
  res.json({ ok: true });
}));

// ---- The Wednesday runs

async function runDetail(db, runRow, agencyName) {
  const lines = (await db.query(`SELECT l.*, d.route, d.date, d.start_date, d.end_date FROM payout_lines l JOIN departures d ON d.id = l.departure_id WHERE l.run_id = $1 ORDER BY l.agency_id, l.departure_id`, [runRow.id])).rows;
  const transfers = (await db.query(`SELECT * FROM payout_transfers WHERE run_id = $1 ORDER BY agency_id`, [runRow.id])).rows;
  const byAgency = new Map();
  for (const l of lines) byAgency.set(l.agency_id, Math.round(((byAgency.get(l.agency_id) || 0) + Number(l.amount)) * 100) / 100);
  return {
    id: Number(runRow.id), payDate: isoDate(runRow.pay_date), cutoffAt: runRow.cutoff_at, state: runRow.state,
    createdBy: runRow.created_by, approvedBy: runRow.approved_by, approvedAt: runRow.approved_at,
    lines: lines.map((l) => ({
      id: Number(l.id), departureId: Number(l.departure_id), route: l.route,
      dateLabel: depDateLabel({ date: isoDate(l.date), startDate: isoDate(l.start_date), endDate: isoDate(l.end_date) }),
      agencyId: l.agency_id, name: agencyName.get(l.agency_id) || l.agency_id, amount: Number(l.amount), detail: l.detail,
    })),
    totals: [...byAgency].map(([agencyId, amount]) => ({ agencyId, name: agencyName.get(agencyId) || agencyId, amount })),
    transfers: transfers.map((t) => ({
      id: Number(t.id), agencyId: t.agency_id, name: agencyName.get(t.agency_id) || t.agency_id, amount: Number(t.amount),
      state: t.state, paidAt: t.paid_at, bankReference: t.bank_reference || null,
    })),
  };
}

app.get("/api/admin/payout-runs", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  let runs;
  try { runs = (await pool.query(`SELECT * FROM payout_runs ORDER BY pay_date DESC LIMIT 26`)).rows; } catch (e) {
    if (isMissingSettlementTables(e)) return res.json({ available: false, runs: [] });
    throw e;
  }
  const agencyName = new Map((await pool.query(`SELECT id, name FROM agencies`)).rows.map((a) => [a.id, a.name]));
  const out = [];
  for (const r of runs) out.push(await runDetail(pool, r, agencyName));
  res.json({ available: true, runs: out, nextPayDate: payDateOnOrAfter(cairoDay(Date.now())) });
}));

// Build (or rebuild) the draft for a Wednesday: every signed-off departure that
// ended by the Saturday before, owed as of that Saturday's end, minus what
// approved runs already paid.
const runSchema = z.object({ payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
app.post("/api/admin/payout-runs", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { payDate: asked } = parse(runSchema, req.body || {});
  const payDate = asked || payDateOnOrAfter(cairoDay(Date.now()));
  let win;
  try { win = runWindow(payDate); } catch { throw new AppError(422, "Payouts are on Wednesdays — pick a Wednesday."); }
  let skipped = [];
  const run = await withSettlements(() => withTransaction(async (c) => {
    const existing = (await c.query(`SELECT * FROM payout_runs WHERE pay_date = $1 FOR UPDATE`, [payDate])).rows[0];
    if (existing?.state === "approved") throw new AppError(409, `The run for ${payDate} is already approved.`);
    if ((await c.query(`SELECT 1 FROM payout_runs WHERE state = 'draft' AND pay_date < $1`, [payDate])).rowCount) {
      throw new AppError(409, "An earlier Wednesday's run is still a draft. Approve or rebuild that one first.");
    }
    const runRow = existing || (await c.query(
      `INSERT INTO payout_runs (pay_date, cutoff_at, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [payDate, new Date(win.cutoffMs), req.user.email || null])).rows[0];
    await c.query(`DELETE FROM payout_lines WHERE run_id = $1`, [runRow.id]);

    const L = await loadSettlements(c);
    // Catalog departures are never paid out here (they're settled under
    // Operators and Finance): skipped, and said so.
    skipped = L.excludedCatalogue;
    if (skipped.length) console.log(`payout run ${payDate}: skipped ${skipped.length} catalog departure${skipped.length === 1 ? "" : "s"} (${skipped.join(", ")}); they are settled under Operators and Finance`);
    const entitled = [];
    const inScope = new Set();
    for (const d of L.departures) {
      const v = settlementView(d, L, { asOfMs: win.cutoffMs, endedByDay: win.saturday });
      if (v.blocker) continue;
      inScope.add(d.id);
      for (const x of v.settlement.shares) {
        entitled.push({ departureId: d.id, agencyId: x.agencyId, amount: x.total,
          detail: { seats: x.seats, pct: x.pct, share: x.share, adjustments: x.adjustments, revenue: v.settlement.revenue, income: v.settlement.income, cost: v.settlement.cost, gross: v.settlement.gross, sawaCut: v.settlement.sawaCut } });
      }
    }
    const alreadyPaid = new Map();
    const prior = (await c.query(
      `SELECT l.departure_id, l.agency_id, SUM(l.amount) AS amount FROM payout_lines l JOIN payout_runs r ON r.id = l.run_id
        WHERE r.state = 'approved' GROUP BY l.departure_id, l.agency_id`)).rows;
    for (const r of prior) alreadyPaid.set(`${r.departure_id}:${r.agency_id}`, Number(r.amount));
    for (const l of payoutLines(entitled, alreadyPaid, inScope)) {
      await c.query(`INSERT INTO payout_lines (run_id, departure_id, agency_id, amount, detail) VALUES ($1, $2, $3, $4, $5)`,
        [runRow.id, l.departureId, l.agencyId, l.amount, JSON.stringify(l.detail)]);
    }
    return runRow;
  }));
  await logAudit(req, { action: "payout.run_built", entity: "payout_run", entityId: String(run.id), detail: { payDate, skippedCatalogueDepartures: skipped } });
  const agencyName = new Map((await pool.query(`SELECT id, name FROM agencies`)).rows.map((a) => [a.id, a.name]));
  res.status(201).json({ run: await runDetail(pool, run, agencyName), skippedCatalogueDepartures: skipped });
}));

app.post("/api/admin/payout-runs/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const id = Number(req.params.id);
  const run = await withSettlements(() => withTransaction(async (c) => {
    const r = (await c.query(`SELECT * FROM payout_runs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new AppError(404, "Run not found.");
    if (r.state !== "draft") throw new AppError(409, "This run is already approved.");
    // A draft built before catalog departures were excluded could still hold one.
    const lineDeps = (await c.query("SELECT DISTINCT departure_id FROM payout_lines WHERE run_id = $1", [id])).rows.map((x) => Number(x.departure_id));
    const catalogueLines = [...await catalogueDepartureIds(c, lineDeps)];
    if (catalogueLines.length) {
      throw new AppError(409, `This run includes catalog departure${catalogueLines.length === 1 ? "" : "s"} ${catalogueLines.join(", ")}, which ${catalogueLines.length === 1 ? "is" : "are"} settled under Operators and Finance. Rebuild the run to drop ${catalogueLines.length === 1 ? "it" : "them"}.`);
    }
    const totals = (await c.query(`SELECT agency_id, SUM(amount) AS amount FROM payout_lines WHERE run_id = $1 GROUP BY agency_id`, [id])).rows;
    for (const t of totals) {
      await c.query(`INSERT INTO payout_transfers (run_id, agency_id, amount) VALUES ($1, $2, $3)`, [id, t.agency_id, Number(t.amount)]);
    }
    return (await c.query(`UPDATE payout_runs SET state = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [id, req.user.email || null])).rows[0];
  }));
  await logAudit(req, { action: "payout.run_approved", entity: "payout_run", entityId: String(id), detail: { payDate: isoDate(run.pay_date) } });
  const agencyName = new Map((await pool.query(`SELECT id, name FROM agencies`)).rows.map((a) => [a.id, a.name]));
  res.json({ run: await runDetail(pool, run, agencyName) });
}));

app.post("/api/admin/payout-transfers/:id/paid", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reference = String(req.body?.reference || "").trim().slice(0, 120);
  if (!reference) throw new AppError(422, "Enter the bank transfer reference.");
  const row = await withSettlements(async () => {
    const r = (await pool.query(
      `UPDATE payout_transfers SET state = 'paid', paid_at = now(), bank_reference = $2, paid_by = $3
        WHERE id = $1 AND state = 'due' RETURNING *`, [Number(req.params.id), reference, req.user.email || null])).rows[0];
    if (!r) throw new AppError(409, "This transfer is not waiting to be paid.");
    return r;
  });
  await logAudit(req, { action: "payout.transfer_paid", entity: "agency", entityId: row.agency_id, detail: { transferId: Number(row.id), runId: Number(row.run_id), amount: Number(row.amount), reference } });
  res.json({ ok: true });
}));

// ---- The agency's money

app.get("/api/agency/money", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const me = req.user.agencyId;
  if (!me) throw new AppError(403, "This account is not linked to an agency.");
  let L;
  try { L = await loadSettlements(pool); } catch (e) {
    if (isMissingSettlementTables(e) || isMissingPaymentsTable(e)) return res.json({ available: false, departures: [], transfers: [] });
    throw e;
  }
  const departures = [];
  for (const d of L.departures) {
    const v = settlementView(d, L);
    const mine = v.settlement.shares.find((x) => x.agencyId === me);
    const operating = v.operatorAgencyId === me;
    if (!mine && !operating) continue;
    // An agency sees its own share and the departure's totals — not the other
    // agencies' shares, and cost lines only on a date it operates.
    departures.push({
      departure: v.departure, dateLabel: v.dateLabel, operating, operatorName: v.operatorName,
      revenue: v.settlement.revenue, income: v.settlement.income, cost: v.settlement.cost, gross: v.settlement.gross, sawaCut: v.settlement.sawaCut,
      loss: v.settlement.loss, totalSeats: v.settlement.totalSeats,
      mine: mine ? { seats: mine.seats, pct: mine.pct, share: mine.share, adjustments: mine.adjustments, total: mine.total, paidOut: mine.paidOut } : null,
      adjustments: v.adjustments.filter((a) => a.agencyId === me),
      costs: operating ? v.costs : [],
      travellers: operating ? v.travellers : null,
      costsFinal: !!v.costsFinalAt,
      blockerLabel: v.blockerLabel,
    });
  }
  const agencyName = L.agencyName;
  const transfers = (await pool.query(
    `SELECT t.*, r.pay_date FROM payout_transfers t JOIN payout_runs r ON r.id = t.run_id WHERE t.agency_id = $1 ORDER BY r.pay_date DESC`, [me])).rows
    .map((t) => ({ id: Number(t.id), payDate: isoDate(t.pay_date), amount: Number(t.amount), state: t.state, paidAt: t.paid_at, bankReference: t.bank_reference || null }));
  res.json({ available: true, agencyName: agencyName.get(me) || null, departures, transfers,
    nextPayDate: payDateOnOrAfter(cairoDay(Date.now())), categories: LINE_CATEGORIES });
}));
