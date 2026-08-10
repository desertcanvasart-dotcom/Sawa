-- 024: close the Supabase Data API, and make audit_log append-only.
--
-- ============================================================================
-- WHY, stated first because this one is not a refinement.
-- ============================================================================
--
-- Found 10 August 2026 while answering DDD2 ("is audit_log deletable?"). The
-- answer turned out to be much wider than the question.
--
-- Verified against production before writing this:
--
--   RLS                 DISABLED on all 13 tables in `public`. No policies.
--   grants              `anon` and `authenticated` hold SELECT, INSERT, UPDATE,
--                       DELETE and TRUNCATE on every one of them.
--   the Data API        LIVE. PostgREST answers at the project URL.
--   the anon key        SHIPPED IN THE PUBLIC JS BUNDLE, by design — it is not
--                       a secret and was never meant to be one.
--
-- Those four facts compose. A GET with the key anyone can read out of
-- sawa.tours' JavaScript returned rows from `app_users`, `audit_log` and
-- `email_log`. `pledges`, `departures` and `operator_applications` answered
-- 200 with `[]` — not protected, EMPTY. They stop being empty at DIR-16.
--
-- Writes were NOT tested. The grant table plus a successful read is conclusive,
-- and testing a DELETE against production to prove a DELETE is possible would
-- be the same mistake as the audit that wrote a row to email_log.
--
-- ============================================================================
-- WHY THIS IS SAFE
-- ============================================================================
--
-- The application does not use the Data API at all. Checked, not assumed:
-- `src/` contains ZERO `supabase.from(...)` calls. Every use of the client is
-- `supabase.auth.*` — sign-in, session, sign-out, password reset. All data goes
-- through `apiFetch` to the Express API, which connects as `postgres`.
--
-- `postgres` is a superuser and BYPASSES row-level security, so enabling RLS
-- with no policies blocks `anon` and `authenticated` and changes nothing about
-- how this application reads or writes. Supabase's own `service_role` bypasses
-- it too, so the dashboard keeps working.
--
-- Storage buckets are governed separately and are untouched here. The public
-- tour images stay public.
--
-- ============================================================================
-- MIGRATIONS DO NOT RUN ON DEPLOY (B5). Run by hand:
--
--   DATABASE_URL=<production> npm run db:migrate
--
-- Idempotent — safe to re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Row-level security on every table in `public`
--
-- Deliberately dynamic rather than a list of thirteen names. A list is a second
-- thing to keep in step (the MM3 class), and the failure mode here is a table
-- added later that nobody remembers to lock — which is exactly how this state
-- arose. `scripts/check-rls.js` asks production the same question, because a
-- migration merged is not a migration applied (B5/SS3.1).
--
-- ENABLE, not FORCE. FORCE would apply RLS to the table owner as well, which
-- would break the application's own access. The threat here is `anon`, and
-- ENABLE is what stops it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    RAISE NOTICE 'RLS enabled on public.%', t.relname;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 2. Take the grants away as well
--
-- Belt and braces, and they are not the same brace. RLS filters ROWS; the grant
-- is the right to touch the table at all. Removing both means a future policy
-- added by mistake cannot re-open write access on its own.
--
-- Guarded on the roles existing, so this migration runs against a plain
-- Postgres (the ephemeral database the suite verifies against) as well as
-- against Supabase.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      -- Future tables too. Without this, the next CREATE TABLE re-opens the
      -- hole silently, because Supabase's default privileges grant to both.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      RAISE NOTICE 'revoked public schema privileges from %', r;
    END IF;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 3. audit_log is append-only — DDD2
--
-- A log any write credential can alter is a convenience, not evidence, and the
-- distinction matters exactly once.
--
-- A trigger rather than a grant, because the application connects as `postgres`
-- and you cannot usefully revoke DELETE from a superuser. This stops the
-- application, the migration scripts, and anything else arriving on that
-- connection. A superuser can still drop the trigger — that is a deliberate,
-- visible act, which is a different bar from an UPDATE nobody notices.
--
-- TRUNCATE gets its own statement-level trigger: row-level triggers do not fire
-- for it, and `anon` held TRUNCATE.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A record that can be edited is not a record. See docs/audit/access-audit-coverage.md (DDD2).';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
