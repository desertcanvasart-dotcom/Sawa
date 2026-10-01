// Operators (model phase 2): the operator record, its documents, the products
// it may run, strikes, the portal inbox, and the daily document job.
//
// An operator is the operator ROLE of a company; `agencies` stays the company
// record. Status rules:
//   pending    created, documents not all valid yet — can't be rostered
//   active     every required document current and approved (or activated
//              by exception, 068, with the reason recorded) — can be rostered
//   suspended  a document expired (or an admin suspended it) — can't be
//              rostered; a valid replacement for an expired document
//              reactivates it
//   removed    off the roster for good (manual)
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import {
  DOCUMENT_KINDS, DOCUMENT_LABELS, OPERATOR_STATUSES, STRIKE_KINDS, STRIKE_WINDOW_DAYS,
  DOCUMENT_REMINDER_DAYS, strikesInWindow,
} from "../shared/operators.js";
import { shiftDate } from "../shared/catalogue.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
export const isMissingOperatorTables = (e) => e?.code === "42P01" || e?.code === "42703";

export function mapOperator(r) {
  return {
    id: Number(r.id), agencyId: r.agency_id, legalName: r.legal_name, tradingName: r.trading_name,
    tourismLicenseNo: r.tourism_license_no, etaaNo: r.etaa_no,
    commercialRegistrationNo: r.commercial_registration_no, taxRegistrationNo: r.tax_registration_no,
    email: r.email, whatsapp: r.whatsapp, phone: r.phone, contacts: r.contacts || [],
    status: r.status, statusReason: r.status_reason, statusChangedAt: r.status_changed_at, statusChangedBy: r.status_changed_by,
    notes: r.notes, createdAt: r.created_at,
    // Migration 053 (absent before it is applied).
    travellerLicenceNo: r.traveller_licence_no ?? null, activationBlocked: r.activation_blocked ?? null,
    // 068: activated with papers missing, and why (absent before it is applied).
    activationException: r.activation_exception ?? null,
    activationExceptionKinds: Array.isArray(r.activation_exception_kinds) ? r.activation_exception_kinds : [],
    activationExceptionBy: r.activation_exception_by ?? null, activationExceptionAt: r.activation_exception_at ?? null,
  };
}

export function mapDocument(r) {
  return {
    id: Number(r.id), operatorId: Number(r.operator_id), kind: r.kind, number: r.number,
    expiresOn: ymd(r.expires_on), hasFile: !!r.file_ref, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
    supersededAt: r.superseded_at,
    // 068. Before it every document was entered by an admin, so approved.
    reviewState: r.review_state || "approved", reviewNote: r.review_note ?? null,
    reviewedBy: r.reviewed_by ?? null, reviewedAt: r.reviewed_at ?? null, submittedVia: r.submitted_via || "admin",
  };
}

// Only an APPROVED document counts (068). Before 068 there is no review_state
// column and every document is approved, so the filter is dropped.
export async function queryApprovedDocs(db, sql, params) {
  try {
    return await db.query(sql.replace("{approved}", "AND d.review_state = 'approved'"), params);
  } catch (e) {
    if (e?.code !== "42703") throw e;
    return db.query(sql.replace("{approved}", ""), params);
  }
}

export function mapStrike(r) {
  return {
    id: Number(r.id), operatorId: Number(r.operator_id), departureId: r.departure_id == null ? null : Number(r.departure_id),
    assignmentId: r.assignment_id == null ? null : Number(r.assignment_id), kind: r.kind, note: r.note,
    createdBy: r.created_by, createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    voidedAt: r.voided_at, voidedBy: r.voided_by, voidReason: r.void_reason,
  };
}

export async function getOperator(db, id) {
  const r = await db.query("SELECT * FROM operators WHERE id = $1", [id]);
  if (!r.rows.length) throw new CatalogueError(404, "Operator not found.");
  return mapOperator(r.rows[0]);
}

export async function currentDocuments(db, operatorId) {
  const r = await queryApprovedDocs(db,
    "SELECT d.* FROM operator_documents d WHERE d.operator_id = $1 AND d.superseded_at IS NULL {approved} ORDER BY d.kind", [operatorId]);
  return r.rows.map(mapDocument);
}

