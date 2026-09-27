-- Rollback for 049 (operators, roster, rate card, assignment, manifest).
--
-- Drops what 049 created and restores app_users' original role checks.
-- Operator logins are removed first: those app_users rows can't exist under
-- the original checks. (Their Supabase auth users remain and can't sign in to
-- anything; delete them in Supabase if this rollback is permanent.)
-- Bookings keep the three new optional columns' values only until the DROP.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_049_operators_roster_rates.down.sql
BEGIN;
DROP TRIGGER IF EXISTS trg_catalogue_lock_on_first_seat ON pledges;
DROP FUNCTION IF EXISTS catalogue_lock_on_first_seat();
ALTER TABLE pledges DROP COLUMN IF EXISTS pickup_point;
ALTER TABLE pledges DROP COLUMN IF EXISTS nationality;
ALTER TABLE pledges DROP COLUMN IF EXISTS safety_needs;
DROP TABLE IF EXISTS manifest_access_log;
DROP TABLE IF EXISTS catalogue_manifests;
DROP TABLE IF EXISTS catalogue_admin_alerts;
ALTER TABLE operator_strikes DROP CONSTRAINT IF EXISTS operator_strikes_assignment_fk;
DROP TABLE IF EXISTS catalogue_assignments;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS rate_version_id;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS rate_locked_at;
ALTER TABLE catalogue_products DROP COLUMN IF EXISTS needs_nationality;
DROP TRIGGER IF EXISTS trg_catalogue_rate_immutable ON catalogue_rate_versions;
DROP TABLE IF EXISTS catalogue_rate_versions;
DROP FUNCTION IF EXISTS catalogue_rate_immutable();
DROP TABLE IF EXISTS roster_swaps;
DROP TABLE IF EXISTS roster_entries;
DROP TABLE IF EXISTS roster_plan_lines;
DROP TABLE IF EXISTS roster_months;
DROP TABLE IF EXISTS operator_notifications;
DROP TABLE IF EXISTS operator_strikes;
DELETE FROM app_users WHERE role IN ('operator_owner', 'operator_staff');
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS agency_required_for_agency_roles;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users DROP COLUMN IF EXISTS operator_id;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('super_admin','ops_staff','agency_owner','agency_agent'));
ALTER TABLE app_users ADD CONSTRAINT agency_required_for_agency_roles CHECK (
  (role IN ('super_admin','ops_staff') AND agency_id IS NULL)
  OR (role IN ('agency_owner','agency_agent') AND agency_id IS NOT NULL));
DROP TABLE IF EXISTS operator_product_approvals;
DROP TABLE IF EXISTS operator_document_reminders;
DROP TABLE IF EXISTS operator_documents;
DROP TABLE IF EXISTS operators;
DELETE FROM schema_migrations WHERE name = '049_operators_roster_rates';
COMMIT;
