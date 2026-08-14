-- ============================================================
--  Sawa — Phase 1 schema
--  Mirrors the db.json shape, on real tables with constraints,
--  foreign keys, and the structure needed for transactional,
--  concurrency-safe bookings.
-- ============================================================

-- Migration bookkeeping (used by migrate.js)
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Reference data --------------------------------------------------------

CREATE TABLE IF NOT EXISTS cities (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  region  TEXT,
  status  TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS agencies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
);

-- ---- Catalogue: tour products (day tours + packages) -----------------------

CREATE TABLE IF NOT EXISTS tour_products (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL DEFAULT 'day_tour'
                         CHECK (type IN ('day_tour', 'package')),
  title                TEXT NOT NULL,
  city                 TEXT NOT NULL,
  cities               JSONB,                 -- packages: multi-city
  nights               INTEGER,               -- packages
  duration             TEXT,
  default_time         TEXT,
  guide                TEXT,
  vehicle              TEXT,
  min_seats            INTEGER NOT NULL DEFAULT 4 CHECK (min_seats >= 1),
  max_seats            INTEGER NOT NULL DEFAULT 10 CHECK (max_seats >= 1),
  base_cost            INTEGER,
  published_rate       INTEGER NOT NULL CHECK (published_rate > 0),
  break_price          INTEGER CHECK (break_price > 0),
  quality              NUMERIC(2,1),
  deposit_percent      INTEGER NOT NULL DEFAULT 10 CHECK (deposit_percent BETWEEN 0 AND 100),
  description          TEXT,
  included             JSONB NOT NULL DEFAULT '[]'::jsonb,
  not_included         JSONB NOT NULL DEFAULT '[]'::jsonb,
  itinerary            JSONB,                 -- packages: day-by-day
  accommodation_tiers  JSONB,                 -- packages: hotel tiers
  CONSTRAINT break_le_published CHECK (break_price IS NULL OR break_price <= published_rate),
  CONSTRAINT max_ge_min CHECK (max_seats >= min_seats)
);

-- ---- Scheduled departures (a specific date of a product) -------------------

CREATE TABLE IF NOT EXISTS departures (
  id               INTEGER PRIMARY KEY,
  type             TEXT NOT NULL DEFAULT 'day_tour'
                     CHECK (type IN ('day_tour', 'package')),
  tour_product_id  TEXT REFERENCES tour_products(id) ON DELETE SET NULL,
  route            TEXT NOT NULL,
  date             DATE NOT NULL,
  start_date       DATE,                      -- packages
  end_date         DATE,                      -- packages
  nights           INTEGER,                   -- packages
  cities           JSONB,                     -- packages
  time             TEXT,
  city             TEXT NOT NULL,
  guide            TEXT,
  vehicle          TEXT,
  min_seats        INTEGER NOT NULL DEFAULT 4 CHECK (min_seats >= 1),
  max_seats        INTEGER NOT NULL DEFAULT 10 CHECK (max_seats >= 1),
  base_cost        INTEGER,
  published_rate   INTEGER NOT NULL CHECK (published_rate > 0),
  break_price      INTEGER CHECK (break_price > 0),
  quality          NUMERIC(2,1),
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','minimum_reached','supplier_confirmed','closed','cancelled')),
  notes            TEXT,
  deposit_percent  INTEGER NOT NULL DEFAULT 10 CHECK (deposit_percent BETWEEN 0 AND 100),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dep_max_ge_min CHECK (max_seats >= min_seats)
);

CREATE INDEX IF NOT EXISTS idx_departures_product ON departures(tour_product_id);
CREATE INDEX IF NOT EXISTS idx_departures_city ON departures(city);

-- Sequence so new departures get sensible auto IDs above any seeded ones.
CREATE SEQUENCE IF NOT EXISTS departures_id_seq;

-- ---- Pledges (bookings against a departure) --------------------------------

CREATE TABLE IF NOT EXISTS pledges (
  id                       TEXT PRIMARY KEY,
  departure_id             INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  agency_id                TEXT,              -- 'direct_customer' for public bookings
  agency                   TEXT,              -- denormalised display name
  seats                    INTEGER NOT NULL CHECK (seats >= 1),
  customers                TEXT,
  price_per_person         INTEGER,
  booking_total            INTEGER,
  deposit_percent          INTEGER,
  deposit_due              INTEGER,
  balance_due              INTEGER,
  balance_due_date         DATE,
  source                   TEXT,              -- 'public' for direct travellers
  booking_code             TEXT,              -- SAWA-XXXXX for public
  rooming_type             TEXT,              -- packages: single|double|triple
  accommodation_tier       TEXT,              -- packages: tier id
  accommodation_tier_name  TEXT,              -- packages: tier label
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pledges_departure ON pledges(departure_id);
CREATE INDEX IF NOT EXISTS idx_pledges_agency ON pledges(agency_id);
