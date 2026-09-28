-- 056: group bookings ("Join my group"), behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_056_booking_parties.down.sql. Additive: one
-- table and one nullable column; no existing row changes.
--
-- A party is a set of bookings on one departure that travel together. Each
-- member keeps its own booking, seats and payment request (mode C); the party
-- only groups them on the operator's manifest under one lead contact.
--
-- join_token is the "Join my group" link. It is stored as issued, not hashed:
-- the lead reopens their booking page and must get the same link back, or every
-- link already shared would stop working. It grants no more than the booking
-- form does (booking seats on that one date), and the booking code, which
-- grants more, is stored the same way.
CREATE TABLE IF NOT EXISTS booking_parties (
  id              SERIAL PRIMARY KEY,
  departure_id    INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  lead_pledge_id  TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  join_token      TEXT NOT NULL UNIQUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_parties_departure_idx ON booking_parties (departure_id);
ALTER TABLE booking_parties ENABLE ROW LEVEL SECURITY;

ALTER TABLE pledges ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES booking_parties(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pledges_party_idx ON pledges (party_id) WHERE party_id IS NOT NULL;
