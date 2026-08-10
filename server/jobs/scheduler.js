// In-process scheduling for the background jobs.
//
// Running a job inside the web process is usually the wrong shape — job health
// gets tied to web health, and every instance runs its own copy. It is the
// right shape here for two specific reasons:
//
//   1. There is one job, it runs daily, and it takes milliseconds against a
//      catalogue of this size.
//   2. cancel-unconfirmed is idempotent and concurrency-safe by construction:
//      each departure is re-read FOR UPDATE inside its own transaction and
//      re-checked against the rule, so running it twice — or from two
//      instances at once — cancels nothing extra.
//
// The alternative is a second Railway service with its own cron schedule and
// its own copy of every environment variable. That is more correct in the
// abstract and more to keep working in practice.
//
// The job module is imported lazily, inside the tick. Loading it eagerly would
// pull the database pool into this module's graph, so merely asking "is the
// scheduler enabled?" would need a DATABASE_URL — which is exactly what the
// tests have to ask without one.

const DAY_MS = 24 * 60 * 60 * 1000;

// Not on boot: a deploy would run it while the app is still warming, and a
// crash-loop would run it on every restart. A minute in, the process is either
// healthy or gone. The override exists so a test can watch a real tick without
// waiting a minute for it.
const FIRST_RUN_DELAY_MS = Number(process.env.JOB_FIRST_RUN_DELAY_MS || 60 * 1000);

// Off unless this is production, or someone deliberately turns it on.
//
// The failure this prevents: a developer running the API locally with
// DATABASE_URL pointed at production — which is exactly how the migrations and
// the dry runs get done — would otherwise silently cancel live departures from
// their laptop.
export function jobSchedulerEnabled(env = process.env) {
  if (env.DISABLE_JOB_SCHEDULER === "1") return false;
  return env.NODE_ENV === "production" || env.ENABLE_JOB_SCHEDULER === "1";
}

// BB3 — the scheduled run is DRY BY DEFAULT.
//
// This is the only code path that emails a traveller without a human action,
// and production is confirmed running it: /api/modes reports scheduler: on with
// email: live. A departure that misses its deadline is cancelled and everyone
// on it is emailed — copy that currently describes a refund which cannot occur,
// because no payment is ever taken.
//
// So the default is inverted from the usual. Going live is an explicit act:
//
//   CANCEL_JOB_DRY_RUN=0   the job cancels and emails
//   anything else          it logs exactly what it WOULD do, and does neither
//
// Chosen this way round because the failure modes are not symmetric. A dry run
// that should have been live leaves stale departures on the board, visible and
// fixable. A live run that should have been dry sends mail to real people, and
// that cannot be taken back.
//
// The manual path is unchanged: `DRY_RUN=1 npm run job:cancel-unconfirmed` still
// works, and a human running it without that flag still gets a live run. This
// governs the unattended, scheduled tick only.
//
// Revert to live when the cancellation copy is settled (AA3) and seeded data has
// been through at least one tick.
export function cancelJobDryRun(env = process.env) {
  return env.CANCEL_JOB_DRY_RUN !== "0";
}

async function runSafely(name, fn) {
  const started = Date.now();
  try {
    const result = await fn({ log: (line) => console.log(`[job:${name}] ${line}`) });
    console.log(`[job:${name}] done in ${Date.now() - started}ms`, result ? JSON.stringify(result) : "");
  } catch (e) {
    // A failing job must never take the website down with it. It will be
    // retried on the next tick.
    console.error(`[job:${name}] failed after ${Date.now() - started}ms:`, e.message);
  }
}

// PPP1.1 — where the scheduled audit points. Its own origin in production.
export function auditWatchBase(env = process.env) {
  return (env.AUDIT_WATCH_BASE || env.APP_URL || "https://sawa.tours").replace(/\/$/, "");
}

export function startJobScheduler(env = process.env) {
  if (!jobSchedulerEnabled(env)) {
    console.log("[jobs] scheduler off (set ENABLE_JOB_SCHEDULER=1 to run it outside production)");
    return null;
  }

  const dryRun = cancelJobDryRun(env);
  const tick = () => runSafely("cancel-unconfirmed", async (opts) => {
    const { runCancelUnconfirmed } = await import("./cancel-unconfirmed.js");
    return runCancelUnconfirmed({ ...opts, dryRun });
  });

  // PPP1.1 — the second job, and the header above argues for one.
  //
  // Both conditions that made in-process right for cancel-unconfirmed hold here,
  // and one holds more strongly: THIS JOB WRITES NOTHING. It runs on the
  // read-only pool (X1), which raises 25006 on any write whatever the
  // credentials permit — so the worst a bug in it can do is report a wrong
  // number. cancel-unconfirmed can cancel a departure.
  //
  // What it does cost, stated because it weakens the header's first condition:
  // seconds rather than milliseconds. It fetches every public route from this
  // process. Deliberately offset from the cancel tick so the two never contend
  // for the pooler's connection limit, which is 15 in session mode and has
  // already produced a spurious db-error once.
  const auditTick = () => runSafely("audit-watch", async ({ log }) => {
    const { runAuditWatch } = await import("../../scripts/audit-watch.js");
    const { recordSuccess, recordFailure } = await import("../effect-log.js");
    const r = await runAuditWatch({ base: auditWatchBase(env) });

    // PPP1.2 — reported whether or not it fails. A new route is information.
    if (r.routeChange) log(`ROUTE COUNT ${r.routeChange.was} -> ${r.routeChange.now} — production data moved with no deploy behind it`);
    for (const d of r.drift) log(`${d.now > d.was ? "WORSE" : "better"} ${d.rule}: ${d.was} -> ${d.now}`);

    if (r.regressed || r.degraded) {
      recordFailure("claimsAudit", r.degraded
        || `finding(s) appeared with no deploy: ${r.drift.filter((d) => d.now > d.was).map((d) => `${d.rule} ${d.was}->${d.now}`).join(", ")}`);
    } else {
      recordSuccess("claimsAudit");
    }
    return { routes: r.current.routes, findings: r.all.length, regressed: r.regressed };
  });

  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  const repeat = setInterval(tick, DAY_MS);
  const auditFirst = setTimeout(auditTick, FIRST_RUN_DELAY_MS * 5);
  const auditRepeat = setInterval(auditTick, DAY_MS);
  // unref so neither timer holds the process open during a shutdown. Drift is
  // irrelevant for a rule measured in whole days.
  first.unref();
  repeat.unref();
  auditFirst.unref();
  auditRepeat.unref();

  console.log(`[jobs] scheduler on — cancel-unconfirmed in ${FIRST_RUN_DELAY_MS / 1000}s, then every 24h`);
  console.log(dryRun
    ? "[jobs] cancel-unconfirmed is DRY-RUN — it will log what it would cancel and email, and do neither. Set CANCEL_JOB_DRY_RUN=0 to go live."
    : "[jobs] cancel-unconfirmed is LIVE — it will cancel departures and email travellers.");
  console.log(`[jobs] audit-watch in ${(FIRST_RUN_DELAY_MS * 5) / 1000}s, then every 24h, against ${auditWatchBase(env)} — read-only, writes nothing`);
  return () => {
    clearTimeout(first); clearInterval(repeat);
    clearTimeout(auditFirst); clearInterval(auditRepeat);
  };
}
