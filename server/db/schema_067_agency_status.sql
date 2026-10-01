-- 067: agencies.status is 'active' or 'inactive' (Agencies → Deactivate).
--
-- An inactive agency keeps its tours, bookings and referral codes; its team
-- can't sign in (server/auth.js) and it can't be chosen as a tour's operating
-- company (operatorSelectable). The column has always defaulted to 'active' and
-- nothing wrote any other value, but it had no CHECK, so the schema couldn't
-- say which values exist.
--
-- The app works without this migration (the column is plain TEXT); it makes the
-- schema the authority for the two values. Added only if every existing row
-- already fits, so applying it can't fail on old data. Safe to rerun.
--
-- ⚠️ Migrations do not run on deploy. Apply by hand: npm run db:migrate, or
-- paste this file into the Supabase SQL editor.
-- Rollback: server/db/down/schema_067_agency_status.down.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_status_check')
     AND NOT EXISTS (SELECT 1 FROM agencies WHERE status NOT IN ('active', 'inactive')) THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_status_check CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;
