-- Migrations 050–061 in one transaction, for the Supabase SQL editor.
-- Generated from server/db/schema_050…061 (the same files npm run db:migrate runs).
-- Every file is safe to run again: db:migrate re-runs all of them on each run,
-- so anything already applied is left as it is. All or nothing: any error rolls back.
BEGIN;

-- ======================================================================== 050_settlements_commissions
-- Model phase 3: settlements and commissions. Records and statements for money
-- owed; nothing here moves money. Finance pays by bank transfer and records it.
--
-- Additive: new tables and new nullable or defaulted columns only. Existing
-- settlement tables (044–046) are untouched; legacy departures keep them.
-- Rollback: server/db/down/schema_050_settlements_commissions.down.sql.

-- ===========================================================================
-- A. Rate card: agency commission is EUR (the traveler currency). Operator
-- amounts stay EGP (the table's own `currency` column, 049).
-- ===========================================================================
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS commission_currency TEXT NOT NULL DEFAULT 'EUR';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalogue_rate_commission_eur') THEN
    ALTER TABLE catalogue_rate_versions ADD CONSTRAINT catalogue_rate_commission_eur CHECK (commission_currency = 'EUR');
  END IF;
END $$;

-- ===========================================================================
-- B. Booking completeness: a request to complete a booking's traveler
-- details, 7 days before, and a reminder at 3. Once each; the link's token is
-- stored hashed.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS booking_completion_requests (
  id            BIGSERIAL PRIMARY KEY,
  pledge_id     TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('request', 'reminder')),
  recipient     TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  missing       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_completion_once UNIQUE (pledge_id, kind)
);