// Which required documents are missing or expired on `today`. `excused`: the
// kinds an activation by exception covers (068), not counted as gaps.
export function documentGaps(docs, today, excused = []) {
  const byKind = new Map(docs.filter((d) => (d.reviewState || "approved") === "approved").map((d) => [d.kind, d]));
  return DOCUMENT_KINDS.filter((kind) => !excused.includes(kind)).flatMap((kind) => {
    const d = byKind.get(kind);
    if (!d) return [{ kind, problem: "missing" }];
    if (d.expiresOn < today) return [{ kind, problem: "expired", expiresOn: d.expiresOn }];
    return [];
  });
}

export async function listOperators(db = pool, now = Date.now()) {
  const today = todayIn(now);
  const [ops, docs, strikes, approvals] = await Promise.all([
    db.query("SELECT * FROM operators ORDER BY legal_name"),
    queryApprovedDocs(db, "SELECT d.* FROM operator_documents d WHERE d.superseded_at IS NULL {approved}"),
    db.query("SELECT * FROM operator_strikes WHERE created_at >= now() - ($1 || ' days')::interval", [String(STRIKE_WINDOW_DAYS)]),
    db.query("SELECT operator_id, product_id FROM operator_product_approvals"),
  ]);
  const group = (rows, map) => rows.reduce((m, r) => {
    const k = Number(r.operator_id);
    (m.get(k) || m.set(k, []).get(k)).push(map(r));
    return m;
  }, new Map());
  const docsBy = group(docs.rows, mapDocument);
  const strikesBy = group(strikes.rows, mapStrike);
  const approvalsBy = group(approvals.rows, (r) => Number(r.product_id));
  // What waits for an admin: papers and bank details an agency sent (068).
  const waiting = await db.query(
    `SELECT operator_id, COUNT(*)::int AS n FROM (
       SELECT operator_id FROM operator_documents WHERE superseded_at IS NULL AND review_state = 'pending'
       UNION ALL SELECT operator_id FROM operator_bank_accounts WHERE state = 'pending') x GROUP BY operator_id`)
    .then((r) => new Map(r.rows.map((x) => [Number(x.operator_id), x.n])))
    .catch((e) => { if (e?.code === "42703" || e?.code === "42P01") return new Map(); throw e; });
  return ops.rows.map(mapOperator).map((o) => ({
    ...o,
    documents: docsBy.get(o.id) || [],
    toReview: waiting.get(o.id) || 0,
    documentGaps: documentGaps(docsBy.get(o.id) || [], today),
    strikes90: strikesInWindow(strikesBy.get(o.id) || [], now).length,
    approvedProductIds: approvalsBy.get(o.id) || [],
  }));
}

const OPERATOR_FIELDS = {
  legalName: "legal_name", tradingName: "trading_name", tourismLicenseNo: "tourism_license_no", etaaNo: "etaa_no",
  commercialRegistrationNo: "commercial_registration_no", taxRegistrationNo: "tax_registration_no",
  email: "email", whatsapp: "whatsapp", phone: "phone", notes: "notes", agencyId: "agency_id",
  // Migration 053: the licence number printed for travelers where this
  // operator is named as seller (payment request, receipt, voucher, booking page).
  travellerLicenceNo: "traveller_licence_no",
};

