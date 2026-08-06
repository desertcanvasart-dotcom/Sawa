-- 022: floor group size at 4, the other end of the sentence 021 capped.
--
-- "Every Sawa departure runs with a minimum of 4 and a maximum of 12
-- travelers" — 021 enforced the 12. This enforces the 4.
--
-- A date that confirms below four breaks the promise in the direction that
-- matters to a traveller: they booked expecting to share the trip with at
-- least three other people, and a minimum of two would run it with one. The
-- whole product is "four travelers confirms the trip", stated on the homepage,
-- the how-it-works page, the GoAhead promise page and in the booking
-- conditions.
--
-- Note this is a floor, not a fixed value. A listing may require MORE than
-- four — a nine-day cruise might not be viable at four — and nothing is hidden
-- when it does, because the card shows the real threshold ("2 of 6 joined").
-- What it may never do is confirm with fewer.
--
-- Application-level validation (capacityError in server/domain.js) produces the
-- message an operator can act on. This is the backstop for paths that bypass
-- the API.
--
-- Safe on current data: every row in both tables is already min_seats = 4.
-- Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_min_group_size_chk'
  ) THEN
    ALTER TABLE tour_products
      ADD CONSTRAINT tour_products_min_group_size_chk CHECK (min_seats >= 4);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'departures_min_group_size_chk'
  ) THEN
    ALTER TABLE departures
      ADD CONSTRAINT departures_min_group_size_chk CHECK (min_seats >= 4);
  END IF;
END $$;
