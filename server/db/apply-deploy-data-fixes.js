// Apply only the small, explicitly deploy-safe catalogue repair needed by the
// current release. Full schema migrations remain a manual production action:
// this is not a replacement for `npm run db:migrate`.
//
// The migration is create-only and recorded under the same name used by the
// normal runner. A transaction-scoped advisory lock makes overlapping Railway
// deployments harmless, and the marker makes every later boot a read-only no-op.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAME = "041_restore_cairo_luxor_package";
const FILE = "schema_041_restore_cairo_luxor_package.sql";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [NAME]);
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1",
    [NAME]
  );
  if (!applied.rows.length) {
    await client.query(await readFile(join(__dirname, FILE), "utf8"));
    await client.query(
      "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [NAME]
    );
    console.log(`Applied deploy data fix: ${NAME}`);
  } else {
    console.log(`Deploy data fix already applied: ${NAME}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Deploy data fix failed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
