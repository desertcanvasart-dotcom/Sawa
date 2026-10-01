-- Rollback of 068, with the code from before it. Documents waiting for review
-- or rejected are deleted (the old code would count them as current); every
-- approved document stays. The ETAA numbers that moved to the license field
-- stay there. Capital Travel Service stays listed; re-block it by hand if needed.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_068_agency_documents.down.sql
BEGIN;
DELETE FROM operator_documents WHERE review_state <> 'approved';
DROP INDEX IF EXISTS uq_operator_documents_pending;
DROP INDEX IF EXISTS uq_operator_documents_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_documents_current ON operator_documents (operator_id, kind) WHERE superseded_at IS NULL;
ALTER TABLE operator_documents DROP CONSTRAINT IF EXISTS operator_documents_review_state_chk;
ALTER TABLE operator_documents DROP CONSTRAINT IF EXISTS operator_documents_submitted_via_chk;
ALTER TABLE operator_documents DROP COLUMN IF EXISTS review_state, DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS reviewed_by, DROP COLUMN IF EXISTS reviewed_at, DROP COLUMN IF EXISTS submitted_via;
DELETE FROM operator_documents WHERE kind NOT IN ('tourism_license', 'etaa_membership', 'liability_insurance', 'vehicle_insurance');
ALTER TABLE operator_documents DROP CONSTRAINT IF EXISTS operator_documents_kind_chk;
ALTER TABLE operator_documents ADD CONSTRAINT operator_documents_kind_check
  CHECK (kind IN ('tourism_license', 'etaa_membership', 'liability_insurance', 'vehicle_insurance'));
ALTER TABLE operators DROP COLUMN IF EXISTS activation_exception, DROP COLUMN IF EXISTS activation_exception_kinds,
  DROP COLUMN IF EXISTS activation_exception_by, DROP COLUMN IF EXISTS activation_exception_at;
ALTER TABLE agencies DROP COLUMN IF EXISTS etaa_url;
DROP INDEX IF EXISTS uq_agencies_direct_bookings_preferred;
ALTER TABLE agencies DROP COLUMN IF EXISTS direct_bookings_preferred;
DELETE FROM schema_migrations WHERE name = '068_agency_documents';
COMMIT;
