-- Rollback of 070. Drops each agency's registered website and the page address
-- kept with widget bookings; emails about those bookings link to sawa.tours
-- again. No booking, payment or traveler data is touched.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_070_partner_site.down.sql
BEGIN;
ALTER TABLE pledges DROP COLUMN IF EXISTS partner_page_url;
ALTER TABLE agencies DROP COLUMN IF EXISTS website;
DELETE FROM schema_migrations WHERE name = '070_partner_site';
COMMIT;
