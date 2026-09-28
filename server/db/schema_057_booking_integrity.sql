-- 057: reservation integrity (catalogue_v2): confirmed emails and reservation
-- clusters.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_057_booking_integrity.down.sql. Additive:
-- three nullable columns, two tables, one view and one more permitted
-- cancellation reason. No existing row changes, and every existing booking
-- keeps counting towards GoAhead (email_confirm_token is NULL for them).
--
-- 1. Confirmed emails. A direct booking on a catalog departure made under the
--    flag gets email_confirm_token; its seats count towards GoAhead only once
--    email_confirmed_at is set. The seats stay held meanwhile. A reminder goes
--    at 24 hours (email_reminded_at); an unconfirmed booking still live at the
--    departure's cut-off is released (cancelled_reason 'email_unconfirmed').
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS email_confirm_token TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS email_reminded_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS pledges_email_confirm_token_uq ON pledges (email_confirm_token) WHERE email_confirm_token IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pledges_cancelled_reason_chk' AND pg_get_constraintdef(oid) LIKE '%email_unconfirmed%'
  ) THEN
    ALTER TABLE pledges DROP CONSTRAINT IF EXISTS pledges_cancelled_reason_chk;
    ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
      CHECK (cancelled_reason IS NULL OR cancelled_reason IN
        ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator', 'unpaid', 'email_unconfirmed'));
  END IF;
END $$;

-- 2. Signals, kept 30 days and then deleted (the daily job). Never the raw
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

-- 3. Flags: three or more single-seat reservations on one departure within
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

-- 4. Seats that count towards GoAhead, beside the seats sold. A view of its
--    own: catalogue_departure_seats (047) is re-created on every migrate run,
--    so it can't take a column. seats_sold (capacity) is unchanged: an
--    unconfirmed or held seat is still taken.
CREATE OR REPLACE VIEW catalogue_departure_goahead AS
  SELECT cd.id AS catalogue_departure_id,
         COALESCE((SELECT SUM(p.seats) FROM pledges p
                    WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled'
                      AND (p.email_confirm_token IS NULL OR p.email_confirmed_at IS NOT NULL)
                      AND NOT EXISTS (SELECT 1 FROM booking_flags f
                                       WHERE f.departure_id = p.departure_id AND f.state = 'suspicious'
                                         AND p.id = ANY (f.pledge_ids))), 0)::INTEGER AS goahead_seats
    FROM catalogue_departures cd;
