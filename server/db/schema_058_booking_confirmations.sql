-- 058: a direct booking waits for its email to be confirmed (live, not behind
-- catalogue_v2; legacy and catalog departures alike).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_058_booking_confirmations.down.sql. Additive:
-- one table. No existing booking changes; every booking already in `pledges`
-- counts as it does today.
--
-- An unconfirmed booking is NOT a row in `pledges`. It is held here, with the
-- booking exactly as submitted, until the traveler clicks the link in the
-- "Confirm my booking" email; only then is the booking made, through the same
-- code path and checks as before. So it counts towards nothing (GoAhead, the
-- public seat count, capacity), the operator never sees it, and no job that
-- reads bookings has to learn a new status. Unconfirmed after 24 hours, it
-- expires, silently. Until this table exists, bookings are made at once, as
-- before.
--
-- The link's token is stored hashed; a resend (at most 3) issues a new one.
CREATE TABLE IF NOT EXISTS booking_confirmations (
  id             SERIAL PRIMARY KEY,
  booking_code   TEXT NOT NULL UNIQUE,
  departure_id   INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  seats          INTEGER NOT NULL,
  payload        JSONB NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'unconfirmed'
                   CHECK (status IN ('unconfirmed', 'confirmed', 'expired', 'cancelled', 'refused')),
  refused_reason TEXT,
  resends        INTEGER NOT NULL DEFAULT 0,
  pledge_id      TEXT REFERENCES pledges(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  confirmed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS booking_confirmations_open_idx ON booking_confirmations (expires_at) WHERE status = 'unconfirmed';
ALTER TABLE booking_confirmations ENABLE ROW LEVEL SECURITY;
