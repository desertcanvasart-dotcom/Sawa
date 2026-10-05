-- Migration 069 (customer reviews) as one script for the Supabase SQL editor:
-- paste, run, done. The same SQL as server/db/schema_069_customer_reviews.sql,
-- in one transaction, recorded in schema_migrations.
-- Apply 068 first (docs/ops/apply-migration-068.sql). Safe to rerun.
BEGIN;
-- 069: customer reviews, collected from travelers whose tour has run
-- (decided 5 Oct 2026: tours have now run, so reviews can be real).
--
-- ⚠️ Migrations do not run on deploy. Apply by hand, after 068:
--   npm run db:migrate, or docs/ops/apply-migration-069.sql in the Supabase SQL editor.
-- Rollback: server/db/down/schema_069_customer_reviews.down.sql. Additive: one table.
--
-- 025 and the tour page said it plainly: there was no reviews table, so no
-- rating could be shown. This is that table. Every row is tied to a booking
-- (`pledge_id`, one review per booking) on a date that has already run, so a
-- published review always has a booking behind it.
--
--   status 'invited'    Sawa made a review link for the booking; nothing written yet.
--          'submitted'  the traveler sent it; waiting for an admin. Not shown.
--          'published'  an admin approved it; shown on the tour page.
--          'hidden'     an admin chose not to show it (kept, never deleted).
--
-- The link's token is stored hashed; making a new link replaces the old one.
-- `media` lists the photos and videos the traveler uploaded, as keys in the
-- private `review-media` storage bucket: [{ "key": "...", "kind": "image"|"video" }].
-- They are only ever opened through a short-lived signed link, and the public
-- only gets one for a published review.
CREATE TABLE IF NOT EXISTS customer_reviews (
  id                BIGSERIAL PRIMARY KEY,
  pledge_id         TEXT NOT NULL UNIQUE REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id      INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  tour_product_id   TEXT,
  route             TEXT NOT NULL,
  tour_date         DATE NOT NULL,
  email             TEXT,
  token_hash        TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'invited'
                      CHECK (status IN ('invited', 'submitted', 'published', 'hidden')),
  rating            SMALLINT CHECK (rating BETWEEN 1 AND 5),
  title             TEXT,
  body              TEXT,
  display_name      TEXT,
  country           TEXT,
  media             JSONB NOT NULL DEFAULT '[]'::jsonb,
  publish_consent_at TIMESTAMPTZ,
  invited_by        TEXT,
  invited_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at        TIMESTAMPTZ,
  submitted_at      TIMESTAMPTZ,
  moderated_by      TEXT,
  moderated_at      TIMESTAMPTZ,
  CONSTRAINT customer_reviews_submitted_complete CHECK (
    status = 'invited' OR (rating IS NOT NULL AND body IS NOT NULL AND display_name IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  CONSTRAINT customer_reviews_published_consented CHECK (
    status <> 'published' OR publish_consent_at IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS idx_customer_reviews_product ON customer_reviews (tour_product_id, submitted_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_customer_reviews_status ON customer_reviews (status, submitted_at DESC);
ALTER TABLE customer_reviews ENABLE ROW LEVEL SECURITY;
INSERT INTO schema_migrations (name) VALUES ('069_customer_reviews') ON CONFLICT (name) DO NOTHING;
COMMIT;
