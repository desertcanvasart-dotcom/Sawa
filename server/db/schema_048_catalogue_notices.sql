-- 048: phase 1 gaps — the below-minimum cancellation notice, and the 30-day
-- GoAhead deadline for cruises and multi-day tours.
--
-- ⚠️ Migrations do not run on deploy (B5):  DATABASE_URL=<production> npm run db:migrate
-- Rollback: server/db/down/schema_048_catalogue_notices.down.sql
--
-- Additive. The only data change is the deadline placeholder below.

-- One row per message owed: the traveller's notice, and a copy for the agency
-- that booked them. UNIQUE makes a re-run of the job a no-op, so nobody is
-- emailed twice; `status` records what happened to each send.
CREATE TABLE IF NOT EXISTS catalogue_notices (
  id             BIGSERIAL PRIMARY KEY,
  departure_id   BIGINT NOT NULL REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  pledge_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('traveler', 'agency_copy')),
  recipient      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts       SMALLINT NOT NULL DEFAULT 0,
  last_error     TEXT,
  sent_at        TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_catalogue_notices_once UNIQUE (departure_id, pledge_id, kind, recipient)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_notices_pending ON catalogue_notices (created_at) WHERE status IN ('pending', 'failed');
ALTER TABLE catalogue_notices ENABLE ROW LEVEL SECURITY;

-- Phase 1 seeded 21 days (the draft agreements' example) as a placeholder.
-- Decided 27 Sep 2026: 30 days, matching the site's existing copy. Only the
-- untouched placeholder moves; a deadline an admin has set stays as it is.
UPDATE catalogue_products SET goahead_deadline_days = 30, updated_at = now()
 WHERE type IN ('cruise', 'multi_day') AND goahead_deadline_days = 21;
