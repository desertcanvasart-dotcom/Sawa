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

export function startJobScheduler(env = process.env) {
  if (!jobSchedulerEnabled(env)) {
    console.log("[jobs] scheduler off (set ENABLE_JOB_SCHEDULER=1 to run it outside production)");
    return null;
  }

  const tick = () => runSafely("cancel-unconfirmed", async (opts) => {
    const { runCancelUnconfirmed } = await import("./cancel-unconfirmed.js");
    return runCancelUnconfirmed(opts);
  });

  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  const repeat = setInterval(tick, DAY_MS);
  // unref so neither timer holds the process open during a shutdown. Drift is
  // irrelevant for a rule measured in whole days.
  first.unref();
  repeat.unref();

  console.log(`[jobs] scheduler on — cancel-unconfirmed in ${FIRST_RUN_DELAY_MS / 1000}s, then every 24h`);
  return () => { clearTimeout(first); clearInterval(repeat); };
}
