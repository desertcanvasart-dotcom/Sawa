-- Rollback for 060. Held date requests are deleted (they would have lapsed at
-- 24 hours anyway); held bookings stay. Requests are then made at once again.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_060_date_request_confirmation.down.sql
BEGIN;
DELETE FROM booking_confirmations WHERE kind = 'date_request';
ALTER TABLE booking_confirmations DROP CONSTRAINT IF EXISTS booking_confirmations_subject_check;
ALTER TABLE booking_confirmations DROP CONSTRAINT IF EXISTS booking_confirmations_kind_check;
ALTER TABLE booking_confirmations DROP COLUMN IF EXISTS request_date;
ALTER TABLE booking_confirmations DROP COLUMN IF EXISTS tour_product_id;
ALTER TABLE booking_confirmations DROP COLUMN IF EXISTS kind;
ALTER TABLE booking_confirmations ALTER COLUMN departure_id SET NOT NULL;
DELETE FROM schema_migrations WHERE name = '060_date_request_confirmation';
COMMIT;
