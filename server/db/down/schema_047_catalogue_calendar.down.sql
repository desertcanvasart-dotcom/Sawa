-- Rollback for 047 (catalogue and departure calendar).
--
-- Drops only what 047 created. No existing table or row is touched:
-- departures and pledges created for catalogue departures are ordinary
-- rows in the existing booking tables and stay where they are.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_047_catalogue_calendar.down.sql
BEGIN;
DROP VIEW IF EXISTS catalogue_departure_seats;
DROP TABLE IF EXISTS catalogue_events;
DROP TABLE IF EXISTS catalogue_departures;
DROP TABLE IF EXISTS catalogue_calendar_rules;
DROP TRIGGER IF EXISTS trg_catalogue_spec_immutable ON catalogue_spec_versions;
DROP TABLE IF EXISTS catalogue_spec_versions;
DROP FUNCTION IF EXISTS catalogue_spec_immutable();
DROP TABLE IF EXISTS catalogue_products;
DELETE FROM schema_migrations WHERE name = '047_catalogue_calendar';
COMMIT;
