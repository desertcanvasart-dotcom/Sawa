// Operators (model phase 2): the operator record, its documents, the products
// it may run, strikes, the portal inbox, and the daily document job.
//
// An operator is the operator ROLE of a company; `agencies` stays the company
// record. Status rules:
//   pending    created, documents not all valid yet — can't be rostered
//   active     all four documents current — can be rostered and assigned
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
  };
}

export function mapDocument(r) {
  return {
    id: Number(r.id), operatorId: Number(r.operator_id), kind: r.kind, number: r.number,
    expiresOn: ymd(r.expires_on), hasFile: !!r.file_ref, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
    supersededAt: r.superseded_at,
  };
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
  const r = await db.query(
    "SELECT * FROM operator_documents WHERE operator_id = $1 AND superseded_at IS NULL ORDER BY kind", [operatorId]);
  return r.rows.map(mapDocument);
}

// Which of the four documents are missing or expired on `today`.
export function documentGaps(docs, today) {
  const byKind = new Map(docs.map((d) => [d.kind, d]));
  return DOCUMENT_KINDS.flatMap((kind) => {
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
    db.query("SELECT * FROM operator_documents WHERE superseded_at IS NULL"),
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
  return ops.rows.map(mapOperator).map((o) => ({
    ...o,
    documents: docsBy.get(o.id) || [],
    documentGaps: documentGaps(docsBy.get(o.id) || [], today),
    strikes90: strikesInWindow(strikesBy.get(o.id) || [], now).length,
    approvedProductIds: approvalsBy.get(o.id) || [],
  }));
}

const OPERATOR_FIELDS = {
  legalName: "legal_name", tradingName: "trading_name", tourismLicenseNo: "tourism_license_no", etaaNo: "etaa_no",
  commercialRegistrationNo: "commercial_registration_no", taxRegistrationNo: "tax_registration_no",
  email: "email", whatsapp: "whatsapp", phone: "phone", notes: "notes", agencyId: "agency_id",
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

// Status changes an admin makes. Activating needs all four documents current.
export async function setOperatorStatus(db, id, status, { by, reason = null, now = Date.now() } = {}) {
  if (!OPERATOR_STATUSES.includes(status)) throw new CatalogueError(422, "Unknown operator status.");
  const op = await getOperator(db, id);
  if (op.status === "removed" && status !== "removed") throw new CatalogueError(409, "A removed operator can't be reinstated here; create a new operator record.");
  if (status === "active") {
    const gaps = documentGaps(await currentDocuments(db, id), todayIn(now));
    if (gaps.length) {
      throw new CatalogueError(422, `Upload a current ${gaps.map((g) => DOCUMENT_LABELS[g.kind].toLowerCase()).join(", ")} before activating.`);
    }
  }
  const r = await db.query(
    `UPDATE operators SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4, updated_at = now()
      WHERE id = $1 RETURNING *`, [id, status, reason, by]);
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
    const op = await getOperator(c, operatorId);
    let reactivated = false;
    if (op.status === "suspended" && String(op.statusReason || "").startsWith("document_expired")
        && documentGaps(await currentDocuments(c, operatorId), today).length === 0) {
      await c.query(
        `UPDATE operators SET status = 'active', status_reason = 'Reactivated: valid replacement uploaded',
                status_changed_at = now(), status_changed_by = $2, updated_at = now() WHERE id = $1`, [operatorId, by]);
      reactivated = true;
    }
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
  const expired = await db.query(
    `SELECT DISTINCT d.operator_id, d.kind, d.expires_on FROM operator_documents d JOIN operators o ON o.id = d.operator_id
      WHERE d.superseded_at IS NULL AND d.expires_on < $1 AND o.status = 'active'`, [today]);
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
    const due = await db.query(
      `SELECT d.*, o.legal_name FROM operator_documents d JOIN operators o ON o.id = d.operator_id
        WHERE d.superseded_at IS NULL AND d.expires_on = $1 AND o.status IN ('active', 'pending')`,
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
