-- Rollback for 052 (pay-at-GoAhead safeguards, versioned Terms). Drops what
-- 052 created. Lost with it: the Terms versions and each booking's recorded
-- version, the link alerts and the admin decisions. An unsecured seat goes
-- back to waiting for its link; a deadline set by a decision is recorded as
-- bound by the cut-off.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_052_pay_safeguards_terms.down.sql
BEGIN;
ALTER TABLE pledges DROP COLUMN IF EXISTS terms_version_id;
DROP TABLE IF EXISTS terms_versions;
DROP FUNCTION IF EXISTS terms_versions_immutable();

UPDATE payment_requests SET state = 'awaiting_link' WHERE state = 'unsecured';
UPDATE payment_requests SET due_bound_by = 'cutoff' WHERE due_bound_by = 'decision';
DROP INDEX IF EXISTS uq_payment_requests_live;
CREATE UNIQUE INDEX uq_payment_requests_live ON payment_requests (pledge_id) WHERE state IN ('awaiting_link', 'sent', 'paid');
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_bound_chk2;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_due_bound_by_check
  CHECK (due_bound_by IN ('window', 'cutoff', 'minimum'));
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_state_chk2;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_state_check
  CHECK (state IN ('awaiting_link', 'sent', 'paid', 'released', 'cancelled'));
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_decision_chk;
ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_decision_needed_chk;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decided_at;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decided_by;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decision_reason;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decision;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decision_needed_at;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS decision_needed;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS link_alert_12h_at;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS link_alert_6h_at;
DELETE FROM schema_migrations WHERE name = '052_pay_safeguards_terms';
COMMIT;