export async function createOperator(db, fields, by) {
  if (!String(fields.legalName || "").trim()) throw new CatalogueError(422, "An operator needs its legal name.");
  const cols = [];
  const vals = [];
  for (const [k, col] of Object.entries(OPERATOR_FIELDS)) {
    if (fields[k] == null || fields[k] === "") continue;
    cols.push(col);
    vals.push(String(fields[k]).trim());
  }
  cols.push("contacts", "status_changed_by");
  vals.push(JSON.stringify(Array.isArray(fields.contacts) ? fields.contacts : []), by);
  try {
    const r = await db.query(
      `INSERT INTO operators (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, vals);
    return mapOperator(r.rows[0]);
  } catch (e) {
    if (e?.code === "23505") throw new CatalogueError(409, "That company already has an operator record.");
    if (e?.code === "23503") throw new CatalogueError(422, "No company record has that id.");
    throw e;
  }
}

export async function updateOperator(db, id, fields) {
  const sets = [];
  const args = [id];
  for (const [k, col] of Object.entries(OPERATOR_FIELDS)) {
    if (!(k in fields)) continue;
    const v = fields[k] == null ? null : String(fields[k]).trim() || null;
    if (k === "legalName" && !v) throw new CatalogueError(422, "An operator needs its legal name.");
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  if ("contacts" in fields) {
    if (!Array.isArray(fields.contacts)) throw new CatalogueError(422, "Contacts must be a list.");
    args.push(JSON.stringify(fields.contacts));
    sets.push(`contacts = $${args.length}`);
  }
  if (!sets.length) return getOperator(db, id);
  const r = await db.query(`UPDATE operators SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, args);
  if (!r.rows.length) throw new CatalogueError(404, "Operator not found.");
  return mapOperator(r.rows[0]);
}

// Status changes an admin makes. Activating needs every required document
// current and approved, unless the admin activates by exception and says why
// (068): the reason and the papers it covers are recorded on the operator, and
// the daily check doesn't suspend it for those papers.
export async function setOperatorStatus(db, id, status, { by, reason = null, exceptionReason = null, now = Date.now() } = {}) {
  if (!OPERATOR_STATUSES.includes(status)) throw new CatalogueError(422, "Unknown operator status.");
  const op = await getOperator(db, id);
  if (op.status === "removed" && status !== "removed") throw new CatalogueError(409, "A removed operator can't be reinstated here; create a new operator record.");
  // Migration 053: a record that must never be activated (Capital Travel
  // Service, decided 27 Sep 2026).
  if (status === "active" && op.activationBlocked) throw new CatalogueError(409, op.activationBlocked);
  const why = String(exceptionReason || "").trim();
  let exception = null;
  if (status === "active") {
    const gaps = documentGaps(await currentDocuments(db, id), todayIn(now));
    if (gaps.length && !why) {
      throw new CatalogueError(422, `Upload a current ${gaps.map((g) => DOCUMENT_LABELS[g.kind].toLowerCase()).join(", ")} before activating, or activate by exception and record why.`);
    }
    if (gaps.length) {
      if (why.length < 10) throw new CatalogueError(422, "Say why it is activated without these papers (at least 10 characters).");
      exception = { reason: why.slice(0, 500), kinds: gaps.map((g) => g.kind) };
    }
  }
  const r = await db.query(
    `UPDATE operators SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, exception ? `Activated by exception: ${exception.reason}` : reason, by]);
  // The exception lasts while the operator is active on it; any other status
  // change, or an activation with every paper in order, ends it.
  if (exception) {
    const x = await db.query(
      `UPDATE operators SET activation_exception = $2, activation_exception_kinds = $3::jsonb,
              activation_exception_by = $4, activation_exception_at = now() WHERE id = $1 RETURNING *`,
      [id, exception.reason, JSON.stringify(exception.kinds), by]);
    return mapOperator(x.rows[0]);
  }
  if (op.activationException) {
    const x = await db.query(
      `UPDATE operators SET activation_exception = NULL, activation_exception_kinds = NULL,
              activation_exception_by = NULL, activation_exception_at = NULL WHERE id = $1 RETURNING *`, [id]);
    return mapOperator(x.rows[0]);
  }
  return mapOperator(r.rows[0]);
}

// A new document of a kind supersedes the current one. If the operator was
// suspended because a document expired and every document is now current, it
// is reactivated — the one automatic way back.
export async function addDocument(db, operatorId, { kind, number, expiresOn, fileRef }, { by, now = Date.now() } = {}) {
  if (!DOCUMENT_KINDS.includes(kind)) throw new CatalogueError(422, "Unknown document type.");
  const expires = ymd(expiresOn);
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new CatalogueError(422, "A document needs its expiry date.");
  const today = todayIn(now);
  return inTx(db, async (c) => {
    await getOperator(c, operatorId);
    await c.query("UPDATE operator_documents SET superseded_at = now() WHERE operator_id = $1 AND kind = $2 AND superseded_at IS NULL", [operatorId, kind]);
    const r = await c.query(
      `INSERT INTO operator_documents (operator_id, kind, number, expires_on, file_ref, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [operatorId, kind, number ? String(number).trim() : null, expires, fileRef || null, by]);
    const reactivated = await reactivateIfComplete(c, operatorId, { by, today });
    return { document: mapDocument(r.rows[0]), reactivated };
  });
}

