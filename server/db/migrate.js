// Applies all schema migrations in order. Each schema file is idempotent
// (IF NOT EXISTS guards), so this is safe to run repeatedly.
// Run: npm run db:migrate
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  { name: "001_initial_schema", file: "schema.sql" },
  { name: "002_auth", file: "schema_002_auth.sql" },
  { name: "003_ops", file: "schema_003_ops.sql" },
  { name: "004_pledge_email", file: "schema_004_pledge_email.sql" },
  { name: "005_tour_status", file: "schema_005_tour_status.sql" },
  { name: "006_tour_rich", file: "schema_006_tour_rich.sql" },
  { name: "007_booking_lifecycle", file: "schema_007_booking_lifecycle.sql" },
  { name: "008_meeting_points", file: "schema_008_meeting_points.sql" },
  { name: "009_destinations", file: "schema_009_destinations.sql" },
  { name: "010_blog", file: "schema_010_blog.sql" },
];

async function main() {
  for (const m of MIGRATIONS) {
    const sql = await readFile(join(__dirname, m.file), "utf8");
    await pool.query(sql);
    await pool.query(
      `INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [m.name]
    );
    console.log(`Applied: ${m.name}`);
  }
  console.log("All migrations up to date.");
  await pool.end();
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
