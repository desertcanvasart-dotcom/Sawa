-- Rollback of 063. Only safe while every product and date still has ONE
-- departure: a second numbered departure would violate the restored unique
-- constraint (cancel or merge it first). The rate drafts created by 063 stay
-- (drafts are harmless; delete them in the rate card if unwanted), and the
-- maximum group values are not restored.
DROP INDEX IF EXISTS uq_catalogue_departures_product_date_no;
ALTER TABLE catalogue_departures ADD CONSTRAINT uq_catalogue_departures_product_date UNIQUE (product_id, date);
ALTER TABLE catalogue_departures DROP CONSTRAINT IF EXISTS catalogue_departures_fee_override_chk;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS operator_fee_pct_override;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS operator_fee_override_reason;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS operator_fee_override_by;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS operator_fee_override_at;
ALTER TABLE catalogue_departures DROP COLUMN IF EXISTS departure_no;
ALTER TABLE catalogue_products DROP CONSTRAINT IF EXISTS catalogue_products_group_chk;
ALTER TABLE catalogue_products ADD CONSTRAINT catalogue_products_group_chk
  CHECK (goahead_min >= 1 AND max_group <= 12 AND max_group >= goahead_min);
ALTER TABLE catalogue_products ALTER COLUMN max_group SET DEFAULT 12;
DELETE FROM schema_migrations WHERE name = '063_numbered_departures';
