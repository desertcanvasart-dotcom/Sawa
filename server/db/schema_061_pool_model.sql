-- 061: the pricing and money model (phase 5, final 28 Sep 2026), behind
-- catalogue_v2. The calculation is shared/pool-model.js; this is its storage.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Rollback: server/db/down/schema_061_pool_model.down.sql. Additive: new
-- columns and one table. The old rate columns stay, untouched, so the
-- rollback loses nothing but what was entered in the new ones.
--
-- A rate version now carries, all in EGP:
--   tiers           [{ from, to, priceEgp, operatorFeePct }]   the selling price per traveler and
--                   the operator fee (% of operating cost), per tier
--   cost_lines      [{ name, basis: per_group | per_traveller, amounts: [one per tier] }]
--   commission_pct  the collecting agent's commission, % of the selling price (default 10)
--   eur_rate        the published EUR rate (EGP per EUR): only for showing
--                   and charging travelers in EUR
--
-- Per departure, from the manifest at the cut-off: revenue = headcount × the
-- tier price; entitlement = operating cost × (1 + fee %), the operator's;
-- commission = revenue × commission %, the collecting agent's; pool = the rest, shared
-- per traveler: an agency-sold place earns it for the agency, a direct place
-- for the collecting agent. The fixed per-seat agency commission is retired.

ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS tiers JSONB;
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS cost_lines JSONB;
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 10
  CHECK (commission_pct >= 0 AND commission_pct < 100);
ALTER TABLE catalogue_rate_versions ADD COLUMN IF NOT EXISTS eur_rate NUMERIC(12,4) CHECK (eur_rate > 0);

-- Convert every existing version: the band fees become one per-group line,
-- the per-traveler amount (or land services) one per-traveler line, a twin
-- room half its rate per traveler; the operator fee is 0% and the selling
-- prices are left for an admin to enter (the operator rate card never had
-- them). What was converted is recorded on the version's `source`, and
-- scripts/pool-migration-report.js prints it. The same rule as
-- convertLegacyRate in shared/pool-model.js. Published versions are fixed, so
-- the immutability trigger is lifted for this one update only; nothing a
-- published version already said changes.
ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
UPDATE catalogue_rate_versions SET
  tiers = '[{"from":4,"to":6,"priceEgp":null,"operatorFeePct":0},{"from":7,"to":9,"priceEgp":null,"operatorFeePct":0},{"from":10,"to":12,"priceEgp":null,"operatorFeePct":0}]'::jsonb,
  cost_lines = jsonb_build_array(
      jsonb_build_object('name', 'Departure fee', 'basis', 'per_group', 'amounts', jsonb_build_array(fee_4_6, fee_7_9, fee_10_12)),
      jsonb_build_object('name', CASE WHEN per_traveler IS NULL AND land_per_traveler IS NOT NULL THEN 'Land services' ELSE 'Per traveler' END,
        'basis', 'per_traveller', 'amounts', jsonb_build_array(COALESCE(per_traveler, land_per_traveler), COALESCE(per_traveler, land_per_traveler), COALESCE(per_traveler, land_per_traveler))))
    || CASE WHEN room_twin IS NOT NULL THEN jsonb_build_array(jsonb_build_object('name', 'Room or cabin (twin share)', 'basis', 'per_traveller',
         'amounts', jsonb_build_array(round(room_twin / 2, 2), round(room_twin / 2, 2), round(room_twin / 2, 2)))) ELSE '[]'::jsonb END,
  source = source || jsonb_build_object('migration061', jsonb_build_object(
    'convertedAt', now(),
    'notes', to_jsonb(array_remove(ARRAY[
      CASE WHEN room_twin IS NOT NULL THEN format('twin room %s carried as %s per traveler', room_twin, round(room_twin / 2, 2)) END,
      CASE WHEN room_single IS NOT NULL THEN format('single room %s not carried (no per-room basis): add it as a cost line if it applies', room_single) END,
      CASE WHEN commission_per_seat IS NOT NULL THEN format('fixed agency commission %s per seat retired (agencies are paid from the pool)', commission_per_seat) END,
      CASE WHEN fee_4_6 IS NULL OR fee_7_9 IS NULL OR fee_10_12 IS NULL THEN 'a band fee was blank' END,
      'selling prices to enter'
    ], NULL))))
WHERE tiers IS NULL;
ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;

-- A booking keeps the published EUR rate in force when it was made; its
-- charges use that rate.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS published_eur_rate NUMERIC(12,4);

-- Agency pay from the pool. A row per agency booking, as before; `basis`
-- says which model it was made under. Pool rows are decided from the
-- departure's calculation: `earned_egp` = places × pool per traveler × share.
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'per_seat';
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS pool_per_traveller_egp NUMERIC(12,2);
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS share_factor NUMERIC(4,2);
ALTER TABLE agency_commissions ADD COLUMN IF NOT EXISTS earned_egp NUMERIC(12,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agency_commissions_basis_check') THEN
    ALTER TABLE agency_commissions ADD CONSTRAINT agency_commissions_basis_check CHECK (basis IN ('per_seat', 'pool'));
  END IF;
END $$;

-- The monthly agency statement: pool shares add up in EGP and are paid in
-- EUR at the CBE rate on the statement date.
ALTER TABLE commission_statements ADD COLUMN IF NOT EXISTS basis TEXT NOT NULL DEFAULT 'per_seat';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_statements_basis_check') THEN
    ALTER TABLE commission_statements ADD CONSTRAINT commission_statements_basis_check CHECK (basis IN ('per_seat', 'pool'));
  END IF;
END $$;

-- A departure that reaches a cheaper tier by the cut-off refunds the
-- difference to every paid traveler.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'payment_refunds'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE payment_refunds DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_kind_check
    CHECK (kind IN ('cancellation', 'resale', 'tier_difference'));
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_refunds_tier_difference ON payment_refunds (request_id)
  WHERE state <> 'cancelled' AND kind = 'tier_difference';

-- One departure's calculation, as last worked out: at the cut-off (the tier
-- and the refunds of the difference) and once it is over (the shares). The
-- operator statement, the agency statements, the margin report and Finance
-- all read this one record.
CREATE TABLE IF NOT EXISTS catalogue_departure_economics (
  departure_id     BIGINT PRIMARY KEY REFERENCES catalogue_departures(id) ON DELETE CASCADE,
  rate_version_id  BIGINT REFERENCES catalogue_rate_versions(id),
  stage            TEXT NOT NULL CHECK (stage IN ('cutoff', 'final')),
  headcount        INTEGER NOT NULL CHECK (headcount >= 0),
  economics        JSONB NOT NULL,
  places           JSONB NOT NULL DEFAULT '[]'::jsonb,
  shares           JSONB,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE catalogue_departure_economics ENABLE ROW LEVEL SECURITY;
