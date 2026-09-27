-- 053: the seller of a catalog departure, and Online Era as collecting agent
-- (decided 27 Sep 2026), behind catalogue_v2.
--
-- ⚠️ Migrations do not run on deploy (B5). Apply by hand, after 052.
-- Rollback: server/db/down/schema_053_seller_disclosure.down.sql. Additive.
--
-- The operator assigned at GoAhead is the seller of each departure; Online
-- Era (Commercial Registration 148500) is its commercial and payment-
-- collection agent. From the assignment, the payment request, receipt,
-- voucher and booking page name the operator's legal name and the licence
-- number shown to travelers, and the collecting agent as payee.
--
--   operators.traveller_licence_no   the licence number shown to travelers
--   operators.activation_blocked     a record that must never be activated
--   payment_requests.seller_* / receipt_*
--                                    who the receipt named, fixed when issued

ALTER TABLE operators ADD COLUMN IF NOT EXISTS traveller_licence_no TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_blocked TEXT;

-- Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). The
-- operator record 049 creates for it stays pending and can't be activated.
UPDATE operators SET activation_blocked = 'Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). This record must stay pending and must not be activated.'
 WHERE legal_name ILIKE 'capital travel%' AND activation_blocked IS NULL;

ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_operator_id BIGINT REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_legal_name TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_licence_no TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_no TEXT UNIQUE;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_issued_at TIMESTAMPTZ;
