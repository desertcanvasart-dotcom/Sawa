-- 049: operators, documents, roster, rate card, assignment and manifest
-- (model phase 2). No money moves: payouts and commissions come later.
--
-- ⚠️ Migrations do not run on deploy (B5):  DATABASE_URL=<production> npm run db:migrate
-- Rollback: server/db/down/schema_049_operators_roster_rates.down.sql
--
-- Additive. Existing tables gain nullable columns only, plus two widened
-- CHECKs on app_users (new operator roles) and one trigger on pledges that
-- can never fail a booking. With the catalogue_v2 flag off nothing here
-- reaches a traveler.

-- ===========================================================================
-- OPERATORS
-- ===========================================================================
-- The operator ROLE of a company. `agencies` stays the company record the
-- rest of the build knows (bookings, widget codes, the public operator record);
-- an operator row links to it when the company already exists there, so one
-- company that both sells and operates is one agencies row with an operator
-- row beside it (Operator Supply Agreement; Agency Reseller Agreement 1.2).
CREATE TABLE IF NOT EXISTS operators (
  id                          BIGSERIAL PRIMARY KEY,
  agency_id                   TEXT UNIQUE REFERENCES agencies(id) ON DELETE SET NULL,
  legal_name                  TEXT NOT NULL,
  trading_name                TEXT,
  tourism_license_no          TEXT,
  etaa_no                     TEXT,
  commercial_registration_no  TEXT,
  tax_registration_no         TEXT,
  email                       TEXT,
  whatsapp                    TEXT,                 -- stored; not used yet (notices are email + portal)
  phone                       TEXT,
  contacts                    JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contacts) = 'array'),
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
  status_reason               TEXT,
  status_changed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_by           TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tourism licence, ETAA membership, public liability and vehicle insurance.
-- One current document per kind; a replacement supersedes the old one, which
-- is kept for the record.
CREATE TABLE IF NOT EXISTS operator_documents (
  id             BIGSERIAL PRIMARY KEY,
  operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tourism_license', 'etaa_membership', 'liability_insurance', 'vehicle_insurance')),
  number         TEXT,
  expires_on     DATE NOT NULL,
  file_ref       TEXT,                              -- private storage key
  uploaded_by    TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_documents_current
  ON operator_documents (operator_id, kind) WHERE superseded_at IS NULL;

-- Expiry reminders, 30 and 7 days ahead: one row per document, lead time and
-- recipient, so the daily job never sends one twice.
CREATE TABLE IF NOT EXISTS operator_document_reminders (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES operator_documents(id) ON DELETE CASCADE,
  days_before  SMALLINT NOT NULL CHECK (days_before IN (30, 7)),
  recipient    TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, days_before, recipient)
);

-- The products an operator is approved to run.
CREATE TABLE IF NOT EXISTS operator_product_approvals (
  operator_id  BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, product_id)
);

