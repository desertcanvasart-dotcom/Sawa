-- 014: Traveler-initiated departures, Phase A ("request a departure").
-- See MVP_SPEC_ADDENDUM_TRAVELER_INITIATED.md. A traveler picks tour + date +
-- contact on the public site; the departure lands as `pending_review` and an
-- admin approves it into `open` (or declines -> cancelled). Idempotent.

-- Allow the new status on departures.
ALTER TABLE departures DROP CONSTRAINT IF EXISTS departures_status_check;
ALTER TABLE departures
  ADD CONSTRAINT departures_status_check
  CHECK (status IN ('pending_review','open','minimum_reached','supplier_confirmed','closed','cancelled'));

-- Who instantiated the departure (addendum data-model delta).
ALTER TABLE departures ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'admin';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'departures_created_by_chk'
  ) THEN
    ALTER TABLE departures
      ADD CONSTRAINT departures_created_by_chk CHECK (created_by IN ('admin','agency','traveler'));
  END IF;
END $$;
