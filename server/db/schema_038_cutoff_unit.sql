-- 038: the booking cutoff gets a unit, because hours suit a day tour and
-- misdescribe a package.
--
-- 006 gave every product `booking_cutoff_hours` (default 24). For a day tour
-- that is the right dial: the manifest stops moving the evening before. For a
-- five-day Nile package it is the wrong one — flights, cabins and a guide are
-- committed days out, and "24 hours" as the only expressible answer means the
-- operator either accepts last-day manifest changes or types 120 and asks
-- everyone to read it as five days. The client asked for the unit to be
-- chosen per tour (15 August 2026).
--
-- ============================================================================
-- THE NUMBER STAYS CANONICAL IN HOURS
-- ============================================================================
--
-- Enforcement (bookingClosed in server/domain.js) keeps reading
-- `booking_cutoff_hours`, unchanged. This column records how the operator
-- EXPRESSED the cutoff, so the editor can show "3 days" back instead of the
-- "72" it stores. Two columns that could each claim to be the cutoff would be
-- the drift this repo keeps finding; one canonical value plus a display unit
-- cannot disagree about when bookings close.
--
-- NULL means "never chosen" and renders as hours — every existing product
-- keeps reading exactly as it always has, rather than being defaulted into a
-- choice nobody made (023's argument, again).
--
-- The divisibility CHECK exists because "3 days" stored as anything but a
-- multiple of 24 is a display that lies about the stored rule. The editor
-- converts before writing; the constraint refuses the write that skipped the
-- editor.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'tour_products' AND column_name = 'booking_cutoff_unit'
  ) THEN
    ALTER TABLE tour_products ADD COLUMN booking_cutoff_unit TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_cutoff_unit_chk') THEN
    ALTER TABLE tour_products ADD CONSTRAINT tour_products_cutoff_unit_chk
      CHECK (
        (booking_cutoff_unit IS NULL OR booking_cutoff_unit IN ('hours', 'days'))
        AND (booking_cutoff_unit IS DISTINCT FROM 'days' OR booking_cutoff_hours % 24 = 0)
      );
  END IF;
END $$;
