-- 047: the Sawa catalogue and its departure calendar (model phase 1).
--
-- ⚠️ Migrations do not run on deploy (B5). Until this is applied, the catalogue
-- screens say so, the calendar jobs do nothing, and the public site is
-- unchanged whatever the catalogue_v2 flag says:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_047_catalogue_calendar.down.sql drops only
-- what this file creates. Nothing here alters an existing table or row.
--
-- ============================================================================
-- WHAT THIS ADDS
-- ============================================================================
--
-- Sawa owns a fixed catalogue (docs/model/catalogue.md) and creates departures
-- from a calendar; operators no longer list products or dates. This adds the
-- catalogue beside the existing tour_products table rather than rewriting it:
--
--   catalogue_products        one row per catalogue product (#1–#21)
--   catalogue_spec_versions   the product specification, versioned; a
--                             published version is immutable
--   catalogue_calendar_rules  weekdays (optionally every N weeks) or explicit
--                             dates, each with an active window
--   catalogue_departures      a product on a date, UNIQUE (product, date)
--   catalogue_events          stubs for later phases (traveller messages, the
--                             next-date offer); nothing consumes them yet
--
-- Bookings are NOT moved. A catalogue departure is sold through the existing
-- booking engine via legacy_departure_id → departures(id), and its seats are
-- counted from pledges on that row (catalogue_departure_seats). A catalogue
-- product is bookable only once linked to a tour_products row, which still
-- carries the price (pricing changes belong to a later phase).
--
-- Re-running this file changes nothing: every insert is keyed and create-only,
-- so edits made in the admin tools always survive a later `db:migrate`.

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalogue_products (
  id                   BIGSERIAL PRIMARY KEY,
  catalogue_no         SMALLINT NOT NULL UNIQUE CHECK (catalogue_no BETWEEN 1 AND 999),
  code                 TEXT NOT NULL UNIQUE,
  slug                 TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title                TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('day_tour', 'one_way_road_tour', 'cruise', 'multi_day')),
  base_city            TEXT NOT NULL,
  end_city             TEXT,
  status               TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('active', 'held', 'retired')),
  merged_into_id       BIGINT REFERENCES catalogue_products(id) ON DELETE SET NULL,
  goahead_min          SMALLINT NOT NULL DEFAULT 4,
  max_group            SMALLINT NOT NULL DEFAULT 12,
  cutoff_hours         SMALLINT NOT NULL DEFAULT 48 CHECK (cutoff_hours BETWEEN 0 AND 2160),
  goahead_deadline_days SMALLINT CHECK (goahead_deadline_days BETWEEN 1 AND 365),
  -- The existing listing this product is sold through (price, images, the
  -- booking engine). NULL = not bookable yet.
  legacy_product_id    TEXT UNIQUE REFERENCES tour_products(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalogue_products_group_chk CHECK (goahead_min >= 1 AND max_group <= 12 AND max_group >= goahead_min),
  -- A GoAhead deadline is required for cruises and multi-day, and empty otherwise.
  CONSTRAINT catalogue_products_deadline_chk
    CHECK ((type IN ('cruise', 'multi_day')) = (goahead_deadline_days IS NOT NULL)),
  CONSTRAINT catalogue_products_end_city_chk
    CHECK (type <> 'one_way_road_tour' OR end_city IS NOT NULL),
  CONSTRAINT catalogue_products_merge_chk
    CHECK (merged_into_id IS NULL OR (status = 'retired' AND merged_into_id <> id))
);

