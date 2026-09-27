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
