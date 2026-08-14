-- 036: there is no "founding partner". Capital Travel Service is an operator.
--
-- 029 added `relationship` with two allowed values, 'founding_partner' and
-- 'operator', to hold DIR-19.3's finding that CTS was a founding partner rather
-- than a verified operator. Its header warned that rendering one as the other
-- "would be the fabricated-operator-card defect rebuilt from real data".
--
-- The client corrected the premise on 14 August 2026: CTS is not a founding
-- partner in any sense the site should record. It is a verified operator — the
-- first to join the platform — and its licence and ETAA numbers are correct and
-- verified.
--
-- So the category goes. Leaving 'founding_partner' in the CHECK would keep a
-- live-looking option that nothing may ever be, and the next person to read the
-- constraint would reasonably conclude Sawa has founding partners. A constraint
-- is documentation that the database enforces; a value nobody may use is a
-- sentence that is not true.
--
-- ============================================================================
-- WHAT DOES NOT CHANGE, AND MUST NOT
-- ============================================================================
--
-- `relationship` is still NOT verification. 025's `verification_state` answers
-- "has anyone checked this", and it stays NULL — "never assessed" — until
-- somebody assesses it. An operator record and a verified operator remain two
-- different claims, and the site may only make the second one from the second
-- column. That was 029's real point and it survives the category being wrong.
--
-- The column keeps its name and its nullability. Every row that has no recorded
-- relationship still says nothing, rather than being defaulted into one.
DO $$
BEGIN
  -- No row can hold the retired value today — `agencies` has one row and
  -- `relationship` has never been written — but the UPDATE runs first regardless
  -- so the constraint swap cannot fail on data that appeared in between.
  UPDATE agencies SET relationship = 'operator' WHERE relationship = 'founding_partner';

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_relationship_chk') THEN
    ALTER TABLE agencies DROP CONSTRAINT agencies_relationship_chk;
  END IF;

  ALTER TABLE agencies ADD CONSTRAINT agencies_relationship_chk
    CHECK (relationship IS NULL OR relationship = 'operator');
END $$;
