-- Rollback for 064. Every rate version gets its per-version EUR rate back
-- from the note 064 left on it. Lost: the traveler-rate history, the FX
-- alerts, the buffer setting, and fetched rates still pending or rejected
-- (deleted: nothing read them). Fetched rates that were approved stay in
-- fx_rates as ordinary rows; only their source columns go.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_064_automatic_fx.down.sql
BEGIN;
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS eur_rate NUMERIC(12,4) CHECK (eur_rate > 0);
ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
UPDATE catalogue_rate_versions SET eur_rate = (source -> 'migration064' ->> 'eurRate')::numeric
 WHERE source ? 'migration064' AND source -> 'migration064' ->> 'eurRate' IS NOT NULL;
UPDATE catalogue_rate_versions SET source = source - 'migration064' WHERE source ? 'migration064';
ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;
ALTER TABLE pledges DROP COLUMN IF EXISTS awaiting_exchange_rate;
DELETE FROM finance_settings WHERE key = 'traveller_rate';
DROP TABLE IF EXISTS fx_traveller_rates;
DROP TABLE IF EXISTS fx_alerts;
DELETE FROM fx_rates WHERE status <> 'approved';
ALTER TABLE fx_rates DROP CONSTRAINT IF EXISTS fx_rates_status_check;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS decided_at;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS decided_by;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS previous_egp_per_eur;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS provider_as_of;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS fetched_at;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS source;
ALTER TABLE fx_rates DROP COLUMN IF EXISTS status;
DELETE FROM schema_migrations WHERE name = '064_automatic_fx';
COMMIT;
