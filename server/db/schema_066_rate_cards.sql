-- 066: one rate card per product, and a frozen copy on each departure that
-- has sold a seat (catalogue_v2, decided 29 Sep 2026). Replaces the rate
-- versions (draft / publish / takes effect).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 065:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- or docs/ops/apply-migration-066.sql in the Supabase SQL editor.
-- Rollback: server/db/down/schema_066_rate_cards.down.sql (with the code before 066).
--
--   catalogue_rate_cards        one row per product. Saving updates it in place;
--                               every change is in the audit log (who, when,
--                               before and after). Deleting it makes the tour
--                               unbookable until a new one is saved.
--   catalogue_departures.rate_snapshot
--                               the card as it was when the departure sold its
--                               first seat (tiers, prices, operator fees, cost
--                               lines, commission). Payment requests,
--                               statements, the pool and settlement use it;
--                               later edits and deletes never touch it.
--
-- The migration, in order:
--   1. every old version and draft is archived, as JSON, in
--      catalogue_rate_versions_archive (drop it once you're satisfied);
--   2. each product's newest PUBLISHED version becomes its rate card; a tier
--      ending above the product's maximum group (8; a cruise or multi-day may
--      be up to 12) is clamped to it, and a tier starting above it is dropped
--      with its cost amounts. Each change, each newer draft left behind, and
--      each product with only a draft, is listed in rate_card_migration_066;
--   3. every departure locked to a version gets that version, unchanged, as
--      its snapshot;
--   4. the old versions and drafts are deleted, and nothing references them.
--
-- Every migration runs on each db:migrate, and 049 recreates an (empty)
-- versions table and the old lock trigger; this one runs after it, finds
-- nothing to move, and puts the snapshot trigger back. Safe to rerun.

CREATE TABLE IF NOT EXISTS catalogue_rate_cards (
  product_id      BIGINT PRIMARY KEY REFERENCES catalogue_products(id) ON DELETE CASCADE,
  currency        TEXT NOT NULL DEFAULT 'EGP',
  tiers           JSONB NOT NULL CHECK (jsonb_typeof(tiers) = 'array'),
  cost_lines      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cost_lines) = 'array'),
  commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (commission_pct >= 0 AND commission_pct < 100),
  source          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE catalogue_rate_cards ENABLE ROW LEVEL SECURITY;

ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS rate_snapshot JSONB;

