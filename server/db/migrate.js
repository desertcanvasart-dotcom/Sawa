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
  { name: "011_referrals", file: "schema_011_referrals.sql" },
  { name: "012_referral_agency", file: "schema_012_referral_agency.sql" },
  { name: "013_tour_approval", file: "schema_013_tour_approval.sql" },
  { name: "014_traveler_requests", file: "schema_014_traveler_requests.sql" },
  { name: "015_operating_days", file: "schema_015_operating_days.sql" },
  { name: "016_booking_code_unique", file: "schema_016_booking_code_unique.sql" },
  { name: "017_operator_applications", file: "schema_017_operator_applications.sql" },
  { name: "018_tour_products_updated_at", file: "schema_018_tour_products_updated_at.sql" },
  { name: "019_confirm_deadline", file: "schema_019_confirm_deadline.sql" },
  { name: "020_price_tiers", file: "schema_020_price_tiers.sql" },
  { name: "021_max_group_size", file: "schema_021_max_group_size.sql" },
  { name: "022_min_group_size", file: "schema_022_min_group_size.sql" },
  { name: "023_write_time_capture", file: "schema_023_write_time_capture.sql" },
  { name: "024_lock_down_data_api", file: "schema_024_lock_down_data_api.sql" },
  { name: "025_agency_verification", file: "schema_025_agency_verification.sql" },
  { name: "026_route_alerts", file: "schema_026_route_alerts.sql" },
  { name: "027_pin_group_minimum", file: "schema_027_pin_group_minimum.sql" },
  { name: "028_payment_window", file: "schema_028_payment_window.sql" },
  { name: "029_agency_relationship", file: "schema_029_agency_relationship.sql" },
  { name: "030_pledges_paid", file: "schema_030_pledges_paid.sql" },
  { name: "031_package_deposit_25", file: "schema_031_package_deposit_25.sql" },
  { name: "032_minya_is_a_day_tour", file: "schema_032_minya_is_a_day_tour.sql" },
  { name: "033_hotel_tier_names", file: "schema_033_hotel_tier_names.sql" },
  { name: "034_five_star_cruiser", file: "schema_034_five_star_cruiser.sql" },
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
