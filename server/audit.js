// Best-effort audit logging: records who did what, when. Never throws —
// a failed audit write must not break the underlying action.
//
// DIR-1.3 — "best effort" was doing a second job it was never given.
//
// The catch below was written so a failed audit does not break a booking, which
// is right. What it also did was make a failed audit indistinguishable from one
// that never happened: a `console.error` in a stream nobody reads, no count, and
// nothing in /api/modes. An audit trail is only worth anything if you can tell
// whether it is complete, and this is the one place that could say so.
//
// Recorded and counted now. It still does not throw.
import { pool } from "./db/index.js";
import { recordSuccess, recordFailure } from "./effect-log.js";
import { rethrowIfProgrammerError } from "./errors.js";

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
    recordSuccess("audit");
  } catch (e) {
    rethrowIfProgrammerError(e);
    // The action is named, because "an audit write failed" and "the record of
    // who revoked an account is missing" are the same event described at two
    // different levels of usefulness.
    recordFailure("audit", `${action} on ${entity || "?"}:${entityId ?? "?"} was NOT recorded — ${e.message}`);
  }
}
