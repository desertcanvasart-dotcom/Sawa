-- 037: the date window a traveller may request, set per tour.
--
-- Both ends were constants in server/app.js — REQUEST_MIN_LEAD_DAYS = 3 and
-- REQUEST_MAX_HORIZON_DAYS = 90 — applied identically to every product. The
-- addendum always intended otherwise:
--
--   "Lead time: date must be >= minLeadDays out (per tour product, default 3)."
--   "Horizon:   date must be <= maxHorizonDays out (default 90)."
--
-- "per tour product" and "default" were written and never built. The effect is
-- that a Nile cruise cannot be requested for January while a Cairo day tour has
-- a needlessly long 90-day window, and neither can be changed without a deploy.
--
-- ============================================================================
-- NULL MEANS "USE THE DEFAULT", AND THAT IS NOT THE SAME AS 90
-- ============================================================================
--
-- Nullable with no DEFAULT clause, which is 023's argument again: a DEFAULT of
-- 90 would assert a deliberate window for every existing product that nobody
-- chose. NULL says "nobody has set one, fall back", so the day the default
-- changes, every product that never had an opinion moves with it — and every
-- product that DID keeps what was chosen for it.
--
-- ============================================================================
-- THE BOUNDS ON THE BOUNDS
-- ============================================================================
--
-- Lead time is capped at a year and the horizon at four, because these are typed
-- into a form by a human. Without a CHECK, a slipped digit turns 90 into 900 and
-- the calendar silently offers dates two and a half years out; with one, the
-- save is refused while the operator is still looking at the field.
--
-- The horizon must also exceed the lead time, or a product has a window with no
-- days in it — bookable never, with nothing on screen to say why. That is the
-- kind of empty state a picker renders as "no dates available" and everybody
-- reads as a bug in the site.
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS request_min_lead_days    SMALLINT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS request_max_horizon_days SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_request_window_chk') THEN
    ALTER TABLE tour_products ADD CONSTRAINT tour_products_request_window_chk
      CHECK (
        (request_min_lead_days    IS NULL OR request_min_lead_days    BETWEEN 0 AND 365)
        AND (request_max_horizon_days IS NULL OR request_max_horizon_days BETWEEN 1 AND 1460)
        -- Compared only when BOTH are set. A product with one end configured and
        -- the other on the default is a normal state, and the fallback pair is
        -- known-good, so there is nothing to compare.
        AND (
          request_min_lead_days IS NULL
          OR request_max_horizon_days IS NULL
          OR request_max_horizon_days > request_min_lead_days
        )
      );
  END IF;
END $$;
