-- 021: cap group size at 12, the limit the booking conditions state.
--
-- "Every Sawa departure runs with a minimum of 4 and a maximum of 12
-- travelers" appears in the terms and on the how-it-works page. That is a term
-- of the contract, but nothing enforced it: max_seats was free-form above 1, so
-- a listing or a departure could be published for twenty travellers and the
-- site would sell twenty seats while promising a maximum of twelve.
--
-- Application-level validation (capacityError in server/domain.js) produces the
-- message an operator can act on. This constraint is the backstop: it holds for
-- paths that bypass the API — a manual UPDATE, a future import script, a bug in
-- a new endpoint.
--
-- The number is deliberately literal rather than configurable. Raising it means
-- changing what the booking conditions promise, which should be a deliberate
-- migration alongside a copy change, not a variable someone can nudge.
--
-- Safe on current data: every row in both tables is already max_seats = 12.
-- Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_max_group_size_chk'
  ) THEN
    ALTER TABLE tour_products
      ADD CONSTRAINT tour_products_max_group_size_chk CHECK (max_seats <= 12);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'departures_max_group_size_chk'
  ) THEN
    ALTER TABLE departures
      ADD CONSTRAINT departures_max_group_size_chk CHECK (max_seats <= 12);
  END IF;
END $$;
