-- Multiple meeting points per tour/package.
-- Each item: { "point": "<location>", "note": "<be there by / departs ...>" }
ALTER TABLE tour_products
  ADD COLUMN IF NOT EXISTS meeting_points jsonb NOT NULL DEFAULT '[]'::jsonb;
