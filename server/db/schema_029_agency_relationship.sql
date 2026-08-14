-- 029: what an agency IS to Sawa, as distinct from whether it is switched on.
--
-- ⚠️ THE PREMISE WAS CORRECTED BY 036. The client confirmed on 14 Aug 2026 that
-- Capital Travel Service is a verified OPERATOR — the first to join — and not a
-- founding partner. 036 drops 'founding_partner' from the CHECK below. What
-- survives, and is the part worth keeping, is the separation this file argued
-- for: `relationship` is not verification, and only 025's `verification_state`
-- may be rendered as one.
--
-- ⚠️ PROPOSED. NOT APPLIED. Migrations do not run on deploy (B5).
--
-- ============================================================================
-- WHY A NEW COLUMN AND NOT A NEW `status`
-- ============================================================================
--
-- DIR-19.3 makes Capital Travel Service an operator record with the
-- **founding-partner** label. There is nowhere to put that.
--
-- `agencies.status` is 'active' / not-active — an ON/OFF switch. Overloading it
-- with 'founding_partner' would make one column answer two unrelated questions,
-- and the first query that asks "which agencies are live" would silently drop
-- the founding partner, or include it, depending on which meaning the author
-- had in mind that day. That is the same collapse this project keeps undoing:
-- one field, two facts.
--
-- ============================================================================
-- WHAT THIS COLUMN MUST NOT BE READ AS
-- ============================================================================
--
-- **`relationship` is not verification.** A founding partner has not been
-- checked by anyone; 025's `verification_state` answers that and stays NULL —
-- "never assessed" — until somebody assesses it.
--
-- Keeping them apart matters because the site's whole operator story is a
-- verification claim. A row that reads "founding partner" and renders as
-- "verified operator" would be the fabricated-operator-card defect rebuilt
-- from real data, which is worse: it would be true that the company exists.
--
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand:  npm run db:migrate
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS relationship TEXT;

-- NULLABLE WITH NO DEFAULT. 023's argument: a DEFAULT of 'operator' would
-- assert a relationship for every existing row that nobody recorded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_relationship_chk') THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_relationship_chk
      CHECK (relationship IS NULL OR relationship IN ('founding_partner', 'operator'));
  END IF;
END $$;
