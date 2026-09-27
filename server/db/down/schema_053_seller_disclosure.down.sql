-- Rollback for 053 (seller disclosure). Drops what 053 added. Lost with it:
-- the licence numbers shown to travelers, the activation block, and each
-- receipt's recorded seller and number, the receipt history (superseded
-- receipts) and any seller-change offers.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_053_seller_disclosure.down.sql
BEGIN;
DROP TABLE IF EXISTS seller_change_offers;
DROP TABLE IF EXISTS payment_receipts;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS receipt_issued_at;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS receipt_no;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS seller_licence_no;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS seller_legal_name;
ALTER TABLE payment_requests DROP COLUMN IF EXISTS seller_operator_id;
ALTER TABLE operators DROP COLUMN IF EXISTS activation_blocked;
ALTER TABLE operators DROP COLUMN IF EXISTS traveller_licence_no;
DELETE FROM schema_migrations WHERE name = '053_seller_disclosure';
COMMIT;
