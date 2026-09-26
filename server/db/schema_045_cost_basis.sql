-- 045: a cost line is priced per group or per person.
--
-- ⚠️ Migrations do not run on deploy (B5). Run by hand:
--   DATABASE_URL=<production> npm run db:migrate
-- Until it is, a per-person line still saves: its total is stored and the
-- "€15 × 12 people" breakdown goes into the description instead.
--
-- Transport and a guide cost the same whatever the headcount; meals and
-- entrance fees are paid per traveller. `amount` stays the line's TOTAL — the
-- settlement reads only that — and a per-person line also keeps the price per
-- person and the number of people it was worked out from.
ALTER TABLE departure_costs ADD COLUMN IF NOT EXISTS basis       TEXT NOT NULL DEFAULT 'group';
ALTER TABLE departure_costs ADD COLUMN IF NOT EXISTS unit_amount NUMERIC(10,2);
ALTER TABLE departure_costs ADD COLUMN IF NOT EXISTS quantity    INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_basis_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_basis_chk CHECK (
      basis IN ('group', 'person')
      AND (basis = 'group' OR (unit_amount > 0 AND quantity >= 1)));
  END IF;
END $$;
