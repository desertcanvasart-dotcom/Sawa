-- ============================================================
--  Phase D — booking lifecycle + contact
-- ============================================================
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (status IN ('pending','confirmed','paid','cancelled'));
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS traveller_names JSONB NOT NULL DEFAULT '[]'::jsonb;
