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
