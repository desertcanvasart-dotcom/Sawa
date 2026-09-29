-- Rollback of 065. Manual and automatic-switch rows are kept as history but
-- the constraint goes back to 064's list, so they are relabelled "override"
-- (their note says why). The mode setting is dropped (automatic again).
-- EUR-priced rate card versions are NOT converted back: publish an EGP
-- version for those products before rolling back the code.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_065_exchange_mode_eur_prices.down.sql
BEGIN;
ALTER TABLE fx_traveller_rates DROP CONSTRAINT IF EXISTS fx_traveller_override_reason;
ALTER TABLE fx_traveller_rates DROP CONSTRAINT IF EXISTS fx_traveller_rates_reason_check;
UPDATE fx_traveller_rates SET reason = 'override', note = coalesce(nullif(trim(note), ''), 'switched back to automatic')
 WHERE reason IN ('manual', 'automatic');
ALTER TABLE fx_traveller_rates ADD CONSTRAINT fx_traveller_rates_reason_check
  CHECK (reason IN ('migrated', 'initial', 'weekly', 'market_move', 'override'));
ALTER TABLE fx_traveller_rates ADD CONSTRAINT fx_traveller_override_reason
  CHECK (reason <> 'override' OR length(trim(coalesce(note, ''))) > 0);
UPDATE finance_settings SET value = value - 'mode' WHERE key = 'traveller_rate';
DELETE FROM schema_migrations WHERE name = '065_exchange_mode_eur_prices';
COMMIT;
