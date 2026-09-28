-- Rollback for 055. Drops the merge history (merges can no longer be
-- reverted) and the two columns: merged dates stay closed, their old links
-- stop redirecting, and a kept date's chosen operator falls back to the U01
-- rule.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_055_departure_merges.down.sql
BEGIN;
DROP TABLE IF EXISTS departure_merges;
DROP INDEX IF EXISTS idx_departures_merged_into;
ALTER TABLE departures DROP COLUMN IF EXISTS operator_agency_override;
ALTER TABLE departures DROP COLUMN IF EXISTS merged_into_id;
DELETE FROM schema_migrations WHERE name = '055_departure_merges';
COMMIT;
