-- Rollback for 057. Drops the GoAhead seat view, the flags and the signals.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_057_booking_integrity.down.sql
BEGIN;
DROP VIEW IF EXISTS catalogue_departure_goahead;
DROP TABLE IF EXISTS booking_flags;
DROP TABLE IF EXISTS booking_signals;
DELETE FROM schema_migrations WHERE name = '057_booking_integrity';
COMMIT;
