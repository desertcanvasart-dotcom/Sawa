-- ============================================================
--  Phase 2 — Authentication & tenancy
--  Supabase Auth owns login/passwords (auth.users). This table
--  links each login to a ROLE and an AGENCY for authorization.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_users (
  id          UUID PRIMARY KEY,              -- matches Supabase auth.users.id
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT,
  role        TEXT NOT NULL
                CHECK (role IN ('super_admin','ops_staff','agency_owner','agency_agent')),
  agency_id   TEXT REFERENCES agencies(id) ON DELETE CASCADE,  -- NULL for platform staff
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Platform staff (super_admin/ops_staff) have no agency; agency users must have one.
  CONSTRAINT agency_required_for_agency_roles CHECK (
    (role IN ('super_admin','ops_staff') AND agency_id IS NULL)
    OR
    (role IN ('agency_owner','agency_agent') AND agency_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_app_users_agency ON app_users(agency_id);
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);

-- Tag pledges with the actual user who made them (for audit + ownership).
-- Nullable so existing/public pledges remain valid.
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;
