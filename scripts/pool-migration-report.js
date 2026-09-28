// What migration 061 converted: every rate version, with the notes the
// conversion left on it (shared/pool-model.js convertLegacyRate is the same
// rule). Read-only: runs on the audit tooling's read-only connection.
//
//   DATABASE_URL=<production> node scripts/pool-migration-report.js
import { fileURLToPath } from "node:url";
import { migrationReportLines } from "../server/rates.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { readOnlyPool } = await import("../server/db/readonly.js");
  const pool = readOnlyPool();
  try {
    const rows = (await pool.query(
      `SELECT c.catalogue_no, c.code, v.version, v.state, v.cost_lines, v.source
         FROM catalogue_rate_versions v JOIN catalogue_products c ON c.id = v.product_id
        ORDER BY c.catalogue_no, v.version`)).rows;
    for (const l of migrationReportLines(rows)) console.log(l);
  } finally {
    await pool.end();
  }
}
