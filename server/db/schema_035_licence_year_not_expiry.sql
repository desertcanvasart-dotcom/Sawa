-- 035: an Egyptian tourism licence does not expire. It has a registration year.
--
-- 025 gave the licence an EXPIRES date, reasoning that "We confirm it's active"
-- is a present-tense claim and a confirmation dated eighteen months ago against a
-- lapsed licence is not evidence for it. The reasoning was sound and the fact was
-- wrong: the client confirmed on 14 August 2026 that the licence carries no
-- expiry — only the year it was registered.
--
-- A nullable DATE that nothing can ever fill is worse than no column. It reads as
-- "we have not recorded the expiry yet" rather than "there is no such thing", so
-- every reader is invited to go looking for a value that does not exist, and any
-- expiry check built on it would silently pass for every operator forever.
--
-- ============================================================================
-- INSURANCE STILL EXPIRES
-- ============================================================================
--
-- `insurance_expires` is untouched. Insurance is renewed annually and a lapsed
-- policy IS the case 025 was defending against — so the expiry machinery keeps
-- exactly one subject, which is the one that has expiries.
--
-- ============================================================================
-- SMALLINT, AND WHY THE COLUMN IS NOT A DATE
-- ============================================================================
--
-- A year is not a date. Storing 2011 as '2011-01-01' would invent a day and a
-- month nobody supplied, and the first thing to render it would print
-- "1 January 2011" as though that were the registration date.
--
-- Bounded by a CHECK rather than left open: 1900 excludes a typo'd 201, and the
-- upper bound is deliberately open-ended rather than pinned to "this year",
-- which would need a migration every January.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS tourism_license_year SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_licence_year_chk') THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_licence_year_chk
      CHECK (tourism_license_year IS NULL OR tourism_license_year BETWEEN 1900 AND 2200);
  END IF;
END $$;

-- The expiry column and its index go. Nothing has ever written to them —
-- `agencies` holds one row and no verification has been recorded — so there is
-- no data to migrate and nothing to preserve. If that ever stops being true,
-- this DROP is the statement to revisit.
DROP INDEX IF EXISTS idx_agencies_license_expires;
ALTER TABLE agencies DROP COLUMN IF EXISTS tourism_license_expires;
