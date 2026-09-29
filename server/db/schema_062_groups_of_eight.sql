-- 062: the maximum group is 8 travelers (decided 29 Sep 2026: the standard
-- 14-seat vehicle, with spare seats kept for luggage). LIVE, not behind
-- catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_062_groups_of_eight.down.sql (drops the
-- request table; it cannot restore the old maxima, which are in the ops note).
--
-- What it changes, and what it leaves alone:
--   - tour_products.max_seats above 8 becomes 8. Every live tour.
--   - departures.max_seats above 8 becomes 8. A departure that already holds
--     more than 8 booked seats becomes exactly as large as it is (full, no
--     more bookings) and every booking stays; docs/ops/live-groups-of-8.md
--     lists those for a person to handle. A departure sold through the
--     catalogue is left alone (its maximum is the catalogue product's own).
--   - price_tiers rows for a group larger than 8 are dropped: the price grid
--     shows sizes 4 to 8 only. The other rows keep their prices.
--   - The 021 CHECK (max_seats <= 12) stays. It is the ceiling for a catalogue
--     product's own override (cruises, multi-day); the standard cap of 8 is
--     enforced by capacityError() in server/domain.js and by the data above.
--
-- Parties larger than 8 are not bookable online: group_requests holds the
-- request a traveler makes instead (a lead for the admin, no booking).

-- Every UPDATE is guarded by the old value, so a second run changes nothing.
UPDATE tour_products SET max_seats = 8 WHERE max_seats > 8;

-- A date already holding more than 8 keeps every booking: its maximum becomes
-- the seats it holds, so it is full and takes nothing more.
UPDATE departures d SET max_seats = LEAST(d.max_seats, GREATEST(8, COALESCE((
    SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status IS DISTINCT FROM 'cancelled'), 0)))
 WHERE d.max_seats > GREATEST(8, COALESCE((
    SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status IS DISTINCT FROM 'cancelled'), 0))
   AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id);

UPDATE tour_products t SET price_tiers = COALESCE((
    SELECT jsonb_agg(e ORDER BY (e->>'seats')::int)
      FROM jsonb_array_elements(t.price_tiers) e
     WHERE (e->>'seats')::int <= 8), '[]'::jsonb)
 WHERE t.price_tiers IS NOT NULL
   AND jsonb_typeof(t.price_tiers) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.price_tiers) e WHERE (e->>'seats')::int > 8);

CREATE TABLE IF NOT EXISTS group_requests (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  group_size    INTEGER NOT NULL CHECK (group_size > 8),
  wanted_date   DATE,
  product_id    TEXT,
  product_title TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_by    TEXT,
  handled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_group_requests_status ON group_requests (status, created_at DESC);
ALTER TABLE group_requests ENABLE ROW LEVEL SECURITY;
