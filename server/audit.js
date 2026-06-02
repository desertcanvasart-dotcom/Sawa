// Best-effort audit logging: records who did what, when. Never throws —
// a failed audit write must not break the underlying action.
import { pool } from "./db/index.js";

export async function logAudit(req, { action, entity, entityId, detail }) {
  try {
    const u = req?.user || {};
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_email, actor_role, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        u.id || null,
        u.email || (req?.user ? null : "public"),
        u.role || null,
        action,
        entity || null,
        entityId != null ? String(entityId) : null,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (e) {
    console.error("audit log failed:", e.message);
  }
}
