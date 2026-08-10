-- 026: route alerts — "tell me when a group forms".
--
-- ============================================================================
-- WHY
-- ============================================================================
--
-- This is the primary conversion action for the content programme's first six
-- months. Every article ends at a route with no date currently forming, and the
-- only honest thing to offer a reader is "we will tell you when one does".
--
-- Today that button points at /contact. `site/index.html` records why, and the
-- reasoning is still right:
--
--   "Tell me when a group forms" goes to /contact, because that is a channel
--   that exists and is answered; there is no alerts table, and a form that
--   captured an address and told nobody would be the same fabrication in a
--   politer shape. Swap the href the day the capture is built.
--
-- This is the table that day depends on.
--
-- ============================================================================
-- ⚠️ RLS IS ENABLED HERE, EXPLICITLY. THIS IS NOT OPTIONAL.
-- ============================================================================
--
-- 024 enabled row-level security on every table that EXISTED when it ran. It
-- cannot enable it on a table created afterwards. Its REVOKE covers future
-- tables via ALTER DEFAULT PRIVILEGES; **RLS is not carried the same way.**
--
-- So a new table added after 024 reopens exactly the hole 024 closed — and this
-- one would be the worst candidate for it, because it is a list of email
-- addresses belonging to people who have not booked anything.
--
-- Every future migration that creates a table must do this. Stated here rather
-- than assumed, and asserted by a test.
--
-- ============================================================================
-- NOTHING WRITES TO THIS TABLE YET, AND NOTHING MAY UNTIL DIR-12 PUBLISHES.
-- ============================================================================
--
-- These are email addresses collected to send marketing later. That is consent
-- territory, not the transparency-only basis that covers attribution: recording
-- how someone reached a booking is incidental to the transaction, and emailing
-- them afterwards is not.
--
-- So the first write is blocked on the privacy policy describing this
-- processing — DIR-12, thread 3's argument applied to a stronger case. The
-- columns may exist; the INSERT may not.
--
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS route_alerts (
  id                BIGSERIAL PRIMARY KEY,

  -- Who to tell.
  email             TEXT NOT NULL,

  -- What they asked about.
  --
  -- Deliberately NO foreign key to tour_products, for 023's reason: a product
  -- can be archived or renamed, and losing a real person's request because a
  -- listing changed is worse than a dangling reference. `route_label` is what
  -- they were actually shown, kept so the notification can name the trip in the
  -- words they recognise even if the listing has since been retitled.
  tour_product_id   TEXT,
  route_label       TEXT,

  -- Optional. 'YYYY-MM' rather than a DATE, because a month is what a traveller
  -- picks and a DATE would invent a day nobody chose.
  preferred_month   TEXT,

  -- D3 — where they were when they asked. The article that produced the demand
  -- is the whole measurement the content programme runs on, and it exists for
  -- one instant.
  source_url        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ---- Consent, per DIR-12 -------------------------------------------------
  --
  -- Same shape as 023's marketing_consent, and the same argument: proving
  -- consent means proving WHAT was agreed to, and the copy will change.
  --
  -- NULLABLE WITH NO DEFAULT. `false` would be a refusal nobody made, which is
  -- a different claim from having no record — and on this table the difference
  -- is whether a person may lawfully be emailed.
  consent           BOOLEAN,
  consent_at        TIMESTAMPTZ,
  consent_text      TEXT,
  lawful_basis      TEXT,

  -- ---- Effect, not configuration — ZZ2 -------------------------------------
  --
  -- Timestamps, not booleans. "Never notified" and "notified in March" are
  -- different states and a boolean collapses them into the same false comfort.
  notified_at       TIMESTAMPTZ,
  unsubscribed_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_alerts_month_chk') THEN
    ALTER TABLE route_alerts ADD CONSTRAINT route_alerts_month_chk
      CHECK (preferred_month IS NULL OR preferred_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_alerts_lawful_basis_chk') THEN
    ALTER TABLE route_alerts ADD CONSTRAINT route_alerts_lawful_basis_chk
      CHECK (lawful_basis IS NULL OR lawful_basis IN ('consent', 'legitimate_interest'));
  END IF;
END $$;

-- One person, one route, one request. Asking twice is not two people, and a
-- notification sent twice for the same date is the kind of thing that gets a
-- sender marked as spam.
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_alerts_email_product
  ON route_alerts (lower(email), coalesce(tour_product_id, ''));

-- The admin question DIR-15 exists to answer: which routes and months are
-- accumulating demand, so somebody can decide what to schedule.
CREATE INDEX IF NOT EXISTS idx_route_alerts_demand
  ON route_alerts (tour_product_id, preferred_month)
  WHERE unsubscribed_at IS NULL AND notified_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS. See the header — 024 could not reach a table that did not exist.
ALTER TABLE route_alerts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON route_alerts FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON route_alerts FROM authenticated';
  END IF;
END $$;
