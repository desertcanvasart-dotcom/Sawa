-- Referral / affiliate tracking for embedded widgets (?ref=CODE).
-- A partner gets a code; click-throughs increment visits; bookings carry the
-- code so revenue and commission can be attributed back to each partner.
CREATE TABLE IF NOT EXISTS referrals (
  code               TEXT PRIMARY KEY,
  name               TEXT,
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  visits             INTEGER NOT NULL DEFAULT 0,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS ref_code TEXT;
CREATE INDEX IF NOT EXISTS idx_pledges_ref_code ON pledges(ref_code);