CREATE TABLE IF NOT EXISTS catalogue_rate_versions_archive (
  id           BIGINT PRIMARY KEY,
  product_id   BIGINT,
  version      INT,
  state        TEXT,
  row_data     JSONB NOT NULL,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE catalogue_rate_versions_archive ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rate_card_migration_066 (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT,
  catalogue_no  INT,
  title         TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('card', 'clamped', 'dropped_tier', 'newer_draft', 'no_published', 'snapshot')),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rate_card_migration_066 ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  p RECORD;
  v RECORD;
  d RECORD;
  t JSONB;
  i INT;
  cap INT;
  keep INT[];
  new_tiers JSONB;
  new_lines JSONB;
  l JSONB;
  amounts JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'catalogue_rate_versions') THEN
    RETURN;
  END IF;

  -- 1. archive
  INSERT INTO catalogue_rate_versions_archive (id, product_id, version, state, row_data)
  SELECT v2.id, v2.product_id, v2.version, v2.state, to_jsonb(v2) FROM catalogue_rate_versions v2
  ON CONFLICT (id) DO NOTHING;

  -- 2. the newest published version of each product becomes its card
  FOR p IN SELECT * FROM catalogue_products ORDER BY catalogue_no LOOP
    SELECT * INTO v FROM catalogue_rate_versions
     WHERE product_id = p.id AND state = 'published' ORDER BY version DESC LIMIT 1;
    IF NOT FOUND THEN
      FOR d IN SELECT * FROM catalogue_rate_versions WHERE product_id = p.id AND state = 'draft' LOOP
        INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
        VALUES (p.id, p.catalogue_no, p.title, 'no_published', jsonb_build_object(
          'draftVersion', d.version, 'tiers', d.tiers, 'costLines', d.cost_lines, 'commissionPct', d.commission_pct, 'createdBy', d.created_by,
          'note', 'no rate card was made: this product had only a draft. Enter its rate card in Admin → Rate card.'));
      END LOOP;
      CONTINUE;
    END IF;
    CONTINUE WHEN EXISTS (SELECT 1 FROM catalogue_rate_cards WHERE product_id = p.id);

    cap := GREATEST(COALESCE(p.max_group, 8), 1);
    new_tiers := '[]'::jsonb;
    keep := ARRAY[]::INT[];
    FOR i IN 0 .. COALESCE(jsonb_array_length(v.tiers), 0) - 1 LOOP
      t := v.tiers -> i;
      IF (t->>'from')::int > cap THEN
        INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
        VALUES (p.id, p.catalogue_no, p.title, 'dropped_tier', jsonb_build_object(
          'fromVersion', v.version, 'tier', (t->>'from') || '–' || (t->>'to'), 'maxGroup', cap, 'tierWas', t));
        CONTINUE;
      END IF;
      IF (t->>'to')::int > cap THEN
        INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
        VALUES (p.id, p.catalogue_no, p.title, 'clamped', jsonb_build_object(
          'fromVersion', v.version, 'was', (t->>'from') || '–' || (t->>'to'), 'now', (t->>'from') || '–' || cap));
        t := jsonb_set(t, '{to}', to_jsonb(cap));
      END IF;
      new_tiers := new_tiers || jsonb_build_array(t);
      keep := keep || i;
    END LOOP;
    new_lines := '[]'::jsonb;
    FOR l IN SELECT x FROM jsonb_array_elements(COALESCE(v.cost_lines, '[]'::jsonb)) x LOOP
      amounts := COALESCE((SELECT jsonb_agg(l->'amounts'->k ORDER BY k) FROM unnest(keep) k), '[]'::jsonb);
      new_lines := new_lines || jsonb_build_array(jsonb_set(l, '{amounts}', amounts));
    END LOOP;

    INSERT INTO catalogue_rate_cards (product_id, currency, tiers, cost_lines, commission_pct, source, created_by, created_at, updated_by, updated_at)
    VALUES (p.id, COALESCE(v.currency, 'EGP'), new_tiers, new_lines, COALESCE(v.commission_pct, 10),
      jsonb_build_object('migration066', jsonb_build_object('fromVersion', v.version, 'publishedBy', v.published_by, 'publishedAt', v.published_at)),
      'migration 066', now(), COALESCE(v.published_by, 'migration 066'), COALESCE(v.published_at, now()));
    INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
    VALUES (p.id, p.catalogue_no, p.title, 'card', jsonb_build_object('fromVersion', v.version, 'tiers', new_tiers, 'costLines', jsonb_array_length(new_lines)));

    FOR d IN SELECT * FROM catalogue_rate_versions WHERE product_id = p.id AND state = 'draft' AND version > v.version LOOP
      INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
      VALUES (p.id, p.catalogue_no, p.title, 'newer_draft', jsonb_build_object(
        'draftVersion', d.version, 'keptVersion', v.version, 'tiers', d.tiers, 'costLines', d.cost_lines,
        'commissionPct', d.commission_pct, 'createdBy', d.created_by,
        'note', 'not used: the published version became the rate card. Apply what you want from this draft in Admin → Rate card.'));
    END LOOP;
  END LOOP;

  -- 3. departures locked to a version keep it, unchanged, as their snapshot
  FOR d IN
    SELECT cd.id AS departure_id, cd.date, cd.rate_locked_at, c.id AS product_id, c.catalogue_no, c.title,
           rv.version, rv.tiers, rv.cost_lines, rv.commission_pct, rv.currency
      FROM catalogue_departures cd
      JOIN catalogue_rate_versions rv ON rv.id = cd.rate_version_id
      JOIN catalogue_products c ON c.id = cd.product_id
     WHERE cd.rate_snapshot IS NULL
  LOOP
    UPDATE catalogue_departures SET rate_snapshot = jsonb_build_object(
      'tiers', d.tiers, 'costLines', COALESCE(d.cost_lines, '[]'::jsonb), 'commissionPct', d.commission_pct,
      'currency', COALESCE(d.currency, 'EGP'), 'takenAt', COALESCE(d.rate_locked_at, now()),
      'from', 'version ' || d.version || ' (migration 066)')
     WHERE id = d.departure_id;
    INSERT INTO rate_card_migration_066 (product_id, catalogue_no, title, kind, detail)
    VALUES (d.product_id, d.catalogue_no, d.title, 'snapshot', jsonb_build_object('departureId', d.departure_id, 'date', d.date, 'version', d.version));
  END LOOP;

  -- 4. nothing references the versions any more; then they go
  FOR d IN
    SELECT con.conname, cls.relname FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
     WHERE con.contype = 'f' AND con.confrelid = 'catalogue_rate_versions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', d.relname, d.conname);
  END LOOP;
  ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
  DELETE FROM catalogue_rate_versions;
  ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;
END $$;

-- First seat: the departure takes a snapshot of its product's rate card (and
-- the specification in force, as before). In the booking's own transaction; a
-- failure never fails the booking (the status job snapshots anything missed).
CREATE OR REPLACE FUNCTION catalogue_lock_on_first_seat() RETURNS trigger AS $$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Cairo')::date;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  BEGIN
    UPDATE catalogue_departures cd
       SET rate_snapshot = jsonb_build_object(
             'tiers', rc.tiers, 'costLines', rc.cost_lines, 'commissionPct', rc.commission_pct, 'currency', rc.currency,
             'takenAt', now(), 'cardUpdatedAt', rc.updated_at, 'cardUpdatedBy', rc.updated_by),
           rate_locked_at = now()
      FROM catalogue_rate_cards rc
     WHERE cd.legacy_departure_id = NEW.departure_id AND cd.rate_snapshot IS NULL AND rc.product_id = cd.product_id;
    UPDATE catalogue_departures cd
       SET spec_version_id = s.id
      FROM (SELECT DISTINCT ON (product_id) id, product_id FROM catalogue_spec_versions
             WHERE state = 'published' AND effective_from <= today
             ORDER BY product_id, effective_from DESC, version DESC) s
     WHERE cd.legacy_departure_id = NEW.departure_id AND cd.spec_version_id IS NULL AND s.product_id = cd.product_id;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'catalogue_lock_on_first_seat for departure %: %', NEW.departure_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_catalogue_lock_on_first_seat ON pledges;
CREATE TRIGGER trg_catalogue_lock_on_first_seat AFTER INSERT ON pledges
  FOR EACH ROW EXECUTE FUNCTION catalogue_lock_on_first_seat();
