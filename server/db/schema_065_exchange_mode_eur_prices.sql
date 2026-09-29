-- 065: phase 7, behind catalogue_v2 (decided 29 Sep 2026).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 064:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_065_exchange_mode_eur_prices.down.sql.
--
-- 1. EXCHANGE RATE MODE. One site-wide setting, automatic or manual
--    (finance_settings 'traveller_rate'.mode, default automatic). A manual
--    rate, and the switch back to automatic, are rows in fx_traveller_rates
--    like every other change; a manual one needs its reason, as an override
--    did. "override" stays allowed for the rows 064 may have written.
-- 2. EUR PRICES. A rate card tier may carry `priceEur` (what travelers pay)
--    instead of `priceEgp`. That is JSON inside `tiers`: no column changes.
--    Existing versions are converted by scripts/phase7-convert.js into new
--    drafts for review (it needs a site-wide rate to exist), never here.
--
-- Safe to rerun.

ALTER TABLE fx_traveller_rates DROP CONSTRAINT IF EXISTS fx_traveller_rates_reason_check;
ALTER TABLE fx_traveller_rates ADD CONSTRAINT fx_traveller_rates_reason_check
  CHECK (reason IN ('migrated', 'initial', 'weekly', 'market_move', 'override', 'manual', 'automatic'));
ALTER TABLE fx_traveller_rates DROP CONSTRAINT IF EXISTS fx_traveller_override_reason;
ALTER TABLE fx_traveller_rates ADD CONSTRAINT fx_traveller_override_reason
  CHECK (reason NOT IN ('override', 'manual') OR length(trim(coalesce(note, ''))) > 0);

UPDATE finance_settings SET value = value || '{"mode": "automatic"}'::jsonb, updated_by = 'migration 065'
 WHERE key = 'traveller_rate' AND NOT (value ? 'mode');
