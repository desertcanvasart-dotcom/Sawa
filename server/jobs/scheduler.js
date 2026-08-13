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
// TTT3.2 — PP2 discipline on the alert itself. An alert that does not arrive is
// worse than no alerting, because it is trusted. Intended sends are counted,
// the outcome is asserted, and a shortfall is loud.
async function alert(log, { base, lines, stale }) {
  const { sendEmail, auditDriftEmail } = await import("../email.js");
  const { reportNotifications } = await import("../departure-cancel.js");
  const { rethrowIfProgrammerError } = await import("../errors.js");
  const to = process.env.AUDIT_ALERT_TO || process.env.EMAIL_REPLY_TO || (await import("../brand.js")).BRAND.email;

  const sent = await sendEmail(auditDriftEmail({ to, base, lines, stale }))
    .then((r) => (r?.ok ? 1 : 0))
    .catch((e) => { rethrowIfProgrammerError(e); return 0; });

  reportNotifications({
    intended: 1, sent, context: `claims-audit alert to ${to}`,
    log: (l) => log(l), error: (l) => console.error(`[job:audit-watch] ${l}`),
  });
}

// DIR-20 — DRY by default, for BB3's reason, and one more.
//
// cancel-unconfirmed is dry by default because a mistake cancels real
// departures. This one cannot cancel anything — but it emails, and an
// accidental first live tick would alert ops about EVERY departure ever
// confirmed, in one burst. The queue is derived from history, so the backlog on
// first run is the whole history.
//
// Go live by setting GOAHEAD_ALERT_DRY_RUN=0 once the recipient is agreed.
const HOUR_MS = 60 * 60 * 1000;

export function goAheadAlertDryRun(env = process.env) {
  return env.GOAHEAD_ALERT_DRY_RUN !== "0";
}

