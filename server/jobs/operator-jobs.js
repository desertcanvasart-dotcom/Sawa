// The model phase 2 jobs, run by the scheduler, all behind catalogue_v2:
//
//   operator-assignments  every 15 minutes, after the catalogue status job:
//                         pay at GoAhead (phase 4: requests, reminders,
//                         releases, waitlist offers), then lock rates, freeze
//                         manifests at the cut-off, offer
//                         GoAhead departures to the rostered operator, expire
//                         missed acknowledgements (strike + admin alert)
//   operator-daily        daily: document expiry (suspend, 30- and 7-day
//                         reminders), manifest access 90 days after the trip,
//                         booking-detail requests and commission statements
//                         (phase 3), reservation signals deleted at 30 days
//
// With the flag off they do nothing. Until migration 049 is applied they do
// nothing either. None of them moves money.
//
//   node server/jobs/operator-jobs.js           run both once
import { catalogueV2Enabled } from "../features.js";
import { isMissingOperatorTables } from "../operators.js";

let warnedMissing = false;
async function guarded(fn, log, env) {
  if (!catalogueV2Enabled(env)) return { skipped: "catalogue_v2 is off" };
  try {
    return await fn();
  } catch (e) {
    if (!isMissingOperatorTables(e)) throw e;
    if (!warnedMissing) {
      warnedMissing = true;
      log("operators: tables not found; apply migration 049 (npm run db:migrate). The operator jobs do nothing until then.");
    }
    return null;
  }
}

export function runOperatorAssignments({ log = console.log, now, env = process.env } = {}) {
  return guarded(async () => {
    const { runAssignmentTick } = await import("../assignments.js");
    const { runSettlementTick } = await import("../operator-settlement.js");
    const { decideCommissions } = await import("../commissions.js");
    const { sendEmail } = await import("../email.js");
    // Model phase 4 first: payment requests at GoAhead, reminders, warnings
    // and releases at the deadline, so a manifest frozen in the same tick
    // holds manifest seats only (clause 10.1).
    const { runPayAtGoAheadTick } = await import("../pay-at-goahead.js");
    const payAtGoAhead = await runPayAtGoAheadTick({ log, now, send: sendEmail, env });
    const assignments = await runAssignmentTick({ log, now, send: sendEmail });
    // Model phase 3: advances priced, balances and statements after the
    // departure, statements accepted at 30 days, commissions decided.
    const settlement = await runSettlementTick({ log, now });
    const commissions = await decideCommissions({ log, now });
    return { payAtGoAhead, ...assignments, ...settlement, ...commissions };
  }, log, env);
}

export function runOperatorDaily({ log = console.log, now, env = process.env } = {}) {
  return guarded(async () => {
    const { runDocumentJob } = await import("../operators.js");
    const { revokeExpiredManifestAccess } = await import("../assignments.js");
    const { sendEmail, opsRecipient } = await import("../email.js");
    const { runCompletionRequests } = await import("../booking-details.js");
    const { runCommissionStatements } = await import("../commissions.js");
    const documents = await runDocumentJob({ log, now, send: sendEmail, adminEmail: opsRecipient() });
    const manifests = await revokeExpiredManifestAccess({ now });
    // Model phase 3: booking-detail requests (7 and 3 days before) and the
    // monthly commission statements (by the 10th).
    const details = await runCompletionRequests({ log, now, send: sendEmail, env });
    const statements = await runCommissionStatements({ log, now, send: sendEmail, env });
    // Reservation integrity: signals are kept 30 days.
    const { purgeSignals } = await import("../booking-integrity.js");
    const signals = await purgeSignals({ now });
    return { ...documents, ...manifests, details, statements, ...signals };
  }, log, env);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pool } = await import("../db/index.js");
  try {
    console.log(await runOperatorAssignments());
    console.log(await runOperatorDaily());
  } finally {
    await pool.end();
  }
}
