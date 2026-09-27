-- Model phase 3: settlements and commissions. Records and statements for money
-- owed; nothing here moves money. Finance pays by bank transfer and records it.
--
-- Additive: new tables and new nullable or defaulted columns only. Existing
-- settlement tables (044–046) are untouched; legacy departures keep them.
-- Rollback: server/db/down/schema_050_settlements_commissions.down.sql.
BEGIN;

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

COMMIT;
