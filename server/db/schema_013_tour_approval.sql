-- Tour-listing approval workflow.
-- Agencies can submit tour listings, but they only go live once a platform
-- admin approves them. Existing tours default to 'approved' so nothing that is
-- already live disappears.
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS agency_id TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE tour_products ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Guard the allowed values without failing if the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tour_products_status_chk') THEN
    ALTER TABLE tour_products
      ADD CONSTRAINT tour_products_status_chk CHECK (status IN ('pending','approved','rejected'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tour_products_status ON tour_products (status);
CREATE INDEX IF NOT EXISTS idx_tour_products_agency ON tour_products (agency_id);