// Suspended because a document expired, and every document is now current and
// approved: active again — the one automatic way back.
async function reactivateIfComplete(c, operatorId, { by, today }) {
  const op = await getOperator(c, operatorId);
  if (op.status === "suspended" && !op.activationBlocked && String(op.statusReason || "").startsWith("document_expired")
      && documentGaps(await currentDocuments(c, operatorId), today).length === 0) {
    await c.query(
      `UPDATE operators SET status = 'active', status_reason = 'Reactivated: valid replacement uploaded',
              status_changed_at = now(), status_changed_by = $2, updated_at = now() WHERE id = $1`, [operatorId, by]);
    return true;
  }
  return false;
}

// The operator record of an agency's company. `create`: make a pending one
// (named after the agency) when it has none, for the agency's first upload.
export async function agencyOperator(db, agencyId, { create = false, by = null } = {}) {
  const found = await db.query("SELECT * FROM operators WHERE agency_id = $1", [agencyId]);
  if (found.rows.length) return mapOperator(found.rows[0]);
  if (!create) return null;
  const a = (await db.query("SELECT name FROM agencies WHERE id = $1", [agencyId])).rows[0];
  if (!a) throw new CatalogueError(404, "Agency not found.");
  return createOperator(db, { legalName: a.name, agencyId }, by);
}

// A document the agency sends from its dashboard (068). It waits for an admin:
// it doesn't count until approved, and the approved one stays in force until
// then. A second upload of the same kind replaces the one still waiting.
export async function submitAgencyDocument(db, operatorId, { kind, number, expiresOn, fileRef }, { by }) {
  if (!DOCUMENT_KINDS.includes(kind)) throw new CatalogueError(422, "Unknown document type.");
  const expires = ymd(expiresOn);
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new CatalogueError(422, "A document needs its expiry date.");
  if (!fileRef) throw new CatalogueError(422, "Attach the document (PDF or photo).");
  return inTx(db, async (c) => {
    await getOperator(c, operatorId);
    await c.query(
      `UPDATE operator_documents SET superseded_at = now()
        WHERE operator_id = $1 AND kind = $2 AND superseded_at IS NULL AND review_state = 'pending'`, [operatorId, kind]);
    const r = await c.query(
      `INSERT INTO operator_documents (operator_id, kind, number, expires_on, file_ref, uploaded_by, review_state, submitted_via)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'agency') RETURNING *`,
      [operatorId, kind, number ? String(number).trim() : null, expires, fileRef, by]);
    return mapDocument(r.rows[0]);
  });
}

// An admin approves or rejects a document waiting for review. Approving puts it
// in force (the previous approved one of that kind is kept, superseded);
// rejecting needs a reason, which the agency sees.
export async function reviewDocument(db, operatorId, documentId, { approve, note = null, by, now = Date.now() }) {
  return inTx(db, async (c) => {
    const d = (await c.query(
      "SELECT * FROM operator_documents WHERE id = $1 AND operator_id = $2 FOR UPDATE", [documentId, operatorId])).rows[0];
    if (!d || d.review_state !== "pending" || d.superseded_at) throw new CatalogueError(409, "Only a document waiting for review can be approved or rejected.");
    const why = String(note || "").trim().slice(0, 500) || null;
    if (!approve && !why) throw new CatalogueError(422, "Say why the document is rejected; the agency sees it.");
    if (approve) {
      await c.query(
        `UPDATE operator_documents SET superseded_at = now()
          WHERE operator_id = $1 AND kind = $2 AND superseded_at IS NULL AND review_state = 'approved'`, [operatorId, d.kind]);
    }
    const r = await c.query(
      `UPDATE operator_documents SET review_state = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
              superseded_at = CASE WHEN $2 = 'rejected' THEN now() ELSE NULL END
        WHERE id = $1 RETURNING *`, [documentId, approve ? "approved" : "rejected", why, by]);
    const reactivated = approve ? await reactivateIfComplete(c, operatorId, { by, today: todayIn(now) }) : false;
    return { document: mapDocument(r.rows[0]), reactivated };
  });
}

