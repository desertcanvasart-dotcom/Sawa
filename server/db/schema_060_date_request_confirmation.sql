-- 060: a traveler's date request waits for its email to be confirmed, like a
-- booking (058). Live, not behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_060_date_request_confirmation.down.sql.
-- Additive: two nullable columns and a kind on booking_confirmations, and its
-- departure becomes optional (a request for a new day has none yet).
--
-- Until 058 a request for a new date (or one joining a date still in review)
-- wrote a pending booking at once. It held seats, and on approval it counted,
-- whether or not the email was real. Now it is held here until the traveler
-- clicks "Confirm my booking"; the link makes the request through the same
-- code path and checks. Unconfirmed after 24 hours, it lapses silently.
-- Agency requests are not held.
ALTER TABLE booking_confirmations ALTER COLUMN departure_id DROP NOT NULL;
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'booking';
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS tour_product_id TEXT REFERENCES tour_products(id) ON DELETE CASCADE;
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS request_date DATE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_confirmations_kind_check') THEN
    ALTER TABLE booking_confirmations ADD CONSTRAINT booking_confirmations_kind_check
      CHECK (kind IN ('booking', 'date_request'));
  END IF;
  -- A booking is on a date; a date request names its tour and day.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_confirmations_subject_check') THEN
    ALTER TABLE booking_confirmations ADD CONSTRAINT booking_confirmations_subject_check
      CHECK ((kind = 'booking' AND departure_id IS NOT NULL)
          OR (kind = 'date_request' AND tour_product_id IS NOT NULL AND request_date IS NOT NULL));
  END IF;
END $$;
