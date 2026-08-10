-- 028: the payment window, while `pledges` is still empty.
--
-- ⚠️ PROPOSED. NOT APPLIED. Migrations do not run on deploy (B5).
--
-- ============================================================================
-- WHY NOW
-- ============================================================================
--
-- 023's argument, again: these record things that exist only at the moment of
-- the write. `pledges` has never held a row (E-2), and that asset is spent
-- exactly once. After the first booking, a payment window that was never
-- captured cannot be reconstructed — nobody can say what deadline a traveller
-- was actually told.
--
-- ============================================================================
-- WHAT IS HERE, AND WHAT IS DELIBERATELY NOT
-- ============================================================================
--
-- HERE: the per-PLEDGE payment record. LLL1.2's rule is decided, DIR-18 settled
-- the payment model (a secure link after GoAhead, into Sawa's own merchant
-- account, sent manually), and counsel has cleared collection.
--
-- NOT HERE: **the departure-level hold fields.** LLL4 says so itself — their
-- permitted values depend on LLL2.2 (do dates confirming inside the deadline
-- behave as A or B, and do packages differ) and LLL3.3 (may a paid traveller
-- withdraw during a hold). Both are open with the client. Schema is a statement
-- about what a system is designed to do; writing those columns now would answer
-- two client questions by declaration.
--
-- ============================================================================
-- ONE DEPARTURE FROM THE BRIEF, STATED RATHER THAN MADE QUIETLY
-- ============================================================================
--
-- LLL4 lists six states: awaiting_link, link_sent, paid, **overdue**, released,
-- refunded.
--
-- `overdue` is **not** a stored value here. It is entirely determined by
-- `payment_due_at` and `paid_at`, both of which are stored — so storing it as
-- well creates a second answer to one question, which then needs a job to keep
-- it true. That is exactly the shape of BBBB4: a status column recomputed from
-- underlying facts, disagreeing with them between ticks, and an unattended job
-- acting on the stale one.
--
-- Derived, "overdue" cannot be stale:
--
--   payment_due_at < now() AND paid_at IS NULL AND payment_state = 'link_sent'
--
-- If the client wants a stored flag — for an index, or because an operator must
-- be able to mark something overdue by hand — that is a fair answer and this
-- comment is where the decision should be recorded. It should not arrive by
-- default.
--
-- ============================================================================
-- Run by hand, if approved:  npm run db:migrate     (idempotent)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The window, STORED and never derived at read time.
--
-- This is LLL4's load-bearing choice. `payment_due_at` depends on the product's
-- confirm deadline, which an operator can change; deriving it at read time
-- would let an override silently move a deadline a traveller has already been
-- told in writing. The value is computed once, by `paymentDueAt` in
-- shared/payment-window.js, at the moment the link is sent — and then it is a
-- fact, not a calculation.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS payment_link_sent_at TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS payment_due_at       TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS paid_at              TIMESTAMPTZ;

-- Which of the two rules bound the window, kept beside the instant it produced.
-- Without it, a 6-hour window and a 72-hour window are indistinguishable after
-- the fact, and "why was I given until Tuesday" has no answer. LLL1.2's rule is
-- "whichever is sooner"; this records which one that was.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS payment_window_bound_by TEXT;

-- ---------------------------------------------------------------------------
-- Refunds. `refund_reference` is the operator's or bank's own identifier —
-- the thing a traveller can quote and someone can look up.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS refund_reference TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS refunded_at      TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- State. NULLABLE WITH NO DEFAULT, for 023's and 025's reason: a DEFAULT of
-- 'awaiting_link' would assert a payment position for every row that exists,
-- including rows written before any of this ran. NULL means "no payment process
-- has begun", which is a different claim from "awaiting a link".
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS payment_state TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_payment_state_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_payment_state_chk
      CHECK (payment_state IS NULL OR payment_state IN
        ('awaiting_link', 'link_sent', 'paid', 'released', 'refunded'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_payment_bound_by_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_payment_bound_by_chk
      CHECK (payment_window_bound_by IS NULL OR payment_window_bound_by IN ('window', 'confirm-deadline'));
  END IF;

  -- A due date with no link sent is incoherent: the window starts when the
  -- link goes out. Caught here rather than in a code path that might be
  -- bypassed by a manual UPDATE.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pledges_payment_due_needs_link_chk') THEN
    ALTER TABLE pledges ADD CONSTRAINT pledges_payment_due_needs_link_chk
      CHECK (payment_due_at IS NULL OR payment_link_sent_at IS NOT NULL);
  END IF;
END $$;

-- The overdue query, and the reason there is no `overdue` column to index.
CREATE INDEX IF NOT EXISTS idx_pledges_payment_due
  ON pledges (payment_due_at)
  WHERE paid_at IS NULL AND payment_state = 'link_sent';