-- ---------------------------------------------------------------------------
-- A specification is a draft until published. Publishing fixes its content and
-- its effective date for good; a change is a new version. At most one draft per
-- product. The ACTIVE version is the published one with the latest effective
-- date on or before today (Cairo).
CREATE TABLE IF NOT EXISTS catalogue_spec_versions (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  state           TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  effective_from  DATE,
  content         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content) = 'object'),
  -- Where any pre-filled field came from, so a reviewer can check it.
  sources         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by    TEXT,
  published_at    TIMESTAMPTZ,
  UNIQUE (product_id, version),
  CONSTRAINT catalogue_spec_published_chk
    CHECK (state = 'draft' OR (effective_from IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_spec_one_draft
  ON catalogue_spec_versions (product_id) WHERE state = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_spec_effective
  ON catalogue_spec_versions (product_id, effective_from) WHERE state = 'published';

-- A published version never changes. Refused in the database, not only in the
-- route, so no future code path can quietly rewrite what a departure was sold
-- under.
CREATE OR REPLACE FUNCTION catalogue_spec_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'catalogue_spec_versions %: a published specification cannot be changed; create a new version', OLD.id;
  END IF;
  -- A BEFORE DELETE trigger that returns NULL silently skips the delete.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_catalogue_spec_immutable ON catalogue_spec_versions;
CREATE TRIGGER trg_catalogue_spec_immutable
  BEFORE UPDATE OR DELETE ON catalogue_spec_versions
  FOR EACH ROW EXECUTE FUNCTION catalogue_spec_immutable();

-- ---------------------------------------------------------------------------
-- kind 'weekdays': 0 = Sunday … 6 = Saturday, as tour_products.operating_days.
--   interval_weeks > 1 means every Nth week counted from anchor_date (for the
--   fortnightly multi-day tours).
-- kind 'dates': an explicit list, for ship sailing days.
CREATE TABLE IF NOT EXISTS catalogue_calendar_rules (
  id              BIGSERIAL PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('weekdays', 'dates')),
  weekdays        SMALLINT[],
  interval_weeks  SMALLINT NOT NULL DEFAULT 1 CHECK (interval_weeks BETWEEN 1 AND 8),
  anchor_date     DATE,
  dates           DATE[],
  active_from     DATE NOT NULL,
  active_to       DATE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalogue_rules_shape_chk CHECK (
    (kind = 'weekdays' AND weekdays IS NOT NULL AND cardinality(weekdays) > 0
       AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]
       AND (interval_weeks = 1 OR anchor_date IS NOT NULL))
    OR (kind = 'dates' AND dates IS NOT NULL)
  ),
  CONSTRAINT catalogue_rules_window_chk CHECK (active_to IS NULL OR active_to >= active_from)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_rules_product ON catalogue_calendar_rules (product_id);

-- ---------------------------------------------------------------------------
-- origin 'generated' = made from a calendar rule by the generator job.
-- origin 'adopted'   = an existing departure (with bookings in progress) that
--                      the generator linked instead of duplicating. Adopted
--                      departures keep the legacy rules: the status job never
--                      cancels them.
CREATE TABLE IF NOT EXISTS catalogue_departures (
  id                   BIGSERIAL PRIMARY KEY,
  product_id           BIGINT NOT NULL REFERENCES catalogue_products(id) ON DELETE CASCADE,
  date                 DATE NOT NULL,
  spec_version_id      BIGINT REFERENCES catalogue_spec_versions(id) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'go_ahead', 'cancelled_below_minimum', 'completed')),
  origin               TEXT NOT NULL DEFAULT 'generated' CHECK (origin IN ('generated', 'adopted')),
  legacy_departure_id  INTEGER UNIQUE REFERENCES departures(id) ON DELETE SET NULL,
  run_below_minimum    BOOLEAN NOT NULL DEFAULT false,
  override_by          TEXT,
  override_reason      TEXT,
  override_at          TIMESTAMPTZ,
  status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_catalogue_departures_product_date UNIQUE (product_id, date),
  CONSTRAINT catalogue_departures_override_chk
    CHECK (NOT run_below_minimum OR (override_by IS NOT NULL AND override_at IS NOT NULL
                                     AND length(trim(coalesce(override_reason, ''))) > 0))
);
CREATE INDEX IF NOT EXISTS idx_catalogue_departures_date ON catalogue_departures (date);
CREATE INDEX IF NOT EXISTS idx_catalogue_departures_status ON catalogue_departures (status);

-- Seats sold, derived from bookings and never stored by hand.
CREATE OR REPLACE VIEW catalogue_departure_seats AS
  SELECT cd.id AS catalogue_departure_id,
         COALESCE((SELECT SUM(p.seats) FROM pledges p
                    WHERE p.departure_id = cd.legacy_departure_id AND p.status <> 'cancelled'), 0)::INTEGER AS seats_sold
    FROM catalogue_departures cd;

