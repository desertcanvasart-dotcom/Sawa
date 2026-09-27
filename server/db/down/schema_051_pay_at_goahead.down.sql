-- Rollback for 051 (pay at GoAhead). Drops what 051 created.
--
-- Lost with it: payment requests, refunds, ops tasks, the waitlist and every
-- cancellation-tier version; export them first if this rollback is permanent.
-- Bookings released for non-payment keep their cancellation, recorded as
-- 'admin' (the restored constraint has no 'unpaid'). Agency invoices still
-- without a due date get the departure date.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_051_pay_at_goahead.down.sql
BEGIN;
DROP TABLE IF EXISTS departure_waitlist;
DROP TABLE IF EXISTS payment_tasks;
DROP TABLE IF EXISTS payment_refunds;
DROP TABLE IF EXISTS payment_requests;

UPDATE agency_invoices i SET due_on = cd.date
  FROM catalogue_departures cd WHERE cd.id = i.departure_id AND i.due_on IS NULL;
ALTER TABLE agency_invoices ALTER COLUMN due_on SET NOT NULL;

UPDATE pledges SET cancelled_reason = 'admin' WHERE cancelled_reason = 'unpaid';
ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_cancelled_reason_chk;
ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
  CHECK (cancelled_reason IS NULL OR cancelled_reason IN
    ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator'));

ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_pay_at_goahead_terms_chk;
ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_terms_fixed_by_chk;
ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_payment_mode_chk;
ALTER TABLE pledges DROP COLUMN IF EXISTS traveller_terms_accepted_at;
ALTER TABLE pledges DROP COLUMN IF EXISTS terms_fixed_by;
ALTER TABLE pledges DROP COLUMN IF EXISTS terms_fixed_at;
ALTER TABLE pledges DROP COLUMN IF EXISTS cancellation_tier_version_id;
ALTER TABLE pledges DROP COLUMN IF EXISTS payment_mode;

DROP TABLE IF EXISTS cancellation_tiers;
DROP TABLE IF EXISTS cancellation_tier_versions;
DROP FUNCTION IF EXISTS cancellation_tiers_immutable();
DELETE FROM finance_settings WHERE key = 'pay_at_goahead';
DELETE FROM schema_migrations WHERE name = '051_pay_at_goahead';
COMMIT;
