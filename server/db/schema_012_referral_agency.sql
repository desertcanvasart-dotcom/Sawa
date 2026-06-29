-- Let an agency own a referral code so it can self-serve its own widget.
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS agency_id TEXT;
CREATE INDEX IF NOT EXISTS idx_referrals_agency ON referrals(agency_id);
