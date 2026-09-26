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
