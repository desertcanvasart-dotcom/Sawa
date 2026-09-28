// 064 — the daily EUR/EGP rate: fetch it into the Finance rate table, alert
// an admin when it fails or jumps, and (catalogue_v2 on) renew the traveler
// rate when it is due. The scheduler ticks every 6 hours; only the first tick
// of each Cairo day fetches, so a deploy or a restart never fetches twice.
// Until migration 064 is applied it does nothing.
//
//   node server/jobs/fx-daily.js      run it once
let warnedMissing = false;

export async function runFxJob({ log = console.log, now, env = process.env } = {}) {
  const { runFxDaily } = await import("../fx.js");
  const { sendEmail } = await import("../email.js");
  try {
    return await runFxDaily({ now, env, log, send: sendEmail });
  } catch (e) {
    if (e?.code !== "42P01" && e?.code !== "42703") throw e;
    if (!warnedMissing) {
      warnedMissing = true;
      log("fx: tables not found; apply migration 064 (npm run db:migrate). The exchange-rate job does nothing until then.");
    }
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import("../db/index.js");
  try {
    console.log(JSON.stringify(await runFxJob(), null, 2));
  } finally {
    await pool.end();
  }
}
