-- ============================================================
--  Phase 5 + 6 — email log + audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS email_log (
  id          BIGSERIAL PRIMARY KEY,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  kind        TEXT,
  status      TEXT NOT NULL,            -- sent | logged | failed
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID,                    -- app_users.id, or NULL for public/system
  actor_email  TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,           -- e.g. 'departure.confirm', 'pledge.create'
  entity       TEXT,                    -- e.g. 'departure', 'pledge', 'agency', 'user'
  entity_id    TEXT,
  detail       JSONB,                   -- small contextual payload
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
