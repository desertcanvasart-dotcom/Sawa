-- Migration 068 (agency documents and review, activation by exception, the ETAA link,
-- the agency preferred for direct bookings, Capital Travel Service relisted) as one script
-- for the Supabase SQL editor: paste, run, done. The same SQL as
-- server/db/schema_068_agency_documents.sql, in one transaction, recorded in schema_migrations.
-- Apply 067 first (docs/ops/apply-migration-067.sql). Safe to rerun.
BEGIN;
-- 068: agencies upload their own papers; approve with an exception; ETAA is
-- not a number; a preferred company for direct bookings (decided 1 Oct 2026).
--
-- ⚠️ Migrations do not run on deploy. Apply by hand, after 067:
--   npm run db:migrate, or docs/ops/apply-migration-068.sql in the Supabase SQL editor.
-- Rollback: server/db/down/schema_068_agency_documents.down.sql. Additive.
--
--   operator_documents.review_state   'approved' (counts), 'pending' (sent by the
--                                     agency, waiting for an admin), 'rejected'.
--                                     Everything already on file is approved.
--   operator_documents.kind           + commercial_registration, tax_card. The
--                                     ETAA document is no longer asked for:
--                                     every company with a Ministry of Tourism
--                                     license is an ETAA member, and ETAA has no
--                                     membership number. Old ETAA rows stay.
--   operators.activation_exception*   activated with papers missing, and why.
--   agencies.etaa_url                 the company's ETAA register entry, as a link
--                                     (replaces the "ETAA no." field).
--   agencies.direct_bookings_preferred
--                                     the company that runs direct bookings (at
--                                     most one). Replaces the DIRECT_BOOKINGS_OPERATOR
--                                     setting, which still applies when none is set.
--
-- One-time data changes (only the first time 068 is applied):
--   - a number entered as "ETAA registration/membership no." is the Ministry of
--     Tourism license number; it moves to the license field where that is empty;
--   - Capital Travel Service is a partner agency again (decided 1 Oct 2026):
--     preferred for direct bookings, listed on /partners, and its operator
--     record can be activated (053's block is lifted).

ALTER TABLE operator_documents ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE operator_documents ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE operator_documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE operator_documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE operator_documents ADD COLUMN IF NOT EXISTS submitted_via TEXT NOT NULL DEFAULT 'admin';

DO $$
DECLARE c RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_documents_review_state_chk') THEN
    ALTER TABLE operator_documents ADD CONSTRAINT operator_documents_review_state_chk
      CHECK (review_state IN ('approved', 'pending', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_documents_submitted_via_chk') THEN
    ALTER TABLE operator_documents ADD CONSTRAINT operator_documents_submitted_via_chk
      CHECK (submitted_via IN ('admin', 'agency'));
  END IF;
  -- 049's kind CHECK (inline, so named by Postgres) gives way to one with the new kinds.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'operator_documents'::regclass AND contype = 'c'
       AND conname <> 'operator_documents_kind_chk' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE operator_documents DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_documents_kind_chk') THEN
    ALTER TABLE operator_documents ADD CONSTRAINT operator_documents_kind_chk
      CHECK (kind IN ('tourism_license', 'commercial_registration', 'tax_card', 'liability_insurance', 'vehicle_insurance', 'etaa_membership'));
  END IF;
END $$;

-- One current APPROVED document per kind, and at most one waiting per kind.
DROP INDEX IF EXISTS uq_operator_documents_current;
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_documents_current
  ON operator_documents (operator_id, kind) WHERE superseded_at IS NULL AND review_state = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_documents_pending
  ON operator_documents (operator_id, kind) WHERE superseded_at IS NULL AND review_state = 'pending';

ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_exception TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_exception_kinds JSONB;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_exception_by TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_exception_at TIMESTAMPTZ;

-- The company's entry in the ETAA register, as a link an admin chose to publish
-- (ETAA has no member number; its register is looked up by the Ministry of
-- Tourism license number, so the link carries it, and publishing it stays an
-- admin's decision).
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS etaa_url TEXT;

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS direct_bookings_preferred BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agencies_direct_bookings_preferred
  ON agencies ((true)) WHERE direct_bookings_preferred;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE name = '068_agency_documents') THEN
    RETURN;
  END IF;

  -- The link the site already shows, kept exactly: built from the old field.
  UPDATE agencies SET etaa_url = 'https://www.etaa-egypt.org/SitePages/CompanyDetails.aspx?licc=' || btrim(etaa_registration_no)
   WHERE etaa_url IS NULL AND COALESCE(btrim(etaa_registration_no), '') <> '';
  UPDATE agencies SET tourism_license_no = btrim(etaa_registration_no)
   WHERE COALESCE(btrim(tourism_license_no), '') = '' AND COALESCE(btrim(etaa_registration_no), '') <> '';
  UPDATE operators SET tourism_license_no = btrim(etaa_no)
   WHERE COALESCE(btrim(tourism_license_no), '') = '' AND COALESCE(btrim(etaa_no), '') <> '';

  UPDATE agencies SET public_listed = true WHERE name = 'Capital Travel Service';
  IF NOT EXISTS (SELECT 1 FROM agencies WHERE direct_bookings_preferred) THEN
    UPDATE agencies SET direct_bookings_preferred = true WHERE name = 'Capital Travel Service';
  END IF;
  UPDATE operators SET activation_blocked = NULL
   WHERE activation_blocked LIKE 'Capital Travel Service is not involved in Sawa%';
END $$;
INSERT INTO schema_migrations (name) VALUES ('068_agency_documents') ON CONFLICT (name) DO NOTHING;
COMMIT;
