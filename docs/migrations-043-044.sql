-- Sawa — payments (043) and settlements (044), in one run.
--
-- Paste into the Supabase SQL editor (it runs as `postgres`, the same user the
-- app connects as) and run once. Safe to run again: every statement is
-- IF NOT EXISTS / guarded, and the whole thing is one transaction — if any
-- statement fails, nothing is applied.
--
-- The last statement records both migrations, so `npm run check:applied-schema`
-- and `npm run db:migrate` see them as applied.

BEGIN;

-- ====================================================================
-- 043_booking_payments
-- ====================================================================
-- 043: payment links, one row per link sent to a traveller.
--
-- ⚠️ Migrations do not run on deploy (B5). Until this is applied the payment
-- screens say "payments are not switched on" and nothing else changes:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- ============================================================================
-- THE MODEL THE CLIENT SET (26 Sep 2026)
-- ============================================================================
--
-- Payment is collected through a payment link sent to the customer, made by
-- hand in Tab (tab.travel) and pasted into the portal. Two links per booking:
-- the deposit once the date reaches GoAhead, then the balance before the trip.
-- A customer has 3 days to pay a link. Ops mark each one paid with Tab's own
-- reference.
--
-- ============================================================================
-- WHY A TABLE AND NOT 028's COLUMNS
-- ============================================================================
--
-- 028 proposed one payment record ON the pledge (payment_link_sent_at,
-- payment_due_at, paid_at, payment_state). That models one payment per
-- booking. The client's model is two — a deposit and a balance, each with its
-- own link, due date and reference — and 030 said as much in advance: partial
-- payments are "a new column or a payments table, not a widening of this one".
-- 028's columns are left as they are; nothing reads or writes them.
--
-- A link is never edited into a different link. A wrong one is VOIDED and a new
-- row sent, so what a traveller was actually emailed — the URL, the amount and
-- the deadline — survives as it was.
CREATE TABLE IF NOT EXISTS booking_payments (
  id                 BIGSERIAL PRIMARY KEY,
  pledge_id          TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,          -- deposit | balance | full
  amount             NUMERIC(10,2) NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'EUR',
  provider           TEXT NOT NULL DEFAULT 'tab',
  link_url           TEXT NOT NULL,
  -- The window, STORED when the link is sent and never recomputed (028's
  -- reasoning, which still holds): a deadline a traveller was told in writing
  -- must not move because a product setting changed afterwards.
  link_sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at             TIMESTAMPTZ NOT NULL,
  due_bound_by       TEXT NOT NULL,          -- which rule set due_at
  state              TEXT NOT NULL DEFAULT 'link_sent',
  paid_at            TIMESTAMPTZ,
  provider_reference TEXT,                   -- Tab's payment id, quoted when marking paid
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  refunded_at        TIMESTAMPTZ,
  refund_reference   TEXT,
  emailed_to         TEXT,                   -- null when the booking had no email
  created_by         TEXT,                   -- the ops user's email
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_kind_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_kind_chk
      CHECK (kind IN ('deposit', 'balance', 'full'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_state_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_state_chk
      CHECK (state IN ('link_sent', 'paid', 'void', 'refunded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_bound_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_bound_chk
      CHECK (due_bound_by IN ('window', 'confirm-deadline', 'balance-due-date', 'minimum'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_amount_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_amount_chk CHECK (amount > 0);
  END IF;
  -- Each state carries the facts that make it true, enforced here rather than
  -- in a route a manual UPDATE could bypass.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_paid_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_paid_chk
      CHECK (state NOT IN ('paid', 'refunded') OR (paid_at IS NOT NULL AND provider_reference IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_refund_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_refund_chk
      CHECK (state <> 'refunded' OR refunded_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_payments_void_chk') THEN
    ALTER TABLE booking_payments ADD CONSTRAINT booking_payments_void_chk
      CHECK (state <> 'void' OR voided_at IS NOT NULL);
  END IF;
END $$;

-- One live link of each kind per booking: sending a second deposit link while
-- the first is still open is how a traveller ends up paying twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_payments_open
  ON booking_payments (pledge_id, kind) WHERE state = 'link_sent';

CREATE INDEX IF NOT EXISTS idx_booking_payments_pledge ON booking_payments (pledge_id);

-- Row-level security on, no policies: the same lock-down 024 applied to every
-- other table, so the Supabase data API cannot read payment links. The server
-- connects as the table owner and is unaffected.
ALTER TABLE booking_payments ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- 044_settlements
-- ====================================================================
-- 044: tour costs, settlements and the Wednesday payouts.
--
-- ⚠️ Migrations do not run on deploy (B5). Until this is applied the
-- settlement and money screens say so and nothing else changes:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- ============================================================================
-- THE MODEL THE CLIENT SET (26 Sep 2026)
-- ============================================================================
--
-- For every departure: total revenue collected − the approved net tour cost =
-- gross profit. Sawa takes 10% of the gross profit; the other 90% is shared by
-- the participating agencies in proportion to their passengers (direct
-- travellers count for Capital Travel Service, a preferred partner — not the
-- owner). Refunded passengers are not counted.
--
-- Sawa is a separate entity that decides and approves everything:
--   - every cost line, whoever submitted it (Capital Travel Service included);
--   - a loss: Sawa reviews it and decides who absorbs it;
--   - non-refundable costs on a refund: Sawa decides case by case.
-- Both decisions are recorded as ADJUSTMENTS — a signed amount for one party,
-- with the reason — so the arithmetic stays in one place and every decision is
-- written down.
--
-- Payouts every Wednesday, for tours that ended by the Saturday before, with
-- the money collected by that Saturday. Money collected later — a late
-- payment, a correction — is paid as a top-up on a later Wednesday: each run
-- pays what is owed as of its Saturday minus what earlier runs already paid.

-- ---------------------------------------------------------------------------
-- The net tour cost, line by line. The operator submits; Sawa approves,
-- rejects or approves a different amount. Sawa's own lines are approved as
-- entered. Amounts are in the booking currency (EUR).
CREATE TABLE IF NOT EXISTS departure_costs (
  id               BIGSERIAL PRIMARY KEY,
  departure_id     INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  category         TEXT NOT NULL,
  description      TEXT NOT NULL,
  amount           NUMERIC(10,2) NOT NULL,
  receipt_url      TEXT,
  submitted_by_agency_id TEXT,              -- null: entered by Sawa
  submitted_by     TEXT,                     -- email
  state            TEXT NOT NULL DEFAULT 'submitted',
  approved_amount  NUMERIC(10,2),
  review_note      TEXT,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A decision by Sawa that moves money to or from one party on one departure:
-- who absorbs a loss, who covers a non-refundable cost. agency_id null = Sawa.
CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id            BIGSERIAL PRIMARY KEY,
  departure_id  INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  agency_id     TEXT,
  amount        NUMERIC(10,2) NOT NULL,
  reason        TEXT NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-departure sign-offs. The cost sheet is final when Sawa says so; a loss
-- is paid out only after Sawa has recorded its decision.
CREATE TABLE IF NOT EXISTS departure_settlements (
  departure_id    INTEGER PRIMARY KEY REFERENCES departures(id) ON DELETE CASCADE,
  costs_final_at  TIMESTAMPTZ,
  costs_final_by  TEXT,
  loss_decided_at TIMESTAMPTZ,
  loss_decided_by TEXT,
  loss_note       TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One run per Wednesday. `cutoff_at` is the end of the Saturday before (Cairo
-- time): tours ended by then are included, with money collected by then.
CREATE TABLE IF NOT EXISTS payout_runs (
  id           BIGSERIAL PRIMARY KEY,
  pay_date     DATE NOT NULL UNIQUE,
  cutoff_at    TIMESTAMPTZ NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft',
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ
);

-- What a run pays, per departure and party: the amount owed as of the run's
-- cutoff minus what approved runs before it paid. `detail` keeps the figures
-- it was worked out from, so a statement can always be explained.
CREATE TABLE IF NOT EXISTS payout_lines (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES payout_runs(id) ON DELETE CASCADE,
  departure_id  INTEGER NOT NULL REFERENCES departures(id),
  agency_id     TEXT NOT NULL,
  amount        NUMERIC(10,2) NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The money actually sent: one transfer per agency per approved run.
CREATE TABLE IF NOT EXISTS payout_transfers (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES payout_runs(id) ON DELETE CASCADE,
  agency_id       TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  state           TEXT NOT NULL DEFAULT 'due',
  paid_at         TIMESTAMPTZ,
  bank_reference  TEXT,
  paid_by         TEXT,
  UNIQUE (run_id, agency_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_state_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_state_chk CHECK (state IN ('submitted', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_category_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_category_chk CHECK (category IN
      ('transport', 'guide', 'entrance', 'meals', 'activities', 'accommodation', 'permits', 'local_services', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_amount_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_amount_chk
      CHECK (amount > 0 AND (approved_amount IS NULL OR approved_amount >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departure_costs_review_chk') THEN
    ALTER TABLE departure_costs ADD CONSTRAINT departure_costs_review_chk
      CHECK (state = 'submitted' OR (reviewed_at IS NOT NULL AND (state <> 'approved' OR approved_amount IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_runs_state_chk') THEN
    ALTER TABLE payout_runs ADD CONSTRAINT payout_runs_state_chk CHECK (state IN ('draft', 'approved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_runs_approved_chk') THEN
    ALTER TABLE payout_runs ADD CONSTRAINT payout_runs_approved_chk CHECK (state = 'draft' OR approved_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_transfers_state_chk') THEN
    ALTER TABLE payout_transfers ADD CONSTRAINT payout_transfers_state_chk CHECK (state IN ('due', 'paid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_transfers_paid_chk') THEN
    ALTER TABLE payout_transfers ADD CONSTRAINT payout_transfers_paid_chk
      CHECK (state = 'due' OR (paid_at IS NOT NULL AND bank_reference IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_departure_costs_departure ON departure_costs (departure_id);
CREATE INDEX IF NOT EXISTS idx_settlement_adjustments_departure ON settlement_adjustments (departure_id);
CREATE INDEX IF NOT EXISTS idx_payout_lines_run ON payout_lines (run_id);
CREATE INDEX IF NOT EXISTS idx_payout_lines_departure ON payout_lines (departure_id, agency_id);

-- Row-level security on, no policies — 024's lock-down, for every new table.
ALTER TABLE departure_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departure_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_transfers ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- Record both as applied.
-- ====================================================================
INSERT INTO schema_migrations (name) VALUES ('043_booking_payments'), ('044_settlements')
  ON CONFLICT (name) DO NOTHING;

COMMIT;

-- Check (optional): should list 6 settlement tables and booking_payments.
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public' AND table_name IN ('booking_payments', 'departure_costs', 'settlement_adjustments',
--        'departure_settlements', 'payout_runs', 'payout_lines', 'payout_transfers') ORDER BY 1;
