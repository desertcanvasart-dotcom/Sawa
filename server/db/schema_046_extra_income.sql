-- 046: extra income on the cost sheet, and commission we pay.
--
-- ⚠️ Migrations do not run on deploy (B5). Run by hand:
--   DATABASE_URL=<production> npm run db:migrate
-- Until it is, "Commission we pay" saves as an "Other" cost, and income lines
-- are refused with a message naming this migration.
--
-- A line on a departure's cost sheet is now money out (`kind` = 'cost') or
-- money in (`kind` = 'income': a shop commission, optional tours the guide
-- sells). Income is approved by Sawa like a cost and adds to gross profit.
-- The kind follows from the category; the constraint keeps the two in step.
ALTER TABLE departure_costs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cost';

DO $$
BEGIN
  ALTER TABLE departure_costs DROP CONSTRAINT IF EXISTS departure_costs_category_chk;
  ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_category_chk CHECK (category IN
    ('transport', 'guide', 'entrance', 'meals', 'activities', 'accommodation', 'permits', 'local_services', 'commission_paid', 'other',
     'shop_commission', 'optional_tours', 'commission_received'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_kind_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_kind_chk CHECK (
      kind IN ('cost', 'income')
      AND (kind = 'income') = (category IN ('shop_commission', 'optional_tours', 'commission_received')));
  END IF;
END $$;
