-- Rollback for 061. The old rate columns were never changed, so the phase 3
-- per-seat commission model comes back as it was. Lost: what was entered in
-- the new columns (tier prices, cost lines, fees, EUR rates), pool-based
-- agency rows and statements (deleted: they have no meaning without the
-- pool; a bank transfer already recorded against one stays in
-- finance_payments), refunds of a tier difference that are still pending (done ones stay,
-- as `resale`, so the money trail is kept), and the departure calculations.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_061_pool_model.down.sql
BEGIN;
DROP TABLE IF EXISTS catalogue_departure_economics;
DELETE FROM payment_refunds WHERE kind = 'tier_difference' AND state <> 'done';
DROP INDEX IF EXISTS uq_payment_refunds_tier_difference;
ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_kind_check;
UPDATE payment_refunds SET kind = 'resale' WHERE kind = 'tier_difference';
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_kind_check CHECK (kind IN ('cancellation', 'resale'));
DELETE FROM agency_commissions WHERE basis = 'pool';
DELETE FROM commission_statements WHERE basis = 'pool';
ALTER TABLE commission_statements DROP CONSTRAINT IF EXISTS commission_statements_basis_check;
ALTER TABLE commission_statements DROP COLUMN IF EXISTS basis;
ALTER TABLE agency_commissions DROP CONSTRAINT IF EXISTS agency_commissions_basis_check;
ALTER TABLE agency_commissions DROP COLUMN IF EXISTS earned_egp;
ALTER TABLE agency_commissions DROP COLUMN IF EXISTS share_factor;
ALTER TABLE agency_commissions DROP COLUMN IF EXISTS pool_per_traveller_egp;
ALTER TABLE agency_commissions DROP COLUMN IF EXISTS basis;
ALTER TABLE pledges DROP COLUMN IF EXISTS published_eur_rate;
ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
ALTER TABLE catalogue_rate_versions DROP COLUMN IF EXISTS eur_rate;
ALTER TABLE catalogue_rate_versions DROP COLUMN IF EXISTS commission_pct;
ALTER TABLE catalogue_rate_versions DROP COLUMN IF EXISTS cost_lines;
ALTER TABLE catalogue_rate_versions DROP COLUMN IF EXISTS tiers;
UPDATE catalogue_rate_versions SET source = source - 'migration061';
ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;
DELETE FROM schema_migrations WHERE name = '061_pool_model';
COMMIT;
