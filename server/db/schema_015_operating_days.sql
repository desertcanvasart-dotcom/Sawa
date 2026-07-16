-- Operating days: the weekdays a tour can depart (0=Sunday … 6=Saturday,
-- JS getDay() convention). NULL or empty = departs any day. Enforced for
-- traveler-initiated date requests (a Nile cruise that sails Mondays must
-- not accept a Tuesday request); informational elsewhere.
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS operating_days jsonb;
