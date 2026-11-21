-- 071 — the campaign a booking came from.
--
-- A reservation already records whether it was direct or through a partner
-- (pledges.agency_id, pledges.ref_code). It did not record WHICH link brought
-- the traveller: nothing read the utm_ parameters marketing links carry. These
-- three columns keep them with the booking, so the weekly review can say which
-- post, email or agency page filled which date.
--
--   pledges.utm_source    the channel           instagram, blog, email …
--   pledges.utm_medium    the kind of link      social, organic, email, referral, paid
--   pledges.utm_campaign  the tour and date     fayoum-2026-12-04
--
-- Short lower-case labels only, reduced to [a-z0-9_.-] before they are written
-- (shared/campaign.js). No address, no personal data. The privacy notice
-- already lists "referring page, campaign or operator referral code".
--
-- Additive and nullable. Before it is applied the app behaves as it did: the
-- write is skipped (server/campaign.js) and no booking is affected.
-- Rollback: server/db/down/schema_071_campaign_attribution.down.sql.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