// Its own switch. The alert emails ops; this emails CUSTOMERS, and its first
// live tick would reach every traveller who ever booked a departure that
// confirmed — including people whose trip has already been and gone, because
// the queue is derived from history rather than from a cursor.
//
// Go live by setting GOAHEAD_NOTIFY_DRY_RUN=0, after reading the dry-run
// backlog. notify-goahead.js carries the SQL to backfill the marker if the
// history should be treated as already told.
export function goAheadNotifyDryRun(env = process.env) {
  return env.GOAHEAD_NOTIFY_DRY_RUN !== "0";
}

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
    const { rethrowIfProgrammerError } = await import("../errors.js");
    const r = await runAuditWatch({ base: auditWatchBase(env) });

    // The site not answering is an AVAILABILITY problem, not a claims
    // regression. A throttled or unreachable run returns a mass of
    // `fetch-failed` and a collapsed route count, and reporting that as
    // "27 findings appeared" is a false alarm of exactly the kind TTT1 says
    // kills a signal. Observed on the first live tick: 40 routes -> 23 with 27
    // fetch-failed, while the site was in fact serving 200s throughout.
    const unreachable = (r.current.findings["fetch-failed"] || 0);
    if (unreachable >= 5) {
      log(`SITE DID NOT ANSWER — ${unreachable} routes failed to fetch. This is availability, not drift; the claims were never read.`);
    }

    // PPP1.2 — reported whether or not it fails. A new route is information.
    if (r.routeChange) log(`ROUTE COUNT ${r.routeChange.was} -> ${r.routeChange.now} — production data moved with no deploy behind it`);
    for (const d of r.drift) log(`${d.now > d.was ? "WORSE" : "better"} ${d.rule}: ${d.was} -> ${d.now}`);

    // TTT2.1 — every run is recorded, durably. A daily job that stops running
    // produces no alert, and no alert reads as no drift.
    const { pool } = await import("../db/index.js");
    const { recordWatchRun } = await import("../watchdog.js");
    await recordWatchRun(pool, {
      routes: r.current.routes, findings: r.all.length,
      regressed: r.regressed, degraded: r.degraded, base: auditWatchBase(env),
    });

    // VVV1.2 — an unapplied migration is drift with no deploy behind it, which
    // is exactly what this job exists to see. CI can never answer it — it has no
    // production credentials and should not pretend to — but this already holds
    // read-only production access and runs daily.
    //
    // Reported at FINDINGS severity, not route-count severity: a migration that
    // has not been applied is a failure, not a change. It does not resolve
    // itself and every hour it stays open is an hour the schema the code
    // expects is not the schema that exists.
    // EEEE3.1 — four claims end the instant `pledges` stops being empty, and
    // nothing in the repository would notice. A preflight step only helps
    // someone who runs preflight; the seed will be run by the client, against
    // production, on a day nobody is watching. This tick is.
    //
    // Read-only: it counts rows and reads files. It cannot end E-2 itself.
    try {
      const { verdict: seedVerdict, auditRestatements } = await import("../../scripts/check-seed-expiry.js");
      const { readOnlyPool, readOnlyUrl } = await import("../db/readonly.js");
      if (readOnlyUrl(env)) {
        const p = readOnlyPool(env);
        let n = null;
        try { n = (await p.query("SELECT count(*)::int n FROM pledges")).rows[0].n; }
        finally { await p.end(); }
        const v = seedVerdict({ pledgeCount: n, restatements: auditRestatements() });
        if (!v.pass) log(v.line);
      }
    } catch (e) {
      rethrowIfProgrammerError(e);
      // Unable to ask is not "empty". Reported, never swallowed.
      log(`SEED EXPIRY: could not be checked — ${e.message.split("\n")[0]}`);
    }

    let schema = null;
    let schemaState = "not-checked";
    try {
      const { checkAppliedSchema, verdict } = await import("../../scripts/check-applied-schema.js");
      const { readOnlyUrl, readOnlyPool } = await import("../db/readonly.js");
      const url = readOnlyUrl(env);
      const result = await checkAppliedSchema({
        url,
        env,
        connect: async (u) => {
          const p = readOnlyPool({ ...env, DATABASE_URL: u });
          try { return (await p.query("SELECT name FROM schema_migrations")).rows.map((x) => x.name); }
          finally { await p.end(); }
        },
      });
      // THREE states. `verdict` passes when there are no credentials, by
      // design — the check must not block local work. But "passed because it
      // could not run" is not "applied", and the first version of this reported
      // schema: "applied" for a run that never opened a connection. That is the
      // exact collapse this project keeps finding in other people's code.
      if (!url) {
        schemaState = "not-checked";
      } else {
        const v = verdict(result, { hasCredentials: true });
        schemaState = v.pass ? "applied" : "not-applied";
        if (!v.pass) schema = v.line;
      }
    } catch (e) {
      rethrowIfProgrammerError(e);
      // Unable to say is not "applied". Third state, same argument as
      // no-auth-provider and the watchdog's stale: null.
      schemaState = "unavailable";
      schema = `could not check the applied schema — ${e.message}`;
    }
    if (schema) log(schema);

    if (r.regressed || r.degraded || schema) {
      const lines = r.drift.filter((d) => d.now > d.was).map((d) => `${d.rule}: ${d.was} -> ${d.now}`);
      if (r.degraded) lines.push(`coverage degraded — ${r.degraded}`);
      if (schema) lines.push(schema);
      recordFailure("claimsAudit", lines.join(", "));
      await alert(log, { base: auditWatchBase(env), lines });
    } else {
      recordSuccess("claimsAudit");
      // TTT3.3 — nothing is sent on green.
    }
    return { routes: r.current.routes, findings: r.all.length, regressed: r.regressed, schema: schemaState };
  });

  // DIR-20 — the third tick. Hourly rather than daily: a confirmed departure
  // waiting a day for its payment link is a day of a traveller wondering
  // whether anything happened. Offset from the other two so the three never
  // contend for the pooler's 15-connection limit.
  const goAheadDry = goAheadAlertDryRun(env);
  const alertTick = () => runSafely("goahead-alert", async (opts) => {
    const { runGoAheadAlerts } = await import("./alert-goahead.js");
    return runGoAheadAlerts({ ...opts, dryRun: goAheadDry });
  });

  // The fourth tick — the traveller half of the same moment. Hourly for the
  // same reason and offset again, so all four never contend for the pooler.
  //
  // Its own dry-run switch, not the alert's: one emails ops and the other emails
  // customers, and a single flag would mean going live with the internal prompt
  // silently goes live with the customer mail too.
  const noticeDry = goAheadNotifyDryRun(env);
  const noticeTick = () => runSafely("goahead-notify", async (opts) => {
    const { runGoAheadNotices } = await import("./notify-goahead.js");
    return runGoAheadNotices({ ...opts, dryRun: noticeDry });
  });

  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  const repeat = setInterval(tick, DAY_MS);
  const auditFirst = setTimeout(auditTick, FIRST_RUN_DELAY_MS * 5);
  const auditRepeat = setInterval(auditTick, DAY_MS);
  const alertFirst = setTimeout(alertTick, FIRST_RUN_DELAY_MS * 9);
  const alertRepeat = setInterval(alertTick, HOUR_MS);
  const noticeFirst = setTimeout(noticeTick, FIRST_RUN_DELAY_MS * 13);
  const noticeRepeat = setInterval(noticeTick, HOUR_MS);
  // unref so neither timer holds the process open during a shutdown. Drift is
  // irrelevant for a rule measured in whole days.
  first.unref();
  repeat.unref();
  auditFirst.unref();
  auditRepeat.unref();
  alertFirst.unref();
  alertRepeat.unref();
  noticeFirst.unref();
  noticeRepeat.unref();

  console.log(`[jobs] scheduler on — cancel-unconfirmed in ${FIRST_RUN_DELAY_MS / 1000}s, then every 24h`);
  console.log(dryRun
    ? "[jobs] cancel-unconfirmed is DRY-RUN — it will log what it would cancel and email, and do neither. Set CANCEL_JOB_DRY_RUN=0 to go live."
    : "[jobs] cancel-unconfirmed is LIVE — it will cancel departures and email travellers.");
  console.log(`[jobs] audit-watch in ${(FIRST_RUN_DELAY_MS * 5) / 1000}s, then every 24h, against ${auditWatchBase(env)} — read-only, writes nothing`);
  console.log(goAheadDry
    ? "[jobs] goahead-alert is DRY-RUN — it will log which confirmed departures need a payment link and email nobody. Set GOAHEAD_ALERT_DRY_RUN=0 to go live."
    : `[jobs] goahead-alert is LIVE — hourly, to ${env.GOAHEAD_ALERT_TO || "hello@sawa.tours"}.`);
  console.log(noticeDry
    ? "[jobs] goahead-notify is DRY-RUN — it will log which travellers would be told their date is confirmed and email nobody. "
      + "The booking confirmation promises this email. Set GOAHEAD_NOTIFY_DRY_RUN=0 to go live, after checking the dry-run backlog."
    : "[jobs] goahead-notify is LIVE — hourly, to the travellers on each confirmed departure.");
  return () => {
    clearTimeout(first); clearInterval(repeat);
    clearTimeout(auditFirst); clearInterval(auditRepeat);
    clearTimeout(alertFirst); clearInterval(alertRepeat);
    clearTimeout(noticeFirst); clearInterval(noticeRepeat);
  };
}