-- ===========================================================================
-- C. Operator bank details. A change is a new row, pending until an admin
-- verifies it; only a verified row is used. Every view and change is logged.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS operator_bank_accounts (
  id              BIGSERIAL PRIMARY KEY,
  operator_id     BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  holder_name     TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  account_number  TEXT,
  iban            TEXT,
  swift           TEXT,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'verified', 'rejected', 'superseded')),
  submitted_by    TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  superseded_at   TIMESTAMPTZ,
  CONSTRAINT operator_bank_number_chk CHECK (account_number IS NOT NULL OR iban IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_bank_one_pending ON operator_bank_accounts (operator_id) WHERE state = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_bank_one_verified ON operator_bank_accounts (operator_id) WHERE state = 'verified';

CREATE TABLE IF NOT EXISTS operator_bank_access_log (
  id          BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  account_id  BIGINT REFERENCES operator_bank_accounts(id) ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK (action IN ('view', 'submit', 'verify', 'reject')),
  actor_id    UUID,
  actor_email TEXT,
  actor_role  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operator_bank_access_operator ON operator_bank_access_log (operator_id, at);

-- ===========================================================================
-- D. Operator settlement (catalog departures only).
-- ===========================================================================
-- Egyptian public holidays, for "2 business days" (Sun–Thu, not a holiday).
CREATE TABLE IF NOT EXISTS egypt_holidays (
  day         DATE PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EGP per 1 EUR, entered by admin. No external source is called.
CREATE TABLE IF NOT EXISTS fx_rates (
  day          DATE PRIMARY KEY,
  egp_per_eur  NUMERIC(12,4) NOT NULL CHECK (egp_per_eur > 0),
  source_note  TEXT,
  entered_by   TEXT,
  entered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operator Schedule 6: configurable, 0 until set.
CREATE TABLE IF NOT EXISTS operator_penalty_rates (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  clause_ref  TEXT NOT NULL,
  per_traveler BOOLEAN NOT NULL DEFAULT false,
  amount_egp  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_egp >= 0),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO operator_penalty_rates (code, label, clause_ref, per_traveler) VALUES
  ('cancel_over_48h', 'Operator cancels an assigned departure more than 48 hours before', 'Operator Schedule 6; clause 11', false),
  ('cancel_within_48h', 'Operator cancels an assigned departure within 48 hours', 'Operator Schedule 6; clause 11', false),
  ('no_show', 'Operator fails to turn up', 'Operator Schedule 6; clause 11', false),
  ('off_platform_rebooking', 'Off-platform rebooking of a solicited traveler', 'Operator Schedule 6', true)
ON CONFLICT (code) DO NOTHING;

-- An amount owed to an operator: the advance (50% at acknowledgement) or the
-- balance (after the departure). EGP only.
CREATE TABLE IF NOT EXISTS operator_payables (
  id             BIGSERIAL PRIMARY KEY,
  departure_id   BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  operator_id    BIGINT NOT NULL REFERENCES operators(id),
  assignment_id  BIGINT REFERENCES catalogue_assignments(id),
  kind           TEXT NOT NULL CHECK (kind IN ('advance', 'balance')),
  currency       TEXT NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  amount         NUMERIC(12,2),
  due_on         DATE,
  -- 'offset': nothing left to transfer: fully set off against what the
  -- operator owes Sawa, or a balance of zero or less (then a receivable).
  state          TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due', 'on_hold', 'paid', 'offset', 'cancelled')),
  setoff_egp     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (setoff_egp >= 0),
  hold_reason    TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at        TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_advance_once ON operator_payables (assignment_id) WHERE kind = 'advance';
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_balance_once ON operator_payables (departure_id) WHERE kind = 'balance' AND state <> 'cancelled';

-- Penalties, service-failure deductions and force-majeure reimbursements.
-- Deductions (penalty + service_failure) are capped at the departure's
-- operator amount. A reimbursement points at approved lines on the existing
-- cost sheet (departure_costs), where the receipts are.
CREATE TABLE IF NOT EXISTS operator_adjustments (
  id             BIGSERIAL PRIMARY KEY,
  departure_id   BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  operator_id    BIGINT NOT NULL REFERENCES operators(id),
  kind           TEXT NOT NULL CHECK (kind IN ('penalty', 'service_failure', 'reimbursement')),
  penalty_code   TEXT REFERENCES operator_penalty_rates(code),
  amount_egp     NUMERIC(12,2) NOT NULL CHECK (amount_egp >= 0),
  reason         TEXT NOT NULL,
  clause_ref     TEXT NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_line_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      TEXT,
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_adjustments_departure ON operator_adjustments (departure_id);

-- What an operator owes Sawa (Operator Supply Agreement 9.4: set-off): a
-- negative balance, an advance on a departure taken away from it, or a
-- penalty on one. Recovered automatically from its next advances and
-- balances (operator_setoffs), or by a payment finance records.
CREATE TABLE IF NOT EXISTS operator_receivables (
  id                    BIGSERIAL PRIMARY KEY,
  operator_id           BIGINT NOT NULL REFERENCES operators(id),
  departure_id          BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  source                TEXT NOT NULL CHECK (source IN ('negative_balance', 'reassignment_advance', 'penalty')),
  source_payable_id     BIGINT REFERENCES operator_payables(id),
  source_adjustment_id  BIGINT REFERENCES operator_adjustments(id),
  amount_egp            NUMERIC(12,2) NOT NULL CHECK (amount_egp > 0),
  outstanding_egp       NUMERIC(12,2) NOT NULL CHECK (outstanding_egp >= 0),
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled', 'cancelled')),
  reason                TEXT NOT NULL,
  clause_ref            TEXT NOT NULL DEFAULT 'Operator 9.4',
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at            TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operator_receivable_balance ON operator_receivables (source_payable_id)
  WHERE source = 'negative_balance' AND state <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_operator_receivables_open ON operator_receivables (operator_id) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS operator_setoffs (
  id             BIGSERIAL PRIMARY KEY,
  receivable_id  BIGINT NOT NULL REFERENCES operator_receivables(id) ON DELETE CASCADE,
  payable_id     BIGINT NOT NULL REFERENCES operator_payables(id) ON DELETE CASCADE,
  amount_egp     NUMERIC(12,2) NOT NULL CHECK (amount_egp > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_operator_setoffs_payable ON operator_setoffs (payable_id) WHERE released_at IS NULL;

-- Why a departure was taken from an operator after its advance was paid.
ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS replaced_reason TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalogue_assignments_replaced_reason_chk') THEN
    ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_replaced_reason_chk
      CHECK (replaced_reason IS NULL OR replaced_reason IN ('operator_fault', 'not_operator_fault'));
  END IF;
END $$;

-- The settlement statement per departure.
CREATE TABLE IF NOT EXISTS settlement_statements (
  id               BIGSERIAL PRIMARY KEY,
  departure_id     BIGINT NOT NULL UNIQUE REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  operator_id      BIGINT NOT NULL REFERENCES operators(id),
  state            TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sent', 'accepted', 'disputed', 'resolved')),
  snapshot         JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  sent_by          TEXT,
  accepted_at      TIMESTAMPTZ,
  auto_accepted    BOOLEAN NOT NULL DEFAULT false,
  dispute_reason   TEXT,
  disputed_at      TIMESTAMPTZ,
  disputed_by      TEXT,
  resolution_note  TEXT,
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT
);

-- ===========================================================================
-- E. Agency commission and billing.
-- ===========================================================================
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS billing_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS billing_due_days SMALLINT NOT NULL DEFAULT 14;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agencies_billing_due_days_chk') THEN
    ALTER TABLE agencies ADD CONSTRAINT agencies_billing_due_days_chk CHECK (billing_due_days BETWEEN 0 AND 120);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS commission_statements (
  id           BIGSERIAL PRIMARY KEY,
  agency_id    TEXT NOT NULL REFERENCES agencies(id),
  period       TEXT NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  state        TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sent', 'paid')),
  currency     TEXT NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR', 'EGP')),
  total_eur    NUMERIC(12,2) NOT NULL DEFAULT 0,
  fx_day       DATE,
  egp_per_eur  NUMERIC(12,4),
  total_egp    NUMERIC(14,2),
  lines        JSONB NOT NULL DEFAULT '[]'::jsonb,
  hold_reason  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  emailed_to   TEXT,
  paid_at      TIMESTAMPTZ,
  CONSTRAINT uq_commission_statement UNIQUE (agency_id, period)
);

-- Commission per agency booking, locked at booking from the rate version in
-- force (EUR per seat). Decided when the departure completes or is canceled.
CREATE TABLE IF NOT EXISTS agency_commissions (
  pledge_id        TEXT PRIMARY KEY REFERENCES pledges(id) ON DELETE CASCADE,
  agency_id        TEXT NOT NULL REFERENCES agencies(id),
  departure_id     BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  rate_version_id  BIGINT REFERENCES catalogue_rate_versions(id),
  seats            INT NOT NULL CHECK (seats > 0),
  per_seat_eur     NUMERIC(10,2),
  amount_eur       NUMERIC(12,2),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'earned', 'half', 'void')),
  earned_eur       NUMERIC(12,2),
  state_reason     TEXT,
  locked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  statement_id     BIGINT REFERENCES commission_statements(id)
);
CREATE INDEX IF NOT EXISTS idx_agency_commissions_agency ON agency_commissions (agency_id, state);

-- Agency billing (approved agencies): the agency is invoiced for the published
-- price less its commission. The seat counts toward GoAhead from booking.
CREATE TABLE IF NOT EXISTS agency_invoices (
  id              BIGSERIAL PRIMARY KEY,
  pledge_id       TEXT NOT NULL UNIQUE REFERENCES pledges(id) ON DELETE CASCADE,
  agency_id       TEXT NOT NULL REFERENCES agencies(id),
  departure_id    BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  currency        TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  gross_eur       NUMERIC(12,2) NOT NULL,
  commission_eur  NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_eur      NUMERIC(12,2) NOT NULL,
  due_on          DATE NOT NULL,
  state           TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due', 'paid', 'void')),
  void_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

-- ===========================================================================
-- Payments finance records (bank transfers made or received). One table for
-- operator advances and balances, agency commission statements and agency
-- invoices.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS finance_payments (
  id               BIGSERIAL PRIMARY KEY,
  payable_kind     TEXT NOT NULL CHECK (payable_kind IN ('operator_payable', 'commission_statement', 'agency_invoice', 'operator_receivable')),
  payable_id       BIGINT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  currency         TEXT NOT NULL CHECK (currency IN ('EGP', 'EUR')),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  due_amount       NUMERIC(14,2),
  differs          BOOLEAN NOT NULL DEFAULT false,
  paid_on          DATE NOT NULL,
  bank_reference   TEXT NOT NULL,
  bank_account_id  BIGINT REFERENCES operator_bank_accounts(id),
  override_by      TEXT,
  override_reason  TEXT,
  recorded_by      TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One payment per item, except a receivable, which an operator may repay in parts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_payment_once ON finance_payments (payable_kind, payable_id)
  WHERE payable_kind <> 'operator_receivable';

-- Payment provider fees, for the margin report. Not set until finance sets it.
CREATE TABLE IF NOT EXISTS finance_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every table here is read and written by the server only (as 024 set for
-- the Data API): RLS on, no policies.
ALTER TABLE booking_completion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_bank_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE egypt_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_penalty_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_payables ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_setoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_settings ENABLE ROW LEVEL SECURITY;


INSERT INTO schema_migrations (name) VALUES ('050_settlements_commissions') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 051_pay_at_goahead
-- 051: pay at GoAhead ("mode C", model phase 4), catalog departures only,
-- behind catalogue_v2. docs/phase4/payments-readiness.md section 9 is the
-- design; docs/phase4/REPORT.md says what was built.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 047–050:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_051_pay_at_goahead.down.sql. Additive: new
-- tables, new nullable or defaulted columns, one widened CHECK, and one NOT
-- NULL relaxed (agency_invoices.due_on). Nothing existing is rewritten.
--
-- ============================================================================
-- WHAT THIS ADDS
-- ============================================================================
--
--   cancellation_tier_versions  the cancellation tiers, versioned with an
--   cancellation_tiers          effective date; a published version never
--                               changes. Seeded with today's schedule.
--   pledges.*                   the payment mode, and the tier version a
--                               booking was made under
--   payment_requests            one full-price request per booking at GoAhead
--   payment_refunds             refunds under the tiers (full price × retained %)
--   payment_tasks               work for ops while the provider is manual (Tab)
--   departure_waitlist          travelers waiting for a seat on a full departure

-- ---------------------------------------------------------------------------
-- Cancellation tiers. A version holds the rows for every product type, so a
-- booking stores one version id and reads its product type's rows from it.
CREATE TABLE IF NOT EXISTS cancellation_tier_versions (
  id              BIGSERIAL PRIMARY KEY,
  version         INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  state           TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  effective_from  DATE,
  note            TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by    TEXT,
  published_at    TIMESTAMPTZ,
  CONSTRAINT cancellation_tier_published_chk
    CHECK (state = 'draft' OR (effective_from IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_tier_one_draft
  ON cancellation_tier_versions ((state)) WHERE state = 'draft';

-- A row: from `min_before_hours` before the start (inclusive) up to the next
-- row's, the retained percentage of the full price. 0 = right up to the start,
-- and no-show. `unit` records how the row was entered, so "30 days" reopens as
-- 30 days and not 720 hours (the 038 cut-off pattern).
CREATE TABLE IF NOT EXISTS cancellation_tiers (
  id                BIGSERIAL PRIMARY KEY,
  version_id        BIGINT NOT NULL REFERENCES cancellation_tier_versions(id) ON DELETE CASCADE,
  product_type      TEXT NOT NULL CHECK (product_type IN ('day_tour', 'one_way_road_tour', 'cruise', 'multi_day')),
  min_before_hours  INTEGER NOT NULL CHECK (min_before_hours >= 0),
  unit              TEXT NOT NULL DEFAULT 'hours' CHECK (unit IN ('hours', 'days')),
  retained_pct      NUMERIC(5,2) NOT NULL CHECK (retained_pct >= 0 AND retained_pct <= 100),
  CONSTRAINT cancellation_tiers_days_chk CHECK (unit = 'hours' OR min_before_hours % 24 = 0),
  UNIQUE (version_id, product_type, min_before_hours)
);

-- A published version (and its rows) is fixed for good: bookings hold its id.
CREATE OR REPLACE FUNCTION cancellation_tiers_immutable() RETURNS trigger AS $$
DECLARE
  v_state TEXT;
BEGIN
  IF TG_TABLE_NAME = 'cancellation_tier_versions' THEN
    IF OLD.state = 'published' THEN
      RAISE EXCEPTION 'cancellation tier version %: a published version cannot be changed; create a new version', OLD.version;
    END IF;
  ELSE
    SELECT state INTO v_state FROM cancellation_tier_versions
     WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
    IF v_state = 'published' THEN
      RAISE EXCEPTION 'cancellation tiers: the version is published and cannot be changed; create a new version';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cancellation_tier_versions_immutable ON cancellation_tier_versions;
CREATE TRIGGER trg_cancellation_tier_versions_immutable
  BEFORE UPDATE OR DELETE ON cancellation_tier_versions
  FOR EACH ROW EXECUTE FUNCTION cancellation_tiers_immutable();
DROP TRIGGER IF EXISTS trg_cancellation_tiers_immutable ON cancellation_tiers;
CREATE TRIGGER trg_cancellation_tiers_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON cancellation_tiers
  FOR EACH ROW EXECUTE FUNCTION cancellation_tiers_immutable();

-- Seed: version 1, today's schedule as a retained percentage of the full
-- price (section 9.3). Effective from 2026-01-01, before any catalog booking.
-- Create-only: inserted as a draft, filled, then published.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cancellation_tier_versions WHERE version = 1) THEN
    INSERT INTO cancellation_tier_versions (version, state, note, created_by)
      VALUES (1, 'draft', 'Seeded by migration 051 from the schedule in force (docs/phase4/payments-readiness.md 9.3).', 'migration 051')
      RETURNING id INTO v_id;
    INSERT INTO cancellation_tiers (version_id, product_type, min_before_hours, unit, retained_pct) VALUES
      (v_id, 'day_tour',          48,  'hours', 0),
      (v_id, 'day_tour',          0,   'hours', 10),
      (v_id, 'one_way_road_tour', 48,  'hours', 0),
      (v_id, 'one_way_road_tour', 0,   'hours', 10),
      (v_id, 'cruise',            720, 'days',  0),
      (v_id, 'cruise',            360, 'days',  12.5),
      (v_id, 'cruise',            0,   'days',  25),
      (v_id, 'multi_day',         720, 'days',  0),
      (v_id, 'multi_day',         360, 'days',  12.5),
      (v_id, 'multi_day',         0,   'days',  25);
    UPDATE cancellation_tier_versions
       SET state = 'published', effective_from = DATE '2026-01-01', published_at = now(), published_by = 'migration 051'
     WHERE id = v_id;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Bookings. Every existing booking is legacy (deposit and balance links).
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'legacy_link';
-- The tier version the booking was made under, and when that was fixed:
-- a direct traveler accepting the Terms at booking, or an agency booking
-- (Agency Reseller Agreement 4.2: the agency shows its client the terms
-- before booking). The traveler's later acceptance of that same version is
-- recorded separately.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cancellation_tier_version_id BIGINT REFERENCES cancellation_tier_versions(id) ON DELETE RESTRICT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS terms_fixed_at TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS terms_fixed_by TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS traveller_terms_accepted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_payment_mode_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_payment_mode_chk CHECK (payment_mode IN ('legacy_link', 'pay_at_goahead'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_terms_fixed_by_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_terms_fixed_by_chk CHECK (terms_fixed_by IS NULL OR terms_fixed_by IN ('traveller', 'agency'));
  END IF;
  -- A pay-at-GoAhead booking always carries its tier version.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_pay_at_goahead_terms_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_pay_at_goahead_terms_chk
      CHECK (payment_mode <> 'pay_at_goahead' OR (cancellation_tier_version_id IS NOT NULL AND terms_fixed_at IS NOT NULL AND terms_fixed_by IS NOT NULL));
  END IF;
  -- 'unpaid': a seat released at its payment deadline (clause 10.1).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pledges_cancelled_reason_chk' AND pg_get_constraintdef(oid) LIKE '%unpaid%'
  ) THEN
    ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_cancelled_reason_chk;
    ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
      CHECK (cancelled_reason IS NULL OR cancelled_reason IN
        ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator', 'unpaid'));
  END IF;
END $$;

-- An agency-billed invoice is due at the payment deadline after GoAhead, so
-- until then it has no due date.
ALTER TABLE agency_invoices ALTER COLUMN due_on DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- One full-price request per booking. `provider` is the adapter that handles
-- it (server/payment-providers/): 'tab-manual' today.
--
--   awaiting_link  created at GoAhead; the provider has no link yet (manual)
--   sent           the link is out; `due_at` is the deadline
--   paid           recorded paid, with the provider's reference
--   released       unpaid at the deadline: the seat was released (clause 10.1)
--   cancelled      the booking was canceled before payment
CREATE TABLE IF NOT EXISTS payment_requests (
  id                  BIGSERIAL PRIMARY KEY,
  pledge_id           TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id        BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  payer               TEXT NOT NULL CHECK (payer IN ('traveller', 'agency')),
  amount_eur          NUMERIC(10,2) NOT NULL CHECK (amount_eur > 0),
  currency            TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  reference           TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'awaiting_link'
                        CHECK (state IN ('awaiting_link', 'sent', 'paid', 'released', 'cancelled')),
  link_url            TEXT,
  link_sent_at        TIMESTAMPTZ,
  emailed_to          TEXT,
  due_at              TIMESTAMPTZ,
  due_bound_by        TEXT CHECK (due_bound_by IN ('window', 'cutoff', 'minimum')),
  -- The deadline first set is kept; an extension is recorded beside it.
  original_due_at     TIMESTAMPTZ,
  extended_at         TIMESTAMPTZ,
  extended_by         TEXT,
  extend_reason       TEXT,
  ops_notified_at     TIMESTAMPTZ,
  reminder_sent_at    TIMESTAMPTZ,
  release_warned_at   TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  provider_reference  TEXT,
  recorded_by         TEXT,
  released_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_requests_sent_chk
    CHECK (state NOT IN ('sent', 'released') OR (link_url IS NOT NULL AND link_sent_at IS NOT NULL AND due_at IS NOT NULL AND original_due_at IS NOT NULL)),
  CONSTRAINT payment_requests_paid_chk CHECK (state <> 'paid' OR (paid_at IS NOT NULL AND provider_reference IS NOT NULL)),
  CONSTRAINT payment_requests_released_chk CHECK (state <> 'released' OR released_at IS NOT NULL),
  CONSTRAINT payment_requests_extended_chk
    CHECK (extended_at IS NULL OR (extended_by IS NOT NULL AND length(trim(coalesce(extend_reason, ''))) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_live
  ON payment_requests (pledge_id) WHERE state IN ('awaiting_link', 'sent', 'paid');
CREATE INDEX IF NOT EXISTS idx_payment_requests_departure ON payment_requests (departure_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_open_due ON payment_requests (due_at) WHERE state = 'sent';

-- Refunds under the tiers. `cancellation`: what was paid less the fee kept
-- (full price × retained %). `resale`: the fee returned when a waitlisted
-- traveler took the seat before the cut-off.
CREATE TABLE IF NOT EXISTS payment_refunds (
  id                  BIGSERIAL PRIMARY KEY,
  request_id          BIGINT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  pledge_id           TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('cancellation', 'resale')),
  paid_eur            NUMERIC(10,2) NOT NULL CHECK (paid_eur >= 0),
  retained_pct        NUMERIC(5,2) NOT NULL CHECK (retained_pct >= 0 AND retained_pct <= 100),
  fee_retained_eur    NUMERIC(10,2) NOT NULL CHECK (fee_retained_eur >= 0),
  amount_eur          NUMERIC(10,2) NOT NULL CHECK (amount_eur >= 0),
  tier_version_id     BIGINT REFERENCES cancellation_tier_versions(id) ON DELETE RESTRICT,
  hours_before        INTEGER,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'cancelled')),
  provider_reference  TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at             TIMESTAMPTZ,
  done_by             TEXT,
  CONSTRAINT payment_refunds_done_chk CHECK (state <> 'done' OR (done_at IS NOT NULL AND provider_reference IS NOT NULL))
);
-- One cancellation refund per payment; a resale may come in parts (each
-- waitlisted party that takes some of the seats returns its share of the fee).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_refunds_cancellation ON payment_refunds (request_id) WHERE state <> 'cancelled' AND kind = 'cancellation';

-- Work for ops while the provider is manual. A provider with an API creates
-- none of these; the booking logic is the same either way.
CREATE TABLE IF NOT EXISTS payment_tasks (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('create_link', 'issue_refund')),
  provider     TEXT NOT NULL,
  request_id   BIGINT REFERENCES payment_requests(id) ON DELETE CASCADE,
  refund_id    BIGINT REFERENCES payment_refunds(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'cancelled')),
  title        TEXT NOT NULL,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at      TIMESTAMPTZ,
  done_by      TEXT,
  CONSTRAINT payment_tasks_target_chk CHECK (
    (kind = 'create_link' AND request_id IS NOT NULL) OR (kind = 'issue_refund' AND refund_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tasks_link ON payment_tasks (request_id) WHERE kind = 'create_link';
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tasks_refund ON payment_tasks (refund_id) WHERE kind = 'issue_refund';
CREATE INDEX IF NOT EXISTS idx_payment_tasks_open ON payment_tasks (created_at) WHERE state = 'open';

-- ---------------------------------------------------------------------------
-- The waitlist for a full departure. An offer holds the seats for a set time
-- (capped at the cut-off); if it isn't taken, the next traveler is offered.
-- `source_pledge_id` is the booking whose seat was freed, so a resale before
-- the cut-off can return that traveler's retained fee.
CREATE TABLE IF NOT EXISTS departure_waitlist (
  id                 BIGSERIAL PRIMARY KEY,
  departure_id       BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  seats              SMALLINT NOT NULL CHECK (seats BETWEEN 1 AND 12),
  details            JSONB NOT NULL DEFAULT '{}'::jsonb,
  state              TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'offered', 'booked', 'expired', 'withdrawn')),
  offered_at         TIMESTAMPTZ,
  offer_expires_at   TIMESTAMPTZ,
  offer_token_hash   TEXT UNIQUE,
  source_pledge_id   TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  booked_pledge_id   TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT departure_waitlist_offer_chk
    CHECK (state NOT IN ('offered', 'booked') OR (offered_at IS NOT NULL AND offer_expires_at IS NOT NULL AND offer_token_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_departure_waitlist_queue ON departure_waitlist (departure_id, created_at, id) WHERE state IN ('waiting', 'offered');

-- The payment window and the waitlist hold, in hours. Finance may change them.
INSERT INTO finance_settings (key, value, updated_by)
VALUES ('pay_at_goahead', '{"windowHours": 48, "offerHours": 12}'::jsonb, 'migration 051')
ON CONFLICT (key) DO NOTHING;

-- Server-only tables (as 024 set for the Data API): RLS on, no policies.
ALTER TABLE cancellation_tier_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellation_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE departure_waitlist ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('051_pay_at_goahead') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 052_pay_safeguards_terms
-- 052: pay-at-GoAhead safeguards and versioned Terms (model phase 4, follow-up).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 051:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_052_pay_safeguards_terms.down.sql. Additive:
-- new columns, one new table, two widened CHECKs.
--
-- ============================================================================
-- WHAT THIS ADDS
-- ============================================================================
--
--   A seat whose Tab link was never made is not released (the traveler did
--   nothing wrong), so the gap is made loud instead:
--     - alerts to ops and admin 6 and 12 hours after GoAhead;
--     - 24 hours before the cut-off, an admin decision, with a reason:
--         short_link        send the link now, with a short deadline
--         travel_unsecured  let the traveler travel and collect later
--         cancel            cancel, nothing charged, with an apology
--   A link made so late that the traveler would have under 12 hours starts no
--   deadline: the seat goes to the same decision.
--
--   terms_versions  the Terms, versioned like the cancellation tiers, one
--                   series for catalog bookings and one for legacy bookings;
--                   each booking records the version it accepted.

-- ---------------------------------------------------------------------------
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS link_alert_6h_at TIMESTAMPTZ;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS link_alert_12h_at TIMESTAMPTZ;
-- Why the seat needs an admin decision, and since when.
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decision_needed TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decision_needed_at TIMESTAMPTZ;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decision TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_requests_decision_needed_chk') THEN
    ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_decision_needed_chk
      CHECK (decision_needed IS NULL OR (decision_needed IN ('no_link', 'late_link') AND decision_needed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_requests_decision_chk') THEN
    ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_decision_chk
      CHECK (decision IS NULL OR (decision IN ('short_link', 'travel_unsecured', 'cancel')
        AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND length(trim(coalesce(decision_reason, ''))) > 0));
  END IF;
  -- 'unsecured': the traveler travels unpaid, collected later (an admin decision).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_requests_state_chk2') THEN
    ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_state_check;
    ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_state_chk2
      CHECK (state IN ('awaiting_link', 'sent', 'paid', 'released', 'cancelled', 'unsecured'));
  END IF;
  -- 'decision': a short deadline set by an admin decision.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_requests_bound_chk2') THEN
    ALTER TABLE payment_requests DROP CONSTRAINT IF EXISTS payment_requests_due_bound_by_check;
    ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_bound_chk2
      CHECK (due_bound_by IS NULL OR due_bound_by IN ('window', 'cutoff', 'minimum', 'decision'));
  END IF;
END $$;

-- An unsecured seat is still a live request: one per booking.
DROP INDEX IF EXISTS uq_payment_requests_live;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_requests_live
  ON payment_requests (pledge_id) WHERE state IN ('awaiting_link', 'sent', 'paid', 'unsecured');

-- ---------------------------------------------------------------------------
-- The Terms, versioned. `scope`: catalog bookings and legacy bookings each
-- have their own series. A published version never changes; the text lives
-- at `document_url` (and, once approved, in `body`).
CREATE TABLE IF NOT EXISTS terms_versions (
  id              BIGSERIAL PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('catalogue', 'legacy')),
  version         INTEGER NOT NULL CHECK (version >= 1),
  state           TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  effective_from  DATE,
  title           TEXT NOT NULL,
  document_url    TEXT NOT NULL,
  body            TEXT,
  note            TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by    TEXT,
  published_at    TIMESTAMPTZ,
  UNIQUE (scope, version),
  CONSTRAINT terms_versions_published_chk
    CHECK (state = 'draft' OR (effective_from IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_terms_versions_one_draft ON terms_versions (scope) WHERE state = 'draft';

CREATE OR REPLACE FUNCTION terms_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'terms version % (%): a published version cannot be changed; create a new version', OLD.version, OLD.scope;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_terms_versions_immutable ON terms_versions;
CREATE TRIGGER trg_terms_versions_immutable
  BEFORE UPDATE OR DELETE ON terms_versions
  FOR EACH ROW EXECUTE FUNCTION terms_versions_immutable();

-- Seed: version 1 of each series is the Terms published today at /terms. The
-- catalog wording (docs/legal/terms-catalogue-draft.md) awaits the lawyer; it
-- becomes catalogue version 2 when approved.
INSERT INTO terms_versions (scope, version, state, effective_from, title, document_url, note, created_by, published_by, published_at)
VALUES
  ('legacy', 1, 'published', DATE '2026-01-01', 'Terms and Conditions', '/terms',
   'The Terms at /terms when migration 052 was applied.', 'migration 052', 'migration 052', now()),
  ('catalogue', 1, 'published', DATE '2026-01-01', 'Terms and Conditions', '/terms',
   'The Terms at /terms when migration 052 was applied. The catalog wording awaits the lawyer (docs/legal/terms-catalogue-draft.md).',
   'migration 052', 'migration 052', now())
ON CONFLICT (scope, version) DO NOTHING;

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS terms_version_id BIGINT REFERENCES terms_versions(id) ON DELETE RESTRICT;

ALTER TABLE terms_versions ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('052_pay_safeguards_terms') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 053_seller_disclosure
-- 053: the seller of a catalog departure, and Online Era as collecting agent
-- (decided 27 Sep 2026), behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 052.
-- Rollback: server/db/down/schema_053_seller_disclosure.down.sql. Additive.
--
-- The operator assigned at GoAhead is the seller of each departure; Online
-- Era (Commercial Registration 148500) is its commercial and payment-
-- collection agent. From the assignment, the payment request, receipt,
-- voucher and booking page name the operator's legal name and the licence
-- number shown to travelers, and the collecting agent as payee.
--
--   operators.traveller_licence_no   the licence number shown to travelers
--   operators.activation_blocked     a record that must never be activated
--   payment_requests.seller_* / receipt_*
--                                    who the current receipt names
--   payment_receipts                 every receipt issued, the original kept
--                                    and marked superseded when reissued
--   seller_change_offers             a paid traveler's right to cancel with a
--                                    full refund, 48 hours, when the seller
--                                    changes after payment
--
-- The seller is named only once the operator has acknowledged the assignment,
-- and payment requests go out only then (decided 27 Sep 2026).

ALTER TABLE operators ADD COLUMN IF NOT EXISTS traveller_licence_no TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_blocked TEXT;

-- Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). The
-- operator record 049 creates for it stays pending and can't be activated.
-- Superseded by 068 (1 Oct 2026): once 068 is applied this no longer re-blocks CTS.
UPDATE operators SET activation_blocked = 'Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). This record must stay pending and must not be activated.'
 WHERE legal_name ILIKE 'capital travel%' AND activation_blocked IS NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '068_agency_documents');

ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_operator_id BIGINT REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_legal_name TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_licence_no TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_no TEXT UNIQUE;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_issued_at TIMESTAMPTZ;

-- Every receipt: the first when the payment is recorded, and a new one when a
-- replacement operator acknowledges after the traveler paid. The original is
-- kept, marked superseded, and points at the receipt that replaced it.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id                  BIGSERIAL PRIMARY KEY,
  request_id          BIGINT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  receipt_no          TEXT NOT NULL UNIQUE,
  seller_operator_id  BIGINT REFERENCES operators(id) ON DELETE SET NULL,
  seller_legal_name   TEXT,
  seller_licence_no   TEXT,
  amount_eur          NUMERIC(10,2) NOT NULL CHECK (amount_eur >= 0),
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at       TIMESTAMPTZ,
  superseded_by       BIGINT REFERENCES payment_receipts(id) ON DELETE SET NULL,
  supersede_reason    TEXT,
  CONSTRAINT payment_receipts_superseded_chk CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipts_current ON payment_receipts (request_id) WHERE superseded_at IS NULL;

-- The seller changed after the traveler paid: they may cancel with a full
-- refund within 48 hours of being told (never past the start).
CREATE TABLE IF NOT EXISTS seller_change_offers (
  id                BIGSERIAL PRIMARY KEY,
  request_id        BIGINT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  pledge_id         TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id      BIGINT NOT NULL,
  from_operator_id  BIGINT REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  receipt_id        BIGINT REFERENCES payment_receipts(id) ON DELETE SET NULL,
  offered_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  state             TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'expired', 'void')),
  accepted_at       TIMESTAMPTZ,
  refund_id         BIGINT REFERENCES payment_refunds(id) ON DELETE SET NULL,
  emailed_to        TEXT,
  CONSTRAINT seller_change_offers_accepted_chk CHECK (state <> 'accepted' OR accepted_at IS NOT NULL),
  UNIQUE (request_id, to_operator_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_change_offers_open ON seller_change_offers (expires_at) WHERE state = 'open';

-- Server-only tables (as 024 set for the Data API): RLS on, no policies.
ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_change_offers ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('053_seller_disclosure') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 054_partner_listing
-- 054: whether an operator record is shown to travelers (live site, not
-- behind catalogue_v2).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_054_partner_listing.down.sql. Additive: one
-- column, defaulting to shown, so every existing record keeps its place.
--
-- public_listed = false keeps an agency record (its bookings, settlements and
-- history stay attached) but takes it off every traveler-facing surface:
-- /partners, the tour page's operator card, the booking and GoAhead emails and
-- the JSON-LD. publicOperator() in server/domain.js is the one gate.
--
-- Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). Taking
-- it off is a data change, deliberately NOT made here: the exact statement and
-- its rollback are in docs/ops/remove-cts-from-partners.md.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS public_listed BOOLEAN NOT NULL DEFAULT true;

INSERT INTO schema_migrations (name) VALUES ('054_partner_listing') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 055_departure_merges
-- 055: merging duplicate departures (live, legacy flow).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_055_departure_merges.down.sql. Additive.
--
-- A real case (27 Sep 2026): eleven travelers of one group booked the same
-- tour and day separately, and each made its own date. Admin → Departures can
-- now merge duplicates of one product and day into the date that is kept.
--
--   departures.merged_into_id           a merged date points at the one kept;
--                                       its old links redirect there
--   departures.operator_agency_override who runs the kept date, when the
--                                       duplicates had different operators and
--                                       admin chose (read before the U01 rule)
--   departure_merges                    each merge, with what it moved, so it
--                                       can be reverted within 24 hours

ALTER TABLE departures ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES departures(id) ON DELETE SET NULL;
ALTER TABLE departures ADD COLUMN IF NOT EXISTS operator_agency_override TEXT;

CREATE TABLE IF NOT EXISTS departure_merges (
  id                     BIGSERIAL PRIMARY KEY,
  kept_departure_id      INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  merged_departure_ids   INTEGER[] NOT NULL,
  snapshot               JSONB NOT NULL,
  operator_agency_id     TEXT,
  moved_bookings         INTEGER NOT NULL DEFAULT 0,
  emailed                INTEGER NOT NULL DEFAULT 0,
  merged_by              TEXT,
  merged_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at            TIMESTAMPTZ,
  reverted_by            TEXT
);
CREATE INDEX IF NOT EXISTS idx_departure_merges_kept ON departure_merges (kept_departure_id);
CREATE INDEX IF NOT EXISTS idx_departures_merged_into ON departures (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Server-only (as 024 set for the Data API): RLS on, no policies.
ALTER TABLE departure_merges ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('055_departure_merges') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 056_booking_parties
-- 056: group bookings ("Join my group"), behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_056_booking_parties.down.sql. Additive: one
-- table and one nullable column; no existing row changes.
--
-- A party is a set of bookings on one departure that travel together. Each
-- member keeps its own booking, seats and payment request (mode C); the party
-- only groups them on the operator's manifest under one lead contact.
--
-- join_token is the "Join my group" link. It is stored as issued, not hashed:
-- the lead reopens their booking page and must get the same link back, or every
-- link already shared would stop working. It grants no more than the booking
-- form does (booking seats on that one date), and the booking code, which
-- grants more, is stored the same way.
CREATE TABLE IF NOT EXISTS booking_parties (
  id              SERIAL PRIMARY KEY,
  departure_id    INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  lead_pledge_id  TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  join_token      TEXT NOT NULL UNIQUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_parties_departure_idx ON booking_parties (departure_id);
ALTER TABLE booking_parties ENABLE ROW LEVEL SECURITY;

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES booking_parties(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pledges_party_idx ON pledges (party_id) WHERE party_id IS NOT NULL;

INSERT INTO schema_migrations (name) VALUES ('056_booking_parties') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 057_booking_integrity
-- 057: reservation integrity (catalogue_v2): clusters of single-seat
-- reservations, flagged for staff. (Email confirmation is live for every direct
-- booking since 058: a booking isn't made until it is confirmed.)
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_057_booking_integrity.down.sql. Additive:
-- two tables and one view. No existing row changes, and every existing
-- booking keeps counting towards GoAhead.
--
-- 1. Signals, kept 30 days and then deleted (the daily job). Never the raw
--    values: a salted hash of the device fingerprint, the IP address cut to
--    its /24 (IPv6: /48), and the phone number's country calling code.
CREATE TABLE IF NOT EXISTS booking_signals (
  pledge_id     TEXT PRIMARY KEY REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id  INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  seats         INTEGER NOT NULL,
  device_hash   TEXT,
  ip_prefix     TEXT,
  phone_cc      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_signals_departure_idx ON booking_signals (departure_id, created_at);
ALTER TABLE booking_signals ENABLE ROW LEVEL SECURITY;

-- 2. Flags: three or more single-seat reservations on one departure within
--    6 hours sharing a signal. A flag never blocks anything. Staff decide:
--    'confirmed_group' (linked as a party), 'suspicious' (its seats don't count
--    towards GoAhead until reviewed) or 'cleared'. The reason values are
--    blanked with the signals at 30 days; the kind stays.
CREATE TABLE IF NOT EXISTS booking_flags (
  id            SERIAL PRIMARY KEY,
  departure_id  INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  pledge_ids    TEXT[] NOT NULL,
  reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'confirmed_group', 'suspicious', 'cleared')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS booking_flags_departure_idx ON booking_flags (departure_id);
ALTER TABLE booking_flags ENABLE ROW LEVEL SECURITY;

-- 3. Seats that count towards GoAhead, beside the seats sold. A view of its
--    own: catalogue_departure_seats (047) is re-created on every migrate run,
--    so it can't take a column. seats_sold (capacity) is unchanged: an
--    held seat is still taken.
CREATE OR REPLACE VIEW catalogue_departure_goahead AS
  SELECT cd.id AS catalogue_departure_id,
         COALESCE((SELECT SUM(p.seats) FROM pledges p
                    WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled'
                      AND NOT EXISTS (SELECT 1 FROM booking_flags f
                                       WHERE f.departure_id = p.departure_id AND f.state = 'suspicious'
                                         AND p.id = ANY (f.pledge_ids))), 0)::INTEGER AS goahead_seats
    FROM catalogue_departures cd;

INSERT INTO schema_migrations (name) VALUES ('057_booking_integrity') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 058_booking_confirmations
-- 058: a direct booking waits for its email to be confirmed (live, not behind
-- catalogue_v2; legacy and catalog departures alike).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_058_booking_confirmations.down.sql. Additive:
-- one table. No existing booking changes; every booking already in `pledges`
-- counts as it does today.
--
-- An unconfirmed booking is NOT a row in `pledges`. It is held here, with the
-- booking exactly as submitted, until the traveler clicks the link in the
-- "Confirm my booking" email; only then is the booking made, through the same
-- code path and checks as before. So it counts towards nothing (GoAhead, the
-- public seat count, capacity), the operator never sees it, and no job that
-- reads bookings has to learn a new status. Unconfirmed after 24 hours, it
-- expires, silently. Until this table exists, bookings are made at once, as
-- before.
--
-- The link's token is stored hashed; a resend (at most 3) issues a new one.
CREATE TABLE IF NOT EXISTS booking_confirmations (
  id             SERIAL PRIMARY KEY,
  booking_code   TEXT NOT NULL UNIQUE,
  departure_id   INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  seats          INTEGER NOT NULL,
  payload        JSONB NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'unconfirmed'
                   CHECK (status IN ('unconfirmed', 'confirmed', 'expired', 'cancelled', 'refused')),
  refused_reason TEXT,
  resends        INTEGER NOT NULL DEFAULT 0,
  pledge_id      TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  confirmed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS booking_confirmations_open_idx ON booking_confirmations (expires_at) WHERE status = 'unconfirmed';
ALTER TABLE booking_confirmations ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('058_booking_confirmations') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 059_operator_selection
-- 059: who operates a departure (phase 5, catalogue_v2).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_059_operator_selection.down.sql. Additive:
-- two more permitted values and three nullable columns on
-- catalogue_assignments.
--
-- At GoAhead the departure is offered first to an agency that has travelers
-- on it and is an approved, active operator for the product: the one with the
-- most travelers, then the one that booked first. Declined or not
-- acknowledged within 4 hours, it goes to the next such agency, then to the
-- rostered operator (the phase 2 roster is the fallback).
--
--   state  'declined'  the operator said no (no strike)
--   source 'agency'    offered because the operator's agency has travelers on
--                      the departure; `candidate` records why it was chosen
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'catalogue_assignments'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%state%' OR pg_get_constraintdef(oid) LIKE '%source%')
  LOOP
    EXECUTE format('ALTER TABLE catalogue_assignments DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_state_check
    CHECK (state IN ('offered', 'acknowledged', 'expired', 'replaced', 'declined'));
  ALTER TABLE catalogue_assignments ADD CONSTRAINT catalogue_assignments_source_check
    CHECK (source IN ('roster', 'admin', 'agency'));
END $$;

ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE catalogue_assignments ADD COLUMN IF NOT EXISTS candidate JSONB;

INSERT INTO schema_migrations (name) VALUES ('059_operator_selection') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 060_date_request_confirmation
-- 060: a traveler's date request waits for its email to be confirmed, like a
-- booking (058). Live, not behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_060_date_request_confirmation.down.sql.
-- Additive: two nullable columns and a kind on booking_confirmations, and its
-- departure becomes optional (a request for a new day has none yet).
--
-- Until 058 a request for a new date (or one joining a date still in review)
-- wrote a pending booking at once. It held seats, and on approval it counted,
-- whether or not the email was real. Now it is held here until the traveler
-- clicks "Confirm my booking"; the link makes the request through the same
-- code path and checks. Unconfirmed after 24 hours, it lapses silently.
-- Agency requests are not held.
ALTER TABLE booking_confirmations ALTER COLUMN departure_id DROP NOT NULL;
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'booking';
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS tour_product_id TEXT REFERENCES tour_products(id) ON DELETE CASCADE;
ALTER TABLE booking_confirmations ADD COLUMN IF NOT EXISTS request_date DATE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_confirmations_kind_check') THEN
    ALTER TABLE booking_confirmations ADD CONSTRAINT booking_confirmations_kind_check
      CHECK (kind IN ('booking', 'date_request'));
  END IF;
  -- A booking is on a date; a date request names its tour and day.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_confirmations_subject_check') THEN
    ALTER TABLE booking_confirmations ADD CONSTRAINT booking_confirmations_subject_check
      CHECK ((kind = 'booking' AND departure_id IS NOT NULL)
          OR (kind = 'date_request' AND tour_product_id IS NOT NULL AND request_date IS NOT NULL));
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('060_date_request_confirmation') ON CONFLICT (name) DO NOTHING;

-- ======================================================================== 061_pool_model
-- 061: the pricing and money model (phase 5, final 28 Sep 2026), behind
-- catalogue_v2. The calculation is shared/pool-model.js; this is its storage.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_061_pool_model.down.sql. Additive: new
-- columns and one table. The old rate columns stay, untouched, so the
-- rollback loses nothing but what was entered in the new ones.
--
-- A rate version now carries, all in EGP:
--   tiers           [{ from, to, priceEgp, operatorFeePct }]   the selling price per traveler and
--                   the operator fee (% of operating cost), per tier
--   cost_lines      [{ name, basis: per_group | per_traveller, amounts: [one per tier] }]
--   commission_pct  the collecting agent's commission, % of the selling price (default 10)
--   eur_rate        the published EUR rate (EGP per EUR): only for showing
--                   and charging travelers in EUR
--
-- Per departure, from the manifest at the cut-off: revenue = headcount × the
-- tier price; entitlement = operating cost × (1 + fee %), the operator's;
-- commission = revenue × commission %, the collecting agent's; pool = the rest, shared
-- per traveler: an agency-sold place earns it for the agency, a direct place
-- for the collecting agent. The fixed per-seat agency commission is retired.

ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS tiers JSONB;
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS cost_lines JSONB;
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 10
  CHECK (commission_pct >= 0 AND commission_pct < 100);
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS eur_rate NUMERIC(12,4) CHECK (eur_rate > 0);

-- Convert every existing version: the band fees become one per-group line,
-- the per-traveler amount (or land services) one per-traveler line, a twin
-- room half its rate per traveler; the operator fee is 0% and the selling
-- prices are left for an admin to enter (the operator rate card never had
-- them). What was converted is recorded on the version's `source`, and
-- scripts/pool-migration-report.js prints it. The same rule as
-- convertLegacyRate in shared/pool-model.js. Published versions are fixed, so
-- the immutability trigger is lifted for this one update only; nothing a
-- published version already said changes.
ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
UPDATE catalogue_rate_versions SET
  tiers = '[{"from":4,"to":6,"priceEgp":null,"operatorFeePct":0},{"from":7,"to":9,"priceEgp":null,"operatorFeePct":0},{"from":10,"to":12,"priceEgp":null,"operatorFeePct":0}]'::jsonb,
  cost_lines = jsonb_build_array(
      jsonb_build_object('name', 'Departure fee', 'basis', 'per_group', 'amounts', jsonb_build_array(fee_4_6, fee_7_9, fee_10_12)),
      jsonb_build_object('name', CASE WHEN per_traveler IS NULL AND land_per_traveler IS NOT NULL THEN 'Land services' ELSE 'Per traveler' END,
        'basis', 'per_traveller', 'amounts', jsonb_build_array(COALESCE(per_traveler, land_per_traveler), COALESCE(per_traveler, land_per_traveler), COALESCE(per_traveler, land_per_traveler))))
    || CASE WHEN room_twin IS NOT NULL THEN jsonb_build_array(jsonb_build_object('name', 'Room or cabin (twin share)', 'basis', 'per_traveller',
         'amounts', jsonb_build_array(round(room_twin / 2, 2), round(room_twin / 2, 2), round(room_twin / 2, 2)))) ELSE '[]'::jsonb END,
  source = source || jsonb_build_object('migration061', jsonb_build_object(
    'convertedAt', now(),
    'notes', to_jsonb(array_remove(ARRAY[
      CASE WHEN room_twin IS NOT NULL THEN format('twin room %s carried as %s per traveler', room_twin, round(room_twin / 2, 2)) END,
      CASE WHEN room_single IS NOT NULL THEN format('single room %s not carried (no per-room basis): add it as a cost line if it applies', room_single) END,
      CASE WHEN commission_per_seat IS NOT NULL THEN format('fixed agency commission %s per seat retired (agencies are paid from the pool)', commission_per_seat) END,
      CASE WHEN fee_4_6 IS NULL OR fee_7_9 IS NULL OR fee_10_12 IS NULL THEN 'a band fee was blank' END,
      'selling prices to enter'
    ], NULL))))
WHERE tiers IS NULL;
ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;

-- A booking keeps the published EUR rate in force when it was made; its
-- charges use that rate.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS published_eur_rate NUMERIC(12,4);

-- Agency pay from the pool. A row per agency booking, as before; `basis`
-- says which model it was made under. Pool rows are decided from the
-- departure's calculation: `earned_egp` = places × pool per traveler × share.
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'per_seat';
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS pool_per_traveller_egp NUMERIC(12,2);
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS share_factor NUMERIC(4,2);
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS earned_egp NUMERIC(12,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agency_commissions_basis_check') THEN
    ALTER TABLE agency_commissions ADD CONSTRAINT agency_commissions_basis_check CHECK (basis IN ('per_seat', 'pool'));
  END IF;
END $$;

-- The monthly agency statement: pool shares add up in EGP and are paid in
-- EUR at the CBE rate on the statement date.
ALTER TABLE commission_statements ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'per_seat';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_statements_basis_check') THEN
    ALTER TABLE commission_statements ADD CONSTRAINT commission_statements_basis_check CHECK (basis IN ('per_seat', 'pool'));
  END IF;
END $$;

-- A departure that reaches a cheaper tier by the cut-off refunds the
-- difference to every paid traveler.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'payment_refunds'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE payment_refunds DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_kind_check
    CHECK (kind IN ('cancellation', 'resale', 'tier_difference'));
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_refunds_tier_difference ON payment_refunds (request_id)
  WHERE state <> 'cancelled' AND kind = 'tier_difference';

-- One departure's calculation, as last worked out: at the cut-off (the tier
-- and the refunds of the difference) and once it is over (the shares). The
-- operator statement, the agency statements, the margin report and Finance
-- all read this one record.
CREATE TABLE IF NOT EXISTS catalogue_departure_economics (
  departure_id     BIGINT PRIMARY KEY REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  rate_version_id  BIGINT REFERENCES catalogue_rate_versions(id),
  stage            TEXT NOT NULL CHECK (stage IN ('cutoff', 'final')),
  headcount        INTEGER NOT NULL CHECK (headcount >= 0),
  economics        JSONB NOT NULL,
  places           JSONB NOT NULL DEFAULT '[]'::jsonb,
  shares           JSONB,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE catalogue_departure_economics ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (name) VALUES ('061_pool_model') ON CONFLICT (name) DO NOTHING;

COMMIT;
