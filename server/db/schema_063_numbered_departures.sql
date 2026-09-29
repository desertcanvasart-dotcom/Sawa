-- 063: phase 6, behind catalogue_v2 (decided 29 Sep 2026).
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_063_numbered_departures.down.sql.
--
-- 1. NUMBERED DEPARTURES. "One departure per product per date" becomes "one or
--    more numbered departures (1, 2, …)". The system opens the next one when a
--    party fits in none of the existing ones; the generator only ever makes
--    number 1. Each one is a row of its own, so its GoAhead, operator offer,
--    payment requests, manifest and settlement are its own already (they are
--    all keyed on the departure id).
-- 2. THE MAXIMUM GROUP is 8, per product, with an override up to 12 for cruises
--    and multi-day only.
-- 3. ONE PRICE. A rate version now defaults to one tier, 4–8. Every existing
--    version with several tiers gets a NEW DRAFT built from its first tier's
--    price, cost amounts and operator fee. Nothing is published: each product is
--    listed by scripts/phase6-report.js for review.
-- 4. THE OPERATOR FEE, per departure: a percentage and a reason, editable
--    until the operator acknowledges the offer.

-- ---------------------------------------------------------------- 1
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS departure_no SMALLINT NOT NULL DEFAULT 1 CHECK (departure_no >= 1);
ALTER TABLE catalogue_departures DROP CONSTRAINT IF EXISTS uq_catalogue_departures_product_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogue_departures_product_date_no ON catalogue_departures (product_id, date, departure_no);

-- ---------------------------------------------------------------- 4
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS operator_fee_pct_override NUMERIC(5,2)
  CHECK (operator_fee_pct_override >= 0 AND operator_fee_pct_override <= 100);
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS operator_fee_override_reason TEXT;
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS operator_fee_override_by TEXT;
ALTER TABLE catalogue_departures ADD COLUMN IF NOT EXISTS operator_fee_override_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalogue_departures_fee_override_chk') THEN
    ALTER TABLE catalogue_departures ADD CONSTRAINT catalogue_departures_fee_override_chk
      CHECK (operator_fee_pct_override IS NULL
             OR (operator_fee_override_by IS NOT NULL AND operator_fee_override_at IS NOT NULL
                 AND length(trim(coalesce(operator_fee_override_reason, ''))) > 0));
  END IF;
END $$;

-- ---------------------------------------------------------------- 2
ALTER TABLE catalogue_products ALTER COLUMN max_group SET DEFAULT 8;
ALTER TABLE catalogue_products DROP CONSTRAINT IF EXISTS catalogue_products_group_chk;
-- Every existing product sat at the old default of 12, none by choice: all go to 8.
UPDATE catalogue_products SET max_group = 8 WHERE max_group > 8;
ALTER TABLE catalogue_products ADD CONSTRAINT catalogue_products_group_chk
  CHECK (goahead_min >= 1 AND max_group >= goahead_min
         AND (max_group <= 8 OR (type IN ('cruise', 'multi_day') AND max_group <= 12)));
-- The ordinary departure a catalogue date is sold through carries the maximum.
-- One already holding more than the new maximum keeps every booking and is full.
UPDATE departures d SET max_seats = LEAST(d.max_seats, GREATEST(cp.max_group, COALESCE((
    SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status IS DISTINCT FROM 'cancelled'), 0)))
  FROM catalogue_departures cd JOIN catalogue_products cp ON cp.id = cd.product_id
 WHERE cd.legacy_departure_id = d.id
   AND d.max_seats > GREATEST(cp.max_group, COALESCE((
    SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status IS DISTINCT FROM 'cancelled'), 0));

-- ---------------------------------------------------------------- 3
-- A draft still carrying several tiers is reduced in place; a product whose
-- latest published version has several tiers, and that has no draft, gets a
-- new draft. A draft already at one tier is left as it is. The new draft is
-- never published. `source.migration063` says what it was made from.
DO $$
DECLARE
  v RECORD;
  t0 JSONB;
  new_tiers JSONB;
  new_lines JSONB;
  note JSONB;
BEGIN
  FOR v IN
    SELECT DISTINCT ON (product_id) *
      FROM catalogue_rate_versions
     WHERE tiers IS NOT NULL AND jsonb_typeof(tiers) = 'array'
     ORDER BY product_id, (state = 'draft') DESC, version DESC
  LOOP
    CONTINUE WHEN jsonb_array_length(v.tiers) < 2;
    t0 := v.tiers -> 0;
    new_tiers := jsonb_build_array(jsonb_build_object(
      'from', 4, 'to', 8, 'priceEgp', t0 -> 'priceEgp', 'operatorFeePct', t0 -> 'operatorFeePct'));
    new_lines := COALESCE((SELECT jsonb_agg(jsonb_set(l, '{amounts}', jsonb_build_array(l -> 'amounts' -> 0)) ORDER BY ord)
                             FROM jsonb_array_elements(COALESCE(v.cost_lines, '[]'::jsonb)) WITH ORDINALITY AS x(l, ord)), '[]'::jsonb);
    note := jsonb_build_object('migration063', jsonb_build_object(
      'at', now(), 'from', format('version %s (%s)', v.version, v.state),
      'note', 'one tier 4–8 from the first tier: price, cost amounts and operator fee; for review, not published'));
    IF v.state = 'draft' THEN
      UPDATE catalogue_rate_versions SET tiers = new_tiers, cost_lines = new_lines, source = source || note WHERE id = v.id;
    ELSE
      INSERT INTO catalogue_rate_versions
        (product_id, version, state, currency, per_traveler, fee_4_6, fee_7_9, fee_10_12, land_per_traveler, room_twin, room_single,
         commission_per_seat, source, created_by, tiers, cost_lines, commission_pct, eur_rate)
      SELECT v.product_id, (SELECT MAX(version) + 1 FROM catalogue_rate_versions WHERE product_id = v.product_id), 'draft', v.currency,
             v.per_traveler, v.fee_4_6, v.fee_7_9, v.fee_10_12, v.land_per_traveler, v.room_twin, v.room_single,
             v.commission_per_seat, note, 'migration 063', new_tiers, new_lines, v.commission_pct, v.eur_rate
       WHERE NOT EXISTS (SELECT 1 FROM catalogue_rate_versions d WHERE d.product_id = v.product_id AND d.state = 'draft');
    END IF;
  END LOOP;
END $$;
