-- 057: reservation integrity (catalogue_v2): clusters of single-seat
-- reservations, flagged for staff. (Email confirmation is live for every direct
-- booking since 058: a booking isn't made until it is confirmed.)
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_057_booking_integrity.down.sql. Additive:
-- two tables and one view. No existing row changes, and every existing
-- booking keeps counting towards GoAhead.
--
-- 1. Signals, kept 30 days and then deleted (the daily job). Never the raw
--    values: a salted hash of the device fingerprint, the IP address cut to
--    its /24 (IPv6: /48), and the phone number's country calling code.
CREATE TABLE IF NOT EXISTS booking_signals (
  pledge_id     TEXT PRIMARY KEY REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id  INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  seats         INTEGER NOT NULL,
  device_hash   TEXT,
  ip_prefix     TEXT,
  phone_cc      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_signals_departure_idx ON booking_signals (departure_id, created_at);
ALTER TABLE booking_signals ENABLE ROW LEVEL SECURITY;

-- 2. Flags: three or more single-seat reservations on one departure within
--    6 hours sharing a signal. A flag never blocks anything. Staff decide:
--    'confirmed_group' (linked as a party), 'suspicious' (its seats don't count
--    towards GoAhead until reviewed) or 'cleared'. The reason values are
--    blanked with the signals at 30 days; the kind stays.
CREATE TABLE IF NOT EXISTS booking_flags (
  id            SERIAL PRIMARY KEY,
  departure_id  INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  pledge_ids    TEXT[] NOT NULL,
  reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'confirmed_group', 'suspicious', 'cleared')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS booking_flags_departure_idx ON booking_flags (departure_id);
ALTER TABLE booking_flags ENABLE ROW LEVEL SECURITY;

-- 3. Seats that count towards GoAhead, beside the seats sold. A view of its
--    own: catalogue_departure_seats (047) is re-created on every migrate run,
--    so it can't take a column. seats_sold (capacity) is unchanged: an
--    held seat is still taken.
CREATE OR REPLACE VIEW catalogue_departure_goahead AS
  SELECT cd.id AS catalogue_departure_id,
         COALESCE((SELECT SUM(p.seats) FROM pledges p
                    WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled'
                      AND NOT EXISTS (SELECT 1 FROM booking_flags f
                                       WHERE f.departure_id = p.departure_id AND f.state = 'suspicious'
                                         AND p.id = ANY (f.pledge_ids))), 0)::INTEGER AS goahead_seats
    FROM catalogue_departures cd;
