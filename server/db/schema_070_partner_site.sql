-- 070 — a partner's website, and the page a widget booking was made on.
--
-- The widget keeps a traveler on the agency's site until they reserve. The
-- emails that follow (confirm my booking, check your booking) linked to
-- sawa.tours. With these two columns they can link back to the agency's page:
--
--   agencies.website          the site the agency registers in its portal
--                             (Settings → Agency details). Links are only ever
--                             made to pages on this site — see
--                             shared/partner-page.js for why.
--   pledges.partner_page_url  the page on that site the booking was made on,
--                             already checked against agencies.website.
--
-- Additive and nullable. Before it is applied the app behaves as it did: the
-- website cannot be saved (the portal says the feature isn't switched on yet)
-- and every link goes to sawa.tours.
-- Rollback: server/db/down/schema_070_partner_site.down.sql.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS partner_page_url TEXT;
