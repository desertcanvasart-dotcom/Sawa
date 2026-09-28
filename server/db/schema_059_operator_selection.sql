-- 059: who operates a departure (phase 5, catalogue_v2).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_059_operator_selection.down.sql. Additive:
-- two more permitted values and three nullable columns on
-- catalogue_assignments.
--
-- At GoAhead the departure is offered first to an agency that has travelers
-- on it and is an approved, active operator for the product: the one with the
-- most travelers, then the one that booked first. Declined or not
-- acknowledged within 4 hours, it goes to the next such agency, then to the
-- rostered operator (the phase 2 roster is the fallback).
--
--   state  'declined'  the operator said no (no strike)
--   source 'agency'    offered because the operator's agency has travelers on
--                      the departure; `candidate` records why it was chosen
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'catalogue_assignments'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%state%' OR pg_get_constraintdef(oid) LIKE '%source%')
  LOOP
    EXECUTE format('ALTER TABLE catalogue_assignments DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_state_check
    CHECK (state IN ('offered', 'acknowledged', 'expired', 'replaced', 'declined'));
  ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_source_check
    CHECK (source IN ('roster', 'admin', 'agency'));
END $$;

ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS candidate JSONB;
