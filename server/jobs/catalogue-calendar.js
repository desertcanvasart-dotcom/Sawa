// The two catalogue jobs (model phase 1), run by the scheduler:
//
//   catalogue-generate  daily: departures from the calendar rules, over a
//                       rolling window (idempotent)
//   catalogue-status    every 15 minutes: GoAhead, canceled below minimum at
//                       the cut-off or GoAhead deadline, completed; then the
//                       below-minimum cancellation notices
//
// Both are no-ops until migration 047 is applied. Neither moves money.
//
//   node server/jobs/catalogue-calendar.js           run both once
import { generateDepartures, runStatusJob, isMissingCatalogueTables } from "../catalogue.js";
import { catalogueV2Enabled } from "../features.js";

let warnedMissing = false;
async function guarded(fn, log) {
  try {
    return await fn();
  } catch (e) {
    if (!isMissingCatalogueTables(e)) throw e;
    if (!warnedMissing) {
      warnedMissing = true;
      log("catalogue: tables not found; apply migration 047 (npm run db:migrate). The catalogue jobs do nothing until then.");
    }
    return null;
  }
}

export function runCatalogueGenerate({ log = console.log, env = process.env, now } = {}) {
  return guarded(async () => {
    const out = await generateDepartures({ log, now, materialise: catalogueV2Enabled(env) });
    // Numbered departures: a date whose departures are all full gets the next one.
    if (catalogueV2Enabled(env)) {
      const { openNextForFullDates } = await import("../catalogue-departures.js");
      out.opened = await openNextForFullDates({ now, log });
    }
    return out;
  }, log);
}

// Statuses first, then the notices the cancellations owe (behind catalogue_v2),
// in the same tick so a traveler hears within a quarter of an hour.
export function runCatalogueStatus({ log = console.log, now, env = process.env } = {}) {
  return guarded(async () => {
    const statuses = await runStatusJob({ log, now });
    const { runCancellationNotices } = await import("../catalogue-notices.js");
    const notices = await runCancellationNotices({ log, now, env });
    return { ...statuses, notices };
  }, log);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import("../db/index.js");
  try {
    console.log(await runCatalogueGenerate());
    console.log(await runCatalogueStatus());
  } finally {
    await pool.end();
  }
}
