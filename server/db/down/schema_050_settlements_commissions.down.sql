-- Rollback for 050 (settlements and commissions). Drops what 050 created.
-- Recorded payments, statements and bank details are lost with it: export
-- them first if this rollback is permanent.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_050_settlements_commissions.down.sql
BEGIN;
DROP TABLE IF EXISTS finance_settings;
DROP TABLE IF EXISTS finance_payments;
DROP TABLE IF EXISTS agency_invoices;
DROP TABLE IF EXISTS agency_commissions;
DROP TABLE IF EXISTS commission_statements;
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_billing_due_days_chk;
ALTER TABLE agencies DROP COLUMN IF EXISTS billing_due_days;
ALTER TABLE agencies DROP COLUMN IF EXISTS billing_approved;
ALTER TABLE agencies DROP COLUMN IF EXISTS country_code;
DROP TABLE IF EXISTS settlement_statements;
DROP TABLE IF EXISTS operator_setoffs;
DROP TABLE IF EXISTS operator_receivables;
ALTER TABLE catalogue_assignments DROP CONSTRAINT IF EXISTS catalogue_assignments_replaced_reason_chk;
ALTER TABLE catalogue_assignments DROP COLUMN IF EXISTS replaced_reason;
DROP TABLE IF EXISTS operator_adjustments;
DROP TABLE IF EXISTS operator_payables;
DROP TABLE IF EXISTS operator_penalty_rates;
DROP TABLE IF EXISTS fx_rates;
DROP TABLE IF EXISTS egypt_holidays;
DROP TABLE IF EXISTS operator_bank_access_log;
DROP TABLE IF EXISTS operator_bank_accounts;
DROP TABLE IF EXISTS booking_completion_requests;
ALTER TABLE catalogue_rate_versions DROP CONSTRAINT IF EXISTS catalogue_rate_commission_eur;
ALTER TABLE catalogue_rate_versions DROP COLUMN IF EXISTS commission_currency;
DELETE FROM schema_migrations WHERE name = '050_settlements_commissions';
COMMIT;
