-- 025: somewhere to record the verification /verify says is performed.
--
-- ============================================================================
-- WHY
-- ============================================================================
--
-- MMM1 established that `agencies` holds five columns — id, name, contact_name,
-- phone, status — and one row, "adham", with no phone. No approved product is
-- attached to it.
--
-- Meanwhile /verify tells an operator, in the present tense:
--
--   "You'll need a current Ministry of Tourism license, ETAA registration,
--    valid insurance, and a track record we can check."
--   "We confirm it's active."
--   "01 Review — We confirm your documents with the Ministry — usually 2–4
--    business days."
--
-- **There is nowhere to put the answer to any of it.** The page describes a
-- process whose output the system cannot hold, which is why OOO3 concluded that
-- /verification-standard is blocked on the SCHEMA and not only on the client's
-- list of checks. Two blockers, not one.
--
-- The 023 argument applies again and more sharply: a verification performed and
-- unrecorded is unrecoverable the moment it is done. Nobody can reconstruct on
-- what date a licence was confirmed active, by whom, or against what evidence.
-- `agencies` holds ONE TEST ROW. This is the cheapest it will ever be; after
-- operators sign it is a migration *plus* going back to companies for documents
-- that should have been collected at onboarding.
--
-- ============================================================================
-- WHAT IS DELIBERATELY ABSENT
-- ============================================================================
--
-- **The payout account**, which is the fourth thing /verify asks for.
--
-- Same reasoning that kept payment schema out of 023: bank details and payout
-- methods encode a model in which Sawa holds and disburses funds, and legal
-- question 1 — whether Sawa may collect payment at all — is open. Schema is a
-- statement about what a system is designed to do. The other three of the four
-- are recorded here; the fourth waits for the answer.
--
-- Also absent: any column that duplicates `operator_applications`. That table
-- already holds the application (company, contact, city, email, phone, licence,
-- regions, about, status). This records the VERIFICATION OUTCOME on the
-- approved operator, which is a different fact at a different time.
--
-- ============================================================================
-- NOTHING WRITES TO THESE COLUMNS.
--
-- Adding a column and adding the code that fills it are separate changes;
-- shipping them together means a schema change and a behaviour change reviewed
-- as one piece. No route, job or script touches anything below.
--
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Idempotent — safe to re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The licence, and ETAA registration
--
-- /verify collapses these into one bullet ("A valid Egyptian tourism license")
-- but its own intro names them separately, and they are separate registrations
-- with separate numbers. One column each, or the site claims two things and the
-- record proves one.
--
-- EXPIRY is a column and not a note. "We confirm it's active" is a present-tense
-- claim, and a confirmation dated eighteen months ago against a licence that
-- lapsed since is not evidence for it. This is what lets a lapse be detected
-- rather than assumed away.
--
-- ⚠️ SUPERSEDED FOR THE LICENCE BY 035. The reasoning above is sound and the fact
-- was wrong: an Egyptian tourism licence does not expire, it has a registration
-- YEAR. `tourism_license_expires` is dropped and `tourism_license_year` replaces
-- it. The argument still holds for INSURANCE, which does expire annually, and
-- `insurance_expires` below is untouched.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS tourism_license_no      TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS tourism_license_expires DATE;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS etaa_registration_no    TEXT;


-- ---------------------------------------------------------------------------
-- 2. Insurance
--
-- /verify: "Proof of current cover for the tours you intend to run." Current is
-- the operative word, and it is the reason for the expiry column.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS insurance_insurer   TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS insurance_policy_no TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS insurance_expires   DATE;


-- ---------------------------------------------------------------------------
-- 3. Track record
--
-- /verify: "Two references or a portfolio of past tours — and links to any
-- existing reviews." Free text on purpose: a reference is a person and a
-- sentence, and a schema that demanded two rows of structured referees would be
-- describing a process nobody performs yet.
--
-- NOTE what this is NOT: a rating. There is no reviews table, nothing renders a
-- rating, and OOO2 removed the copy promising one. "Links to any existing
-- reviews" means reviews held ELSEWHERE, recorded as evidence for a human
-- decision — not a score this site publishes.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS track_record TEXT;


-- ---------------------------------------------------------------------------
-- 4. The write-time fields — the part that cannot be reconstructed
--
-- `verified_at` is a TIMESTAMP and not a boolean, for the ZZ2 reason: "never
-- verified" and "verified in March" are different claims and a boolean collapses
-- them into the same false comfort.
--
-- `verification_state` is NULLABLE WITH NO DEFAULT, deliberately. Three states
-- that must not collapse:
--
--   NULL        never assessed
--   'verified'  checked, and passed
--   'rejected'  checked, and failed
--   'lapsed'    was verified; a document has since expired
--
-- A DEFAULT of 'unverified' would turn every existing row into an assessment
-- nobody made — the same discipline as 023's marketing_consent and PP2's loud
-- zero.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS verified_at        TIMESTAMPTZ;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS verified_by        UUID;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS verification_state TEXT;

-- What was actually looked at. Without this the record says a check happened and
-- cannot say what it was performed against — which is the difference between a
-- verification and an assertion that one occurred.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS verification_evidence TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_verification_state_chk') THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_verification_state_chk
      CHECK (verification_state IS NULL
             OR verification_state IN ('verified', 'rejected', 'lapsed'));
  END IF;
END $$;

-- Finding the operators whose documents have run out, without scanning the
-- table. Small today; the query exists the day it is not.
CREATE INDEX IF NOT EXISTS idx_agencies_license_expires   ON agencies(tourism_license_expires);
CREATE INDEX IF NOT EXISTS idx_agencies_insurance_expires ON agencies(insurance_expires);
