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