export async function setApprovals(db, operatorId, productIds, by) {
  const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  return inTx(db, async (c) => {
    await getOperator(c, operatorId);
    await c.query("DELETE FROM operator_product_approvals WHERE operator_id = $1 AND NOT (product_id = ANY($2::bigint[]))", [operatorId, ids]);
    for (const pid of ids) {
      await c.query(
        `INSERT INTO operator_product_approvals (operator_id, product_id, approved_by) VALUES ($1, $2, $3)
         ON CONFLICT (operator_id, product_id) DO NOTHING`, [operatorId, pid, by]);
    }
    return ids;
  });
}

// May this operator be put on the roster for this product? The one rule every
// roster write goes through.
export async function rosterEligibility(db, operatorId, productId) {
  const r = await db.query(
    `SELECT o.status, o.legal_name, EXISTS (SELECT 1 FROM operator_product_approvals a
                                        WHERE a.operator_id = o.id AND a.product_id = $2) AS approved
       FROM operators o WHERE o.id = $1`, [operatorId, productId]);
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "No such operator." };
  if (row.status !== "active") return { ok: false, reason: `${row.legal_name} is ${row.status}, and only active operators can be rostered.` };
  if (!row.approved) return { ok: false, reason: `${row.legal_name} isn't approved for this product.` };
  return { ok: true };
}

// ---------------------------------------------------------------- strikes
export async function addStrike(db, { operatorId, kind, note = null, departureId = null, assignmentId = null, by = null }) {
  if (!STRIKE_KINDS.includes(kind)) throw new CatalogueError(422, "Unknown strike type.");
  const r = await db.query(
    `INSERT INTO operator_strikes (operator_id, kind, note, departure_id, assignment_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (assignment_id) WHERE kind = 'missed_acknowledgement' DO NOTHING RETURNING *`,
    [operatorId, kind, note, departureId, assignmentId, by]);
  return r.rows[0] ? mapStrike(r.rows[0]) : null;
}

export async function voidStrike(db, strikeId, { by, reason }) {
  if (!String(reason || "").trim()) throw new CatalogueError(422, "Say why this strike is voided.");
  const r = await db.query(
    `UPDATE operator_strikes SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING *`,
    [strikeId, by, String(reason).trim()]);
  if (!r.rows.length) throw new CatalogueError(404, "Strike not found, or already voided.");
  return mapStrike(r.rows[0]);
}

export async function strikesFor(db, operatorId) {
  const r = await db.query("SELECT * FROM operator_strikes WHERE operator_id = $1 ORDER BY created_at DESC", [operatorId]);
  return r.rows.map(mapStrike);
}

