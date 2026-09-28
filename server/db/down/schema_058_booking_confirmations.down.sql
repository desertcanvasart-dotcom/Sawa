-- Rollback for 058. Drops the table of unconfirmed bookings. Confirmed
-- bookings are ordinary rows in `pledges` and stay; unconfirmed ones are lost,
-- which is what they would have become at 24 hours anyway.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_058_booking_confirmations.down.sql
BEGIN;
DROP TABLE IF EXISTS booking_confirmations;
DELETE FROM schema_migrations WHERE name = '058_booking_confirmations';
COMMIT;
