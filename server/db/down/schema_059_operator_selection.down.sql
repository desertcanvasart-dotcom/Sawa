-- Rollback for 059. Declined offers read as expired and agency offers as
-- admin offers, so the phase 2 constraints hold again; the columns go.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_059_operator_selection.down.sql
BEGIN;
ALTER TABLE catalogue_assignments DROP CONSTRAINT IF EXISTS catalogue_assignments_state_check;
ALTER TABLE catalogue_assignments DROP CONSTRAINT IF EXISTS catalogue_assignments_source_check;
UPDATE catalogue_assignments SET state = 'expired', expired_at = COALESCE(expired_at, declined_at) WHERE state = 'declined';
UPDATE catalogue_assignments SET source = 'admin' WHERE source = 'agency';
ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_state_check
  CHECK (state IN ('offered', 'acknowledged', 'expired', 'replaced'));
ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_source_check
  CHECK (source IN ('roster', 'admin'));
ALTER TABLE catalogue_assignments DROP COLUMN IF EXISTS candidate;
ALTER TABLE catalogue_assignments DROP COLUMN IF EXISTS decline_reason;
ALTER TABLE catalogue_assignments DROP COLUMN IF EXISTS declined_at;
DELETE FROM schema_migrations WHERE name = '059_operator_selection';
COMMIT;