// ---------------------------------------------------------------- inbox
// A portal notice, optionally emailed too. `dedupeKey` makes it once-only.
export async function notifyOperator(db, { operatorId, kind, title, body, departureId = null, dedupeKey = null, email = null, send = null }) {
  const r = await db.query(
    `INSERT INTO operator_notifications (operator_id, kind, title, body, departure_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [operatorId, kind, title, body, departureId, dedupeKey]);
  const id = r.rows[0]?.id;
  if (!id) return { created: false };
  if (email && send) {
    try {
      const res = await send(email);
      if (!res?.ok) throw new Error(res?.error || "not accepted");
      await db.query("UPDATE operator_notifications SET emailed_at = now() WHERE id = $1", [id]);
    } catch (e) {
      await db.query("UPDATE operator_notifications SET email_error = $2 WHERE id = $1", [id, String(e.message).slice(0, 300)]);
    }
  }
  return { created: true, id: Number(id) };
}

// Where an operator's email goes: its own address, then its owners' logins.
export async function operatorRecipients(db, operatorId) {
  const r = await db.query(
    `SELECT email FROM operators WHERE id = $1 AND email IS NOT NULL
     UNION SELECT email FROM app_users WHERE operator_id = $1 AND role = 'operator_owner' AND status = 'active'`,
    [operatorId]);
  return [...new Set(r.rows.map((x) => String(x.email).toLowerCase()))];
}

// ---------------------------------------------------------------- daily job
// Suspends an operator when any current document has expired, and reminds the
// operator and admin 30 and 7 days before. Suspension is a status change only;
// its roster days are flagged for an admin to reassign.
export async function runDocumentJob({ db = pool, now = Date.now(), send = null, adminEmail = null, log = () => {} } = {}) {
  const today = todayIn(now);
  const out = { suspended: 0, reminders: 0 };
  // An approved document that expired, unless the operator was activated by
  // exception for that paper (068).
  const expired = await queryApprovedDocs(db,
    `SELECT DISTINCT d.operator_id, d.kind, d.expires_on FROM operator_documents d JOIN operators o ON o.id = d.operator_id
      WHERE d.superseded_at IS NULL AND d.expires_on < $1 AND o.status = 'active' {approved}`, [today]);
  const excused = await db.query("SELECT id, activation_exception_kinds FROM operators WHERE activation_exception IS NOT NULL")
    .then((r) => new Map(r.rows.map((x) => [Number(x.id), x.activation_exception_kinds || []])))
    .catch((e) => { if (e?.code === "42703") return new Map(); throw e; });
  expired.rows = expired.rows.filter((row) => !(excused.get(Number(row.operator_id)) || []).includes(row.kind));
  for (const row of expired.rows) {
    const r = await db.query(
      `UPDATE operators SET status = 'suspended', status_reason = $2, status_changed_at = now(),
              status_changed_by = 'system', updated_at = now()
        WHERE id = $1 AND status = 'active'`,
      [row.operator_id, `document_expired:${row.kind}`]);
    if (r.rowCount) {
      out.suspended += 1;
      log(`operator ${row.operator_id} suspended: ${row.kind} expired ${ymd(row.expires_on)}`);
      await notifyOperator(db, {
        operatorId: Number(row.operator_id), kind: "suspended",
        title: `Suspended from the roster: ${DOCUMENT_LABELS[row.kind]} expired`,
        body: `Your ${DOCUMENT_LABELS[row.kind].toLowerCase()} expired on ${ymd(row.expires_on)}. You won't be rostered until Sawa has a valid replacement.`,
        dedupeKey: `suspended:${row.operator_id}:${row.kind}:${ymd(row.expires_on)}`,
      });
    }
  }
  for (const days of DOCUMENT_REMINDER_DAYS) {
    const due = await queryApprovedDocs(db,
      `SELECT d.*, o.legal_name FROM operator_documents d JOIN operators o ON o.id = d.operator_id
        WHERE d.superseded_at IS NULL AND d.expires_on = $1 AND o.status IN ('active', 'pending') {approved}`,
      [shiftDate(today, days)]);
    for (const d of due.rows) {
      const recipients = [...await operatorRecipients(db, d.operator_id), ...(adminEmail ? [adminEmail] : [])];
      for (const to of recipients) {
        const ins = await db.query(
          `INSERT INTO operator_document_reminders (document_id, days_before, recipient) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING id`, [d.id, days, to]);
        if (!ins.rows.length) continue;
        out.reminders += 1;
        if (send) {
          const { documentExpiryEmail } = await import("./email.js");
          await send(documentExpiryEmail({ to, operatorName: d.legal_name, document: DOCUMENT_LABELS[d.kind], expiresOn: ymd(d.expires_on), days }));
        }
      }
      await notifyOperator(db, {
        operatorId: Number(d.operator_id), kind: "document_expiry",
        title: `${DOCUMENT_LABELS[d.kind]} expires in ${days} days`,
        body: `Your ${DOCUMENT_LABELS[d.kind].toLowerCase()} expires on ${ymd(d.expires_on)}. Send Sawa the renewal before then to stay on the roster.`,
        dedupeKey: `expiry:${d.id}:${days}`,
      });
    }
  }
  return out;
}
