-- Rollback of 071. Drops the campaign labels kept with bookings; reports by
-- campaign stop working. No booking, payment or traveler data is touched.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_071_campaign_attribution.down.sql
BEGIN;
ALTER TABLE pledges DROP COLUMN IF EXISTS utm_campaign;
ALTER TABLE pledges DROP COLUMN IF EXISTS utm_medium;
ALTER TABLE pledges DROP COLUMN IF EXISTS utm_source;
DELETE FROM schema_migrations WHERE name = '071_campaign_attribution';
COMMIT;
