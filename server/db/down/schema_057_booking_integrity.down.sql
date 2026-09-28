-- Rollback for 057. Drops the GoAhead seat view, the
-- flags and signals and the confirmation columns. Bookings released as
-- 'email_unconfirmed' are re-labeled 'admin' first so the older constraint
-- holds; they stay canceled.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_057_booking_integrity.down.sql
BEGIN;
DROP VIEW IF EXISTS catalogue_departure_goahead;
DROP TABLE IF EXISTS booking_flags;
DROP TABLE IF EXISTS booking_signals;
UPDATE pledges SET cancelled_reason = 'admin' WHERE cancelled_reason = 'email_unconfirmed';
ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_cancelled_reason_chk;
ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
  CHECK (cancelled_reason IS NULL OR cancelled_reason IN
    ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator', 'unpaid'));
DROP INDEX IF EXISTS pledges_email_confirm_token_uq;
ALTER TABLE pledges DROP COLUMN IF EXISTS email_reminded_at;
ALTER TABLE pledges DROP COLUMN IF EXISTS email_confirmed_at;
ALTER TABLE pledges DROP COLUMN IF EXISTS email_confirm_token;
DELETE FROM schema_migrations WHERE name = '057_booking_integrity';
COMMIT;
