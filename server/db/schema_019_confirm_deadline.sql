-- 019: the GoAhead deadline — how long before departure a date must have
-- reached its minimum, or it is cancelled.
--
-- The booking conditions have always promised this ("if a departure does not
-- reach its minimum of four travelers by its deadline, it is cancelled
-- automatically and you pay nothing"), and so has the GoAhead promise page —
-- but no deadline existed anywhere in the data model and nothing ever cancelled
-- anything. A date that never filled simply sat at `open` until its departure
-- day passed, and the travellers holding seats were never told.
--
-- NULL means "use the default for this product type" (30 days for packages,
-- 7 for day tours — see confirmDeadlineDaysFor in server/domain.js). Kept
-- nullable rather than backfilled so the policy lives in one place in code and
-- a listing only stores a number when an operator deliberately overrides it.
--
-- Idempotent.
ALTER TABLE tour_products
  ADD COLUMN IF NOT EXISTS confirm_deadline_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_confirm_deadline_chk'
  ) THEN
    ALTER TABLE tour_products
      ADD CONSTRAINT tour_products_confirm_deadline_chk
      CHECK (confirm_deadline_days IS NULL OR confirm_deadline_days BETWEEN 0 AND 365);
  END IF;
END $$;

-- The cancellation job scans open departures by date; this keeps that cheap as
-- the catalogue grows.
CREATE INDEX IF NOT EXISTS idx_departures_open_by_date
    ON departures (date) WHERE status = 'open';
