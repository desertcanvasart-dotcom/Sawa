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
  { name: "035_licence_year_not_expiry", file: "schema_035_licence_year_not_expiry.sql" },
  { name: "036_no_founding_partner", file: "schema_036_no_founding_partner.sql" },
  { name: "037_request_window", file: "schema_037_request_window.sql" },
  { name: "038_cutoff_unit", file: "schema_038_cutoff_unit.sql" },
  { name: "039_drop_decorative_cutoff", file: "schema_039_drop_decorative_cutoff.sql" },
  { name: "040_cover_alt_caption", file: "schema_040_cover_alt_caption.sql" },
  { name: "041_restore_cairo_luxor_package", file: "schema_041_restore_cairo_luxor_package.sql" },
  { name: "042_email_outbox", file: "schema_042_email_outbox.sql" },
  { name: "043_booking_payments", file: "schema_043_booking_payments.sql" },
  { name: "044_settlements", file: "schema_044_settlements.sql" },
  { name: "045_cost_basis", file: "schema_045_cost_basis.sql" },
  { name: "046_extra_income", file: "schema_046_extra_income.sql" },
  { name: "047_catalogue_calendar", file: "schema_047_catalogue_calendar.sql" },
  { name: "048_catalogue_notices", file: "schema_048_catalogue_notices.sql" },
  { name: "049_operators_roster_rates", file: "schema_049_operators_roster_rates.sql" },
  { name: "050_settlements_commissions", file: "schema_050_settlements_commissions.sql" },
  { name: "051_pay_at_goahead", file: "schema_051_pay_at_goahead.sql" },
  { name: "052_pay_safeguards_terms", file: "schema_052_pay_safeguards_terms.sql" },
  { name: "053_seller_disclosure", file: "schema_053_seller_disclosure.sql" },
  { name: "054_partner_listing", file: "schema_054_partner_listing.sql" },
  { name: "055_departure_merges", file: "schema_055_departure_merges.sql" },
  { name: "056_booking_parties", file: "schema_056_booking_parties.sql" },
  { name: "057_booking_integrity", file: "schema_057_booking_integrity.sql" },
  { name: "058_booking_confirmations", file: "schema_058_booking_confirmations.sql" },
  { name: "059_operator_selection", file: "schema_059_operator_selection.sql" },
  { name: "060_date_request_confirmation", file: "schema_060_date_request_confirmation.sql" },
  { name: "061_pool_model", file: "schema_061_pool_model.sql" },
  { name: "062_groups_of_eight", file: "schema_062_groups_of_eight.sql" },
  { name: "063_numbered_departures", file: "schema_063_numbered_departures.sql" },
  { name: "064_automatic_fx", file: "schema_064_automatic_fx.sql" },
  { name: "065_exchange_mode_eur_prices", file: "schema_065_exchange_mode_eur_prices.sql" },
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
