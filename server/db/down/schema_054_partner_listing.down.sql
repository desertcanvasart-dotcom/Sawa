-- Rollback for 054. Drops the column; every agency record is shown again.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_054_partner_listing.down.sql
BEGIN;
ALTER TABLE agencies DROP COLUMN IF EXISTS public_listed;
DELETE FROM schema_migrations WHERE name = '054_partner_listing';
COMMIT;
