-- 064: the automatic EUR/EGP rate.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_064_automatic_fx.down.sql.
--
-- Two rates, kept apart:
--
--   market rate     EGP per 1 EUR, one row a day in fx_rates (the Finance rate
--                   table). Fetched daily from an exchange-rate provider
--                   (server/fx.js), or entered by hand as before. A fetched
--                   rate more than 5% from the previous day's waits as
--                   `pending` until an admin approves it; nothing reads a
--                   pending or rejected row. Used for the FX line, statements
--                   and the margin report, as before.
--   traveler rate   one site-wide rate travelers are priced and charged at,
--                   behind catalogue_v2: the latest approved market rate less
--                   a buffer (Finance, default 3%). Replaces the "published
--                   EUR rate" each rate card version carried. Every change is
--                   a row in fx_traveller_rates; the latest row is in force. A
--                   booking keeps the rate in force when it was made
--                   (pledges.published_eur_rate, 061).

-- ---------------------------------------------------------------- market rate
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS provider_as_of TIMESTAMPTZ;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS previous_egp_per_eur NUMERIC(12,4);
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fx_rates_status_check') THEN
    ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_status_check CHECK (status IN ('approved', 'pending', 'rejected'));
  END IF;
END $$;

-- Something for an admin to look at: a fetch that failed, or a rate waiting
-- for approval. One open alert per kind; it is resolved by the next good
-- fetch, or by approving or rejecting the rate.
CREATE TABLE IF NOT EXISTS fx_alerts (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('fetch_failed', 'rate_pending')),
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at   TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_alerts_open ON fx_alerts (kind) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------- traveler rate
CREATE TABLE IF NOT EXISTS fx_traveller_rates (
  id                 BIGSERIAL PRIMARY KEY,
  egp_per_eur        NUMERIC(12,4) NOT NULL CHECK (egp_per_eur > 0),
  -- The market rate it was worked out from, and the buffer applied (null for
  -- a manual override). An early update compares the market to this.
  market_egp_per_eur NUMERIC(12,4) CHECK (market_egp_per_eur > 0),
  market_day         DATE,
  buffer_pct         NUMERIC(5,2),
  reason             TEXT NOT NULL CHECK (reason IN ('initial', 'weekly', 'market_move', 'override')),
  note               TEXT,
  set_by             TEXT,
  effective_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fx_traveller_override_reason CHECK (reason <> 'override' OR length(trim(coalesce(note, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS idx_fx_traveller_rates_at ON fx_traveller_rates (effective_at DESC, id DESC);

INSERT INTO finance_settings (key, value, updated_by)
VALUES ('traveller_rate', '{"bufferPct": 3}'::jsonb, 'migration 064')
ON CONFLICT (key) DO NOTHING;

-- The per-version "published EUR rate" goes, and its values are NOT carried
-- over: they were wrong (e.g. 43, 97). The traveler rate starts empty. Until
-- the first fetched rate is approved, or an admin sets a rate by hand, the
-- rate card editor and tour pages say "Exchange rate not set", no euro price
-- is shown and no payment request is sent. Each version keeps a note of what
-- it said, for the record only (scripts can read `source`).
-- Published versions are fixed, so the immutability trigger is lifted for
-- this one update, as 061 did.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'catalogue_rate_versions' AND column_name = 'eur_rate') THEN
    ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
    UPDATE catalogue_rate_versions
       SET source = source || jsonb_build_object('migration064', jsonb_build_object('eurRate', eur_rate, 'movedAt', now()))
     WHERE eur_rate IS NOT NULL;
    ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;
    ALTER TABLE catalogue_rate_versions DROP COLUMN eur_rate;
  END IF;
END $$;

ALTER TABLE fx_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_traveller_rates ENABLE ROW LEVEL SECURITY;
