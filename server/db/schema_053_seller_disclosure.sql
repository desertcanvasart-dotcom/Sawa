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
--                                    who the current receipt names
--   payment_receipts                 every receipt issued, the original kept
--                                    and marked superseded when reissued
--   seller_change_offers             a paid traveler's right to cancel with a
--                                    full refund, 48 hours, when the seller
--                                    changes after payment
--
-- The seller is named only once the operator has acknowledged the assignment,
-- and payment requests go out only then (decided 27 Sep 2026).

ALTER TABLE operators ADD COLUMN IF NOT EXISTS traveller_licence_no TEXT;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS activation_blocked TEXT;

-- Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). The
-- operator record 049 creates for it stays pending and can't be activated.
-- Superseded by 068 (1 Oct 2026: CTS is a partner agency again). Every
-- migration reruns on db:migrate, so once 068 is applied this no longer re-blocks it.
UPDATE operators SET activation_blocked = 'Capital Travel Service is not involved in Sawa (decided 27 Sep 2026). This record must stay pending and must not be activated.'
 WHERE legal_name ILIKE 'capital travel%' AND activation_blocked IS NULL
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '068_agency_documents');

ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_operator_id BIGINT REFERENCES operators(id) ON DELETE SET NULL;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_legal_name TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS seller_licence_no TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_no TEXT UNIQUE;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS receipt_issued_at TIMESTAMPTZ;

-- Every receipt: the first when the payment is recorded, and a new one when a
-- replacement operator acknowledges after the traveler paid. The original is
-- kept, marked superseded, and points at the receipt that replaced it.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id                  BIGSERIAL PRIMARY KEY,
  request_id          BIGINT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  receipt_no          TEXT NOT NULL UNIQUE,
  seller_operator_id  BIGINT REFERENCES operators(id) ON DELETE SET NULL,
  seller_legal_name   TEXT,
  seller_licence_no   TEXT,
  amount_eur          NUMERIC(10,2) NOT NULL CHECK (amount_eur >= 0),
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at       TIMESTAMPTZ,
  superseded_by       BIGINT REFERENCES payment_receipts(id) ON DELETE SET NULL,
  supersede_reason    TEXT,
  CONSTRAINT payment_receipts_superseded_chk CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipts_current ON payment_receipts (request_id) WHERE superseded_at IS NULL;

-- The seller changed after the traveler paid: they may cancel with a full
-- refund within 48 hours of being told (never past the start).
CREATE TABLE IF NOT EXISTS seller_change_offers (
  id                BIGSERIAL PRIMARY KEY,
  request_id        BIGINT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  pledge_id         TEXT NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  departure_id      BIGINT NOT NULL,
  from_operator_id  BIGINT REFERENCES operators(id) ON DELETE SET NULL,
  to_operator_id    BIGINT NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  receipt_id        BIGINT REFERENCES payment_receipts(id) ON DELETE SET NULL,
  offered_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  state             TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'accepted', 'expired', 'void')),
  accepted_at       TIMESTAMPTZ,
  refund_id         BIGINT REFERENCES payment_refunds(id) ON DELETE SET NULL,
  emailed_to        TEXT,
  CONSTRAINT seller_change_offers_accepted_chk CHECK (state <> 'accepted' OR accepted_at IS NOT NULL),
  UNIQUE (request_id, to_operator_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_change_offers_open ON seller_change_offers (expires_at) WHERE state = 'open';

-- Server-only tables (as 024 set for the Data API): RLS on, no policies.
ALTER TABLE payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE seller_change_offers ENABLE ROW LEVEL SECURITY;
