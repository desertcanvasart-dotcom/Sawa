-- Rollback for 056. Drops the party link from every booking and the parties
-- table; the bookings themselves are untouched.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_056_booking_parties.down.sql
BEGIN;
ALTER TABLE pledges DROP COLUMN IF EXISTS party_id;
DROP TABLE IF EXISTS booking_parties;
DELETE FROM schema_migrations WHERE name = '056_booking_parties';
COMMIT;
