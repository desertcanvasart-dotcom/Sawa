-- Rollback of 067. Reactivate any inactive agency first if you are also
-- rolling back the code, which doesn't know the value.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_067_agency_status.down.sql
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_status_check;
DELETE FROM schema_migrations WHERE name = '067_agency_status';
