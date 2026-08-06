-- 020: optional per-headcount pricing on a listing.
--
-- Until now an operator set two anchors — the price at the minimum group and
-- the price at a full one — and the system drew a straight line between them.
-- That is right for most tours and stays the default. It cannot express a real
-- cost step, though: a seven-seater up to six travellers and a minibus beyond
-- is a jump, not a slope, and pricing it as a slope either overcharges the
-- small group or undercharges the large one.
--
-- Stored as breakpoints, not one row per traveller: [{"seats":4,"price":110},
-- {"seats":7,"price":85}]. The price for N travellers is the last breakpoint at
-- or below N, so a sparse table prices every group size in between.
--
-- NULL — the normal case — means "use the published/break interpolation", so
-- every existing listing behaves exactly as before.
--
-- Validation lives in validatePriceTiers() in server/domain.js rather than in a
-- CHECK constraint: the rules are cross-row (no duplicate group sizes, prices
-- never rise, must start at the minimum) and need to produce an error an
-- operator can act on, not a constraint violation.
--
-- Idempotent.
ALTER TABLE tour_products
  ADD COLUMN IF NOT EXISTS price_tiers JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_price_tiers_chk'
  ) THEN
    -- Shape only. An array keeps the ordering meaningful and stops an object
    -- or a scalar landing here from a bad client.
    ALTER TABLE tour_products
      ADD CONSTRAINT tour_products_price_tiers_chk
      CHECK (price_tiers IS NULL OR jsonb_typeof(price_tiers) = 'array');
  END IF;
END $$;
