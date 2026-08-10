// TTT2 — the watcher's own heartbeat.
//
// A daily job that stops running produces no alert, and no alert reads as no
// drift. That is the mirror's shape one level up: the monitor becomes the thing
// that fails silently, and its silence is indistinguishable from success.
//
// So every run is RECORDED, and the absence of recent runs is itself a finding.
//
// ---------------------------------------------------------------------------
// Why `audit_log` and not a new table
//
// It is already durable, already append-only (024's triggers reject UPDATE,
// DELETE and TRUNCATE), and already the place this project keeps "who did what,
// when". A monitor run is a system actor doing a thing at a time, which is the
// same shape. `server/jobs/cancel-unconfirmed.js` sets the precedent for a
// system-actor row written directly rather than through logAudit.
//
// The alternative was migration 025 — and 024 is not yet applied to production,
// so adding another would make the client's pending action larger for no gain.
//
// ---------------------------------------------------------------------------
// TTT2.3 — THE LIMITATION, STATED
//
// A monitor running inside the process it monitors cannot report that the
// process is gone. If the web process dies, nothing here fires and nothing here
// says so. Railway's healthcheck covers uptime, which is why the gap is
// acceptable — but "no drift reported" is evidence only while the watcher is
// known to be running. Recorded as E-12 in docs/audit/evidence-expiry.md.
export const WATCH_ACTION = "audit.watch";

// Two missed daily runs. One missed run is a restart, a deploy, or a slow
// night; two is a pattern. Deliberately not 24h — a 24h threshold fires on every
// ordinary deploy that happens to land near the tick, and an alert that fires
// when nothing is wrong stops being an alert (TTT1).
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export async function recordWatchRun(client, { routes, findings, regressed, degraded, base }) {
  await client.query(
    `INSERT INTO audit_log (actor_email, actor_role, action, entity, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    ["system@sawa.tours", "system", WATCH_ACTION, "site", base || null,
      JSON.stringify({ routes, findings, regressed: !!regressed, degraded: degraded || null })]
  );
}

// What /api/modes reports. Deliberately shaped like effect-log's report: a
// TIMESTAMP rather than a boolean, so "never" and "not since Tuesday" stay
// distinguishable — the ZZ2 lesson, applied to the monitor.
export function watchdogReport(lastRunAt, now = Date.now()) {
  if (!lastRunAt) {
    return { lastRun: null, ageHours: null, stale: true, neverRun: true };
  }
  const at = new Date(lastRunAt).getTime();
  const ageMs = now - at;
  return {
    lastRun: new Date(at).toISOString(),
    ageHours: Math.round((ageMs / 3_600_000) * 10) / 10,
    // TTT2.2 — staleness IS a finding, not a caveat on one.
    stale: ageMs > STALE_AFTER_MS,
    neverRun: false,
  };
}

export async function lastWatchRunAt(pool) {
  const r = await pool.query(
    `SELECT max(created_at) AS at FROM audit_log WHERE action = $1`, [WATCH_ACTION]
  );
  return r.rows[0]?.at || null;
}
