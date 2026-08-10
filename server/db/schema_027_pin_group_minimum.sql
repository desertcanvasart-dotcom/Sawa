-- 027: pin the GoAhead minimum at four.
--
-- ⚠️ PROPOSED, CONDITIONAL, AND NOT TO BE APPLIED YET.
--
-- This migration is correct only if the client answers CCCC2 — "does Sawa ever
-- want a product requiring more than four to run?" — with NO. If the answer is
-- yes, this file must be deleted rather than applied, and the copy takes the
-- CCCC2.2 route instead. See docs/audit/group-size-decision.md.
--
-- ============================================================================
-- WHY A CONSTRAINT AND NOT A SENTENCE
-- ============================================================================
--
-- Eight places on the site say "four travelers" as a flat literal. It is the
-- strongest line Sawa has: concrete, memorable, and checkable against the thing
-- that actually happens. Nothing enforces it.
--
--   tour_products.min_seats  INTEGER NOT NULL DEFAULT 4 CHECK (min_seats >= 1)
--   departures.min_seats     INTEGER NOT NULL DEFAULT 4 CHECK (min_seats >= 1)
--
-- and the API narrows that only to a RANGE:
--
--   minSeats: z.coerce.number().int().min(MIN_GROUP_SIZE).max(MAX_GROUP_SIZE)
--             // 4 .. 12
--
-- Read the validator's own message: *"Minimum group size is 4 travellers — what
-- the booking conditions promise a departure confirms at."* **The code already
-- knows four is the promise, and then permits five through twelve anyway.** Four
-- is enforced as a floor; the promise needs it as a value.
--
-- The alternative was to hedge the copy to "usually four". That solves a data
-- problem with words, and costs the clearest sentence on the site.
--
-- ============================================================================
-- BOTH TABLES. PINNING ONE WOULD BE WORSE THAN PINNING NEITHER.
-- ============================================================================
--
-- `goAheadSeatsFor` reads the DEPARTURE:
--
--   Math.max(1, Number(item?.minSeats || item?.min_seats || DEFAULT_GO_AHEAD))
--
-- and it is called with a departure, not a product. So a constraint on
-- `tour_products` alone would leave the number that actually decides
-- confirmation unconstrained — and would read, to anyone auditing later, as
-- though the question had been settled.
--
-- ============================================================================
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand, if approved:
--
--   npm run db:migrate          (with DATABASE_URL set in the environment)
--
-- Idempotent — safe to re-run.
--
-- SAFE TO APPLY TODAY IF APPROVED: all 16 approved products hold min_seats = 4,
-- and `departures` holds no rows at all, so nothing existing violates it.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_min_seats_pinned') THEN
    ALTER TABLE tour_products ADD CONSTRAINT tour_products_min_seats_pinned
      CHECK (min_seats = 4);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departures_min_seats_pinned') THEN
    ALTER TABLE departures ADD CONSTRAINT departures_min_seats_pinned
      CHECK (min_seats = 4);
  END IF;
END $$;

-- The ceiling is NOT pinned, deliberately. "Never more than twelve" is the
-- universal half of the promise and `max_seats` may legitimately be lower on a
-- smaller vehicle; twelve is a limit, not a target. Only the confirmation
-- threshold is a number the copy states flatly.