-- Operator logins: two roles beside the existing four, tied to an operator.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS operator_id BIGINT REFERENCES operators(id) ON DELETE CASCADE;
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('super_admin', 'ops_staff', 'agency_owner', 'agency_agent', 'operator_owner', 'operator_staff'));
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS agency_required_for_agency_roles;
ALTER TABLE app_users ADD CONSTRAINT agency_required_for_agency_roles CHECK (
  (role IN ('super_admin', 'ops_staff') AND agency_id IS NULL AND operator_id IS NULL)
  OR (role IN ('agency_owner', 'agency_agent') AND agency_id IS NOT NULL AND operator_id IS NULL)
  OR (role IN ('operator_owner', 'operator_staff') AND agency_id IS NULL AND operator_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_app_users_operator ON app_users (operator_id);

-- Strikes (records only in this phase). A missed acknowledgement is recorded
-- by the system once per assignment; the other kinds are entered by an admin.
CREATE TABLE IF NOT EXISTS operator_strikes (
  id             BIGSERIAL PRIMARY KEY,
  operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  departure_id   BIGINT REFERENCES catalogue_departures(id) ON DELETE SET NULL,
  assignment_id  BIGINT,
  kind           TEXT NOT NULL CHECK (kind IN ('missed_acknowledgement', 'unapproved_substitution', 'shopping_stop', 'service_failure', 'other')),
  note           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      TEXT,
  void_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_strikes_missed_ack
  ON operator_strikes (assignment_id) WHERE kind = 'missed_acknowledgement';
CREATE INDEX IF NOT EXISTS idx_operator_strikes_operator ON operator_strikes (operator_id, created_at);

-- Portal notices for operators (assignment, reminders). Email is sent too;
-- `emailed_at` / `email_error` record what happened to it.
CREATE TABLE IF NOT EXISTS operator_notifications (
  id            BIGSERIAL PRIMARY KEY,
  operator_id   BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  departure_id  BIGINT REFERENCES catalogue_departures(id) ON DELETE SET NULL,
  dedupe_key    TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at       TIMESTAMPTZ,
  emailed_at    TIMESTAMPTZ,
  email_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_notifications_operator ON operator_notifications (operator_id, created_at DESC);

-- ===========================================================================
-- ROSTER
-- ===========================================================================
-- A month is planned (operator per product weekday), built into dated entries,
-- adjusted date by date, then published by the 15th of the previous month.
CREATE TABLE IF NOT EXISTS roster_months (
  month         TEXT PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  state         TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  published_at  TIMESTAMPTZ,
  published_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT roster_months_published_chk CHECK (state = 'draft' OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS roster_plan_lines (
  month        TEXT NOT NULL REFERENCES roster_months(month) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  operator_id  BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  PRIMARY KEY (month, product_id, weekday)
);

CREATE TABLE IF NOT EXISTS roster_entries (
  id           BIGSERIAL PRIMARY KEY,
  month        TEXT NOT NULL REFERENCES roster_months(month) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  operator_id  BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'plan' CHECK (source IN ('plan', 'override', 'swap')),
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_roster_entries_product_date UNIQUE (product_id, date),
  CONSTRAINT roster_entries_month_chk CHECK (to_char(date, 'YYYY-MM') = month)
);
CREATE INDEX IF NOT EXISTS idx_roster_entries_operator ON roster_entries (operator_id, date);

CREATE TABLE IF NOT EXISTS roster_swaps (
  id                BIGSERIAL PRIMARY KEY,
  entry_id          BIGINT NOT NULL REFERENCES roster_entries(id) ON DELETE CASCADE,
  from_operator_id  BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  to_operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  note              TEXT,
  requested_by      TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'approved', 'rejected', 'withdrawn')),
  decided_by        TEXT,
  decided_at        TIMESTAMPTZ,
  CONSTRAINT roster_swaps_other_chk CHECK (from_operator_id <> to_operator_id),
  CONSTRAINT roster_swaps_decided_chk CHECK (state IN ('requested', 'withdrawn') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_swaps_open ON roster_swaps (entry_id) WHERE state = 'requested';

-- ===========================================================================
-- RATE CARD (EGP)
-- ===========================================================================
-- Per product, versioned. Day and one-way tours: departure fee per band plus a
-- per-traveler amount. Cruises and multi-day: per-traveler land services, twin
-- and single room or cabin per trip, and departure fees per band. Agency
-- commission per seat is stored for the next phase. A published version never
-- changes.
CREATE TABLE IF NOT EXISTS catalogue_rate_versions (
  id                  BIGSERIAL PRIMARY KEY,
  product_id          BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL CHECK (version >= 1),
  state               TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  effective_from      DATE,
  currency            TEXT NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  per_traveler        NUMERIC(12,2) CHECK (per_traveler >= 0),
  fee_4_6             NUMERIC(12,2) CHECK (fee_4_6 >= 0),
  fee_7_9             NUMERIC(12,2) CHECK (fee_7_9 >= 0),
  fee_10_12           NUMERIC(12,2) CHECK (fee_10_12 >= 0),
  land_per_traveler   NUMERIC(12,2) CHECK (land_per_traveler >= 0),
  room_twin           NUMERIC(12,2) CHECK (room_twin >= 0),
  room_single         NUMERIC(12,2) CHECK (room_single >= 0),
  commission_per_seat NUMERIC(12,2) CHECK (commission_per_seat >= 0),
  source              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by        TEXT,
  published_at        TIMESTAMPTZ,
  UNIQUE (product_id, version),
  CONSTRAINT catalogue_rate_published_chk CHECK (state = 'draft' OR (effective_from IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_rate_one_draft ON catalogue_rate_versions (product_id) WHERE state = 'draft';

CREATE OR REPLACE FUNCTION catalogue_rate_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'catalogue_rate_versions %: a published rate version cannot be changed; create a new version', OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_catalogue_rate_immutable ON catalogue_rate_versions;
CREATE TRIGGER trg_catalogue_rate_immutable BEFORE UPDATE OR DELETE ON catalogue_rate_versions
  FOR EACH ROW EXECUTE FUNCTION catalogue_rate_immutable();

-- Nationality is collected only for products whose tickets need it.
ALTER TABLE catalogue_products ADD COLUMN IF NOT EXISTS needs_nationality BOOLEAN NOT NULL DEFAULT false;

-- The rate version a departure is locked to (set when its first seat sells).
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS rate_version_id BIGINT REFERENCES catalogue_rate_versions(id) ON DELETE RESTRICT;
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS rate_locked_at TIMESTAMPTZ;

-- ===========================================================================
-- ASSIGNMENT AND MANIFEST
-- ===========================================================================
CREATE TABLE IF NOT EXISTS catalogue_assignments (
  id                          BIGSERIAL PRIMARY KEY,
  departure_id                BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  operator_id                 BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  state                       TEXT NOT NULL DEFAULT 'offered'
                                CHECK (state IN ('offered', 'acknowledged', 'expired', 'replaced')),
  source                      TEXT NOT NULL CHECK (source IN ('roster', 'admin')),
  assigned_by                 TEXT,
  assigned_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_due_at                  TIMESTAMPTZ NOT NULL,
  acknowledged_at             TIMESTAMPTZ,
  acknowledged_by             TEXT,
  expired_at                  TIMESTAMPTZ,
  replaced_at                 TIMESTAMPTZ,
  manifest_access_revoked_at  TIMESTAMPTZ
);
-- One live assignment per departure.
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_assignments_live
  ON catalogue_assignments (departure_id) WHERE state IN ('offered', 'acknowledged');
CREATE INDEX IF NOT EXISTS idx_catalogue_assignments_operator ON catalogue_assignments (operator_id);
ALTER TABLE operator_strikes DROP CONSTRAINT IF EXISTS operator_strikes_assignment_fk;
ALTER TABLE operator_strikes ADD CONSTRAINT operator_strikes_assignment_fk
  FOREIGN KEY (assignment_id) REFERENCES catalogue_assignments(id) ON DELETE SET NULL;

-- What needs an admin: a GoAhead departure with nobody rostered, or an
-- acknowledgement that didn't come. Open until resolved.
CREATE TABLE IF NOT EXISTS catalogue_admin_alerts (
  id            BIGSERIAL PRIMARY KEY,
  departure_id  BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('no_rostered_operator', 'missed_acknowledgement')),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at    TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_admin_alerts_open
  ON catalogue_admin_alerts (departure_id, kind) WHERE resolved_at IS NULL;

-- The manifest as it stood at the cut-off. Before the cut-off the manifest is
-- read live from bookings; after it, this snapshot is the manifest (late
-- cancellations and no-shows still appear, as they still count).
CREATE TABLE IF NOT EXISTS catalogue_manifests (
  departure_id  BIGINT PRIMARY KEY REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  frozen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seat_count    INTEGER NOT NULL,
  travelers     JSONB NOT NULL,
  rooms         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Every time an operator opens a manifest.
CREATE TABLE IF NOT EXISTS manifest_access_log (
  id             BIGSERIAL PRIMARY KEY,
  departure_id   BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  user_id        UUID,
  user_email     TEXT,
  frozen         BOOLEAN NOT NULL,
  viewed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manifest_access_log_departure ON manifest_access_log (departure_id, viewed_at);

-- What a booking carries for the manifest (collected behind catalogue_v2,
-- optional). `traveller_names` (007) already exists and is reused for names.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS pickup_point TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS nationality TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS safety_needs TEXT;

-- ===========================================================================
-- LOCK AT FIRST SEAT
-- ===========================================================================
-- When a booking lands on a departure sold through the catalogue, the rate
-- version and specification in force are fixed on it (if not already). In the
-- same transaction as the booking, so there is no gap. A failure here must
-- never fail a booking: it is caught and raised as a warning, and the status
-- job stamps anything left unstamped.
CREATE OR REPLACE FUNCTION catalogue_lock_on_first_seat() RETURNS trigger AS $$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Cairo')::date;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  BEGIN
    UPDATE catalogue_departures cd
       SET rate_version_id = r.id, rate_locked_at = now()
      FROM (SELECT DISTINCT ON (product_id) id, product_id FROM catalogue_rate_versions
             WHERE state = 'published' AND effective_from <= today
             ORDER BY product_id, effective_from DESC, version DESC) r
     WHERE cd.legacy_departure_id = NEW.departure_id AND cd.rate_version_id IS NULL AND r.product_id = cd.product_id;
    UPDATE catalogue_departures cd
       SET spec_version_id = s.id
      FROM (SELECT DISTINCT ON (product_id) id, product_id FROM catalogue_spec_versions
             WHERE state = 'published' AND effective_from <= today
             ORDER BY product_id, effective_from DESC, version DESC) s
     WHERE cd.legacy_departure_id = NEW.departure_id AND cd.spec_version_id IS NULL AND s.product_id = cd.product_id;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'catalogue_lock_on_first_seat for departure %: %', NEW.departure_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_catalogue_lock_on_first_seat ON pledges;
CREATE TRIGGER trg_catalogue_lock_on_first_seat AFTER INSERT ON pledges
  FOR EACH ROW EXECUTE FUNCTION catalogue_lock_on_first_seat();

-- ===========================================================================
-- MAPPING EXISTING DATA
-- ===========================================================================
-- Companies already recorded as operators become operator rows, linked to
-- their agencies row and 'pending' until their four documents are uploaded:
--   - agencies.relationship = 'operator' (029/036);
--   - any agency named as a listing's operator (tour_products.agency_id, 013);
--   - Capital Travel Service, the operator of every direct booking so far
--     (brand.js DIRECT_BOOKINGS_OPERATOR). An operator like any other: no flag.
-- Licence and ETAA numbers and the contact are copied from the agencies row.
INSERT INTO operators (agency_id, legal_name, tourism_license_no, etaa_no, phone, contacts, status, status_reason)
SELECT a.id, a.name, a.tourism_license_no, a.etaa_registration_no, a.phone,
       CASE WHEN a.contact_name IS NOT NULL
            THEN jsonb_build_array(jsonb_build_object('name', a.contact_name, 'phone', a.phone)) ELSE '[]'::jsonb END,
       'pending', 'Created from the existing company record; documents to upload before activation.'
  FROM agencies a
 WHERE (a.relationship = 'operator'
        OR EXISTS (SELECT 1 FROM tour_products t WHERE t.agency_id = a.id)
        OR a.name = 'Capital Travel Service')
   AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.agency_id = a.id);

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_document_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_product_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_strikes ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_plan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_swaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_rate_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_admin_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_access_log ENABLE ROW LEVEL SECURITY;
