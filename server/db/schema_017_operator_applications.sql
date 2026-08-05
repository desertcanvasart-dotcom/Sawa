-- 017: Operator verification applications (site/verify.html).
--
-- The apply-to-list form used to hand the completed application to the
-- visitor's own mail client via a mailto: link. An operator whose machine has
-- no mail app configured — common on shared office desktops and on plenty of
-- phones — filled in their company details and licence number, saw a
-- confirmation, and the application went nowhere. There was no record of it on
-- our side either, so nobody could tell it had been lost.
--
-- The form now posts over HTTPS and lands here first; email is sent afterwards
-- and is allowed to fail. The row is the record of record. Idempotent.
CREATE TABLE IF NOT EXISTS operator_applications (
  id            BIGSERIAL PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  company       TEXT NOT NULL,
  contact_name  TEXT NOT NULL,
  city          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  licence       TEXT NOT NULL,
  regions       TEXT,
  about         TEXT,
  -- Where the application is in the review described on /verify.
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','in_review','approved','rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ops works this table newest-first.
CREATE INDEX IF NOT EXISTS idx_operator_applications_created
    ON operator_applications (created_at DESC);
