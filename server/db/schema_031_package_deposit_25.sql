-- 031: move the multi-day package deposit from 20% to 25%.
--
-- The rate changed with the cancellation policy on 13 August 2026 (PR #147).
-- shared/booking-policy.js now returns 25 for a package, but that is only a
-- DEFAULT: `deposit_percent` is a stored column on both tour_products and
-- departures, and every package created before that day carries 20. Those rows
-- win over the default, so without this the site would keep quoting 20% on
-- existing packages indefinitely.
--
-- Applied on the client's explicit instruction, 13 August 2026.
--
-- ============================================================================
-- WHAT THIS DELIBERATELY DOES NOT TOUCH: pledges
-- ============================================================================
--
-- `pledges.deposit_percent` and `pledges.deposit_due` are WRITE-TIME CAPTURE
-- (migration 023). They are not a copy of the product's rate — they are the
-- figure a named traveller was quoted, and shown, and emailed, and agreed to.
--
-- Updating them would retroactively change what someone already owes. A
-- traveller who booked a package at 20% and has the confirmation email to prove
-- it would find a different number on their booking page, and Sawa would have no
-- record of the one they were actually given. That is the defect this project
-- has closed twice already in other forms: a live surface telling a named person
-- something untrue about their own booking.
--
-- So the rate moves for FUTURE bookings only. Anyone already booked keeps what
-- they were quoted, which is also what the Terms promise.
--
-- ============================================================================
-- WHY `WHERE deposit_percent = 20` AND NOT `WHERE type = 'package'`
-- ============================================================================
--
-- server/db/migrate.js re-runs EVERY migration file on every invocation — it
-- does not skip ones already recorded, it just re-inserts the record with ON
-- CONFLICT DO NOTHING. That is harmless for `CREATE TABLE IF NOT EXISTS` and
-- `ADD COLUMN IF NOT EXISTS`. It is NOT harmless for an UPDATE.
--
-- `WHERE type = 'package'` would re-stomp the rate to 25 on every future
-- `npm run db:migrate` — so an operator who later sets one package to 30% would
-- find it silently reverted by an unrelated migration run, with nothing in the
-- logs to say why.
--
-- Matching on the OLD VALUE makes the statement say what it means: move the
-- superseded rate, leave every deliberate one alone. It is idempotent, and it
-- expires by itself once no 20% package remains.
UPDATE tour_products
   SET deposit_percent = 25
 WHERE type = 'package'
   AND deposit_percent = 20;

UPDATE departures
   SET deposit_percent = 25
 WHERE type = 'package'
   AND deposit_percent = 20;

-- A departure whose own type is unset but whose product is a package. The
-- departure's `type` defaults to 'day_tour', so a row created without one is
-- classified by the product it belongs to rather than left on the old rate.
UPDATE departures d
   SET deposit_percent = 25
  FROM tour_products p
 WHERE p.id = d.tour_product_id
   AND p.type = 'package'
   AND d.deposit_percent = 20;
