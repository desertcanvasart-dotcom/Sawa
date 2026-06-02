-- ============================================================
--  Phase A — richer tour content
-- ============================================================
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS overview_html       TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS policies_html       TEXT;   -- cancellation / general policies (rich)
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS what_to_bring       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS meeting_point       TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS pickup_note         TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS booking_cutoff_hours INTEGER NOT NULL DEFAULT 24 CHECK (booking_cutoff_hours >= 0);
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS images              JSONB NOT NULL DEFAULT '[]'::jsonb;  -- [{url, alt}], first = cover