-- ---------------------------------------------------------------------------
-- Events for later phases. Written by the status job; nothing sends anything.
CREATE TABLE IF NOT EXISTS catalogue_events (
  id             BIGSERIAL PRIMARY KEY,
  type           TEXT NOT NULL,
  departure_id   BIGINT REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_catalogue_events_unprocessed ON catalogue_events (created_at) WHERE processed_at IS NULL;
-- One event of each type per departure: a job that runs twice must not queue
-- the same traveller message twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_events_once ON catalogue_events (departure_id, type);

-- ============================================================================
-- SEED: the 21 products (docs/model/catalogue.md), statuses per
-- docs/model-audit/03-migration-plan.md §4. Create-only.
-- ============================================================================
INSERT INTO catalogue_products
  (catalogue_no, code, slug, title, type, base_city, end_city, status, goahead_deadline_days)
VALUES
  (1,  'P01', 'giza-pyramids-sphinx-grand-egyptian-museum-from-cairo', 'Giza Pyramids, Sphinx & the Grand Egyptian Museum', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (2,  'P02', 'giza-uncovered-pyramids-sphinx-stories-from-cairo', 'Giza Uncovered: Pyramids, Sphinx & Stories', 'day_tour', 'Cairo', NULL, 'held', NULL),
  (3,  'P03', 'secrets-grand-egyptian-museum-from-cairo', 'Secrets of the Grand Egyptian Museum', 'day_tour', 'Cairo', NULL, 'held', NULL),
  (4,  'P04', 'memphis-saqqara-dahshur-birth-pyramid-from-cairo', 'Memphis, Saqqara & Dahshur: Birth of the Pyramid', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (5,  'P05', 'cairo-to-alexandria-mediterranean-day-tour', 'Cairo to Alexandria: the Mediterranean Day Tour', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (6,  'P06', 'fayoum-oasis-meidum-hawara-pyramids-from-cairo', 'Fayoum Oasis, Meidum & Hawara Pyramids', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (7,  'P07', 'whale-valley-wadi-el-rayan-fayoum-desert-safari-from-cairo', 'Whale Valley & Wadi El Rayan: Fayoum Desert Safari', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (8,  'P08', 'full-day-minya-archaeological-tour-from-cairo', 'Full Day Minya Archaeological Tour', 'day_tour', 'Cairo', NULL, 'active', NULL),
  (9,  'P09', 'luxor-in-depth-east-west-bank-full-day', 'Luxor in Depth: East & West Bank Full Day', 'day_tour', 'Luxor', NULL, 'active', NULL),
  (10, 'P10', 'grand-west-bank-tombs-temples-deir-el-medina-from-luxor', 'The Grand West Bank: Tombs, Temples & Deir el-Medina', 'day_tour', 'Luxor', NULL, 'active', NULL),
  (11, 'P11', 'dendera-abydos-far-temples-north-luxor', 'Dendera & Abydos: the Far Temples North of Luxor', 'day_tour', 'Luxor', NULL, 'active', NULL),
  (12, 'P12', 'aswan-highlights-unfinished-obelisk-high-dam-philae', 'Aswan Highlights: Unfinished Obelisk, High Dam & Philae', 'day_tour', 'Aswan', NULL, 'active', NULL),
  (13, 'P13', 'aswan-to-abu-simbel-temples-ramesses-ii-nefertari', 'Aswan to Abu Simbel: Temples of Ramesses II & Nefertari', 'day_tour', 'Aswan', NULL, 'active', NULL),
  (14, 'P14', 'luxor-to-aswan-edfu-kom-ombo-temple-road', 'Luxor to Aswan: Edfu & Kom Ombo Temple Road', 'one_way_road_tour', 'Luxor', 'Aswan', 'retired', NULL),
  (15, 'P15', 'luxor-to-aswan-esna-edfu-kom-ombo-temple-road', 'Luxor to Aswan: Esna, Edfu & Kom Ombo Temple Road', 'one_way_road_tour', 'Luxor', 'Aswan', 'active', NULL),
  (16, 'P16', 'kom-ombo-edfu-esna-downriver-from-aswan-to-luxor', 'Kom Ombo, Edfu & Esna: Downriver from Aswan to Luxor', 'one_way_road_tour', 'Aswan', 'Luxor', 'active', NULL),
  -- GoAhead deadline 21 days: the draft agreements' example ("for example 21
  -- days before departure"). A placeholder to confirm per product.
  (17, 'P17', 'nile-discovery-4-day-cruise-from-aswan-to-luxor', 'Nile Discovery: 4-Day Cruise from Aswan to Luxor', 'cruise', 'Aswan', 'Luxor', 'active', 21),
  (18, 'P18', 'nile-majesty-5-day-river-cruise-from-luxor', 'Nile Majesty: 5-Day River Cruise from Luxor', 'cruise', 'Luxor', NULL, 'active', 21),
  (19, 'P19', 'cairo-luxor-4-day-discovery', 'Cairo and Luxor 4-Day Discovery', 'multi_day', 'Cairo', 'Luxor', 'active', 21),
  (20, 'P20', 'egypt-in-depth-9-day-nile-cruise-cairo', 'Egypt in Depth: 9-Day Nile Cruise & Cairo', 'multi_day', 'Cairo', NULL, 'active', 21),
  (21, 'P21', 'egypt-end-to-end-cairo-nile-cruise-hurghada-12-days', 'Egypt End to End: Cairo, Nile Cruise & Hurghada, 12 Days', 'multi_day', 'Cairo', NULL, 'active', 21)
ON CONFLICT (catalogue_no) DO NOTHING;

-- #14 is merged into #15.
UPDATE catalogue_products c14 SET merged_into_id = c15.id
  FROM catalogue_products c15
 WHERE c14.catalogue_no = 14 AND c15.catalogue_no = 15 AND c14.merged_into_id IS NULL;

-- ---------------------------------------------------------------------------
-- Link each product to the existing listing it is sold through. By known id
-- first; otherwise by title, and only when exactly one approved listing
-- matches. Unmatched products stay unlinked (not bookable) until an admin
-- links them in the product editor. Never overwrites an existing link.
WITH wanted (catalogue_no, known_id, title_like) AS (VALUES
  (1,  'tour_giza_pyramids_sphinx_the_grand_e_mq41k335', '%Giza Pyramids, Sphinx%Grand Egyptian Museum%'),
  (2,  NULL, '%Giza Uncovered%'),
  (3,  NULL, '%Secrets of the Grand Egyptian Museum%'),
  (4,  'tour_memphis_saqqara_dahshur_birth_of_mq41k505', '%Memphis, Saqqara%'),
  (5,  'tour_cairo_to_alexandria_the_mediterr_mq41k6qb', '%Cairo to Alexandria%'),
  (6,  NULL, '%Fayoum Oasis%'),
  (7,  NULL, '%Whale Valley%'),
  (8,  NULL, '%Minya%'),
  (9,  'tour_luxor_in_depth_east_west_bank_fu_mq41k8ks', '%Luxor in Depth%'),
  (10, 'tour_the_grand_west_bank_tombs_temple_mq41kaab', '%Grand West Bank%'),
  (11, 'tour_dendera_abydos_the_far_temples_n_mq41kc7l', '%Dendera%Abydos%'),
  (12, 'tour_aswan_highlights_unfinished_obel_mq40h29k', '%Aswan Highlights%'),
  (13, 'tour_aswan_to_abu_simbel_temples_of_r_mq40h4p7', '%Abu Simbel%'),
  (14, 'tour_luxor_to_aswan_edfu_kom_ombo_tem_mq40h77c', NULL),
  (15, 'tour_luxor_to_aswan_esna_edfu_kom_omb_mq41ke7h', NULL),
  (16, 'tour_kom_ombo_edfu_esna_downriver_fro_ms4fly0m', '%Downriver from Aswan%'),
  (17, NULL, '%Nile Discovery%'),
  (18, 'pkg_nile_majesty_luxor_5d', '%Nile Majesty%'),
  (19, 'pkg_cairo_luxor_4d', '%Cairo and Luxor 4%'),
  (20, 'pkg_egypt_nile_cruise_9d', '%Egypt in Depth%'),
  (21, 'pkg_egypt_end_to_end_cairo_nile_crui_msj33v2z', '%Egypt End to End%')
), resolved AS (
  SELECT w.catalogue_no,
         COALESCE(
           (SELECT t.id FROM tour_products t WHERE t.id = w.known_id),
           (SELECT MIN(t.id) FROM tour_products t
             WHERE w.title_like IS NOT NULL AND t.title ILIKE w.title_like AND t.status = 'approved'
            HAVING COUNT(*) = 1)
         ) AS legacy_id
    FROM wanted w
)
UPDATE catalogue_products c SET legacy_product_id = r.legacy_id, updated_at = now()
  FROM resolved r
 WHERE c.catalogue_no = r.catalogue_no AND c.legacy_product_id IS NULL AND r.legacy_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM catalogue_products o WHERE o.legacy_product_id = r.legacy_id);

-- ---------------------------------------------------------------------------
-- Draft specification v1 for every product that has none. Every field starts
-- empty. Where the linked listing already describes the product on the live
-- tour page, that text is copied in and its source recorded; nothing is
-- invented. Vehicle and guide wording from the listing is kept under
-- "reference" only: it doesn't state a class per group-size band or a
-- language, so it can't fill those fields.
INSERT INTO catalogue_spec_versions (product_id, version, state, content, sources, created_by)
SELECT c.id, 1, 'draft',
  jsonb_build_object(
    'itinerary',      COALESCE(t.itinerary, '[]'::jsonb),
    'startTime',      t.default_time,
    'duration',       t.duration,
    'inclusions',     COALESCE(t.included, '[]'::jsonb),
    'exclusions',     COALESCE(t.not_included, '[]'::jsonb),
    'vehicleByBand',  jsonb_build_object('4-6', NULL, '7-9', NULL, '10-12', NULL),
    'guideLanguages', '[]'::jsonb,
    'meals',          NULL,
    'pickupArea',     NULLIF(concat_ws(' ', t.meeting_point, t.pickup_note), ''),
    'pickupWindow',   NULL,
    'addons',         '[]'::jsonb,
    'roomCategories', CASE WHEN c.type IN ('cruise', 'multi_day')
                        THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('name', tier->>'name', 'occupancy', '[]'::jsonb))
                                         FROM jsonb_array_elements(COALESCE(t.accommodation_tiers, '[]'::jsonb)) tier), '[]'::jsonb)
                        ELSE '[]'::jsonb END,
    'reference',      jsonb_strip_nulls(jsonb_build_object('vehicle', t.vehicle, 'guide', t.guide))
  ),
  CASE WHEN t.id IS NULL THEN jsonb_build_object('note', 'No existing listing describes this product; every field is to complete.')
       ELSE jsonb_build_object(
         'copiedFrom', 'tour_products.' || t.id || ' (the listing behind the live tour page; a snapshot is in site/_dev_bootstrap.json)',
         'fields', 'itinerary, startTime, duration, inclusions, exclusions, pickupArea, roomCategories (names only), reference') END,
  'migration 047'
  FROM catalogue_products c
  LEFT JOIN tour_products t ON t.id = c.legacy_product_id
 WHERE NOT EXISTS (SELECT 1 FROM catalogue_spec_versions s WHERE s.product_id = c.id);

-- ---------------------------------------------------------------------------
-- Calendar rules from the suggested frequencies. "N× weekly" weekdays are a
-- first pick, listed in docs/phase1/REPORT.md for review. Cruises get none
-- until ship sailing days are entered; held and retired products get none.
-- Only for products that have no rule yet.
INSERT INTO catalogue_calendar_rules (product_id, kind, weekdays, interval_weeks, anchor_date, active_from, note)
SELECT c.id, 'weekdays', r.weekdays::SMALLINT[], r.interval_weeks, r.anchor::DATE, DATE '2026-10-01', r.note
  FROM (VALUES
    (1,  '{0,1,2,3,4,5,6}', 1, NULL, 'Daily'),
    (4,  '{2,4,6}',         1, NULL, '3× weekly: Tue, Thu, Sat'),
    (5,  '{0,4}',           1, NULL, '2× weekly: Sun, Thu'),
    (6,  '{3}',             1, NULL, 'Weekly: Wed'),
    (7,  '{6}',             1, NULL, 'Weekly: Sat'),
    (8,  '{4}',             1, NULL, 'Weekly: Thu'),
    (9,  '{0,1,2,3,4,5,6}', 1, NULL, 'Daily'),
    (10, '{1,3,5}',         1, NULL, '3× weekly: Mon, Wed, Fri'),
    (11, '{3,6}',           1, NULL, '2× weekly: Wed, Sat'),
    (12, '{0,1,2,3,4,5,6}', 1, NULL, 'Daily'),
    (13, '{0,1,2,3,4,5,6}', 1, NULL, 'Daily'),
    (15, '{1,3,5}',         1, NULL, '3× weekly: Mon, Wed, Fri (Luxor → Aswan)'),
    (16, '{2,4,6}',         1, NULL, '3× weekly: Tue, Thu, Sat (Aswan → Luxor, alternating with #15)'),
    (19, '{6}',             1, NULL, 'Weekly: Sat'),
    (20, '{5}',             2, '2026-11-13', 'Fortnightly: Fri, anchored on an existing departure date'),
    (21, '{6}',             2, '2026-10-10', 'Fortnightly: Sat')
  ) AS r(catalogue_no, weekdays, interval_weeks, anchor, note)
  JOIN catalogue_products c ON c.catalogue_no = r.catalogue_no
 WHERE NOT EXISTS (SELECT 1 FROM catalogue_calendar_rules x WHERE x.product_id = c.id);

ALTER TABLE catalogue_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_spec_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_calendar_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_departures ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogue_events ENABLE ROW LEVEL SECURITY;
