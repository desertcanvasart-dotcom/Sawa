-- Phase 1 one-time setup: create the app database + role.
-- Run this ONCE as the postgres superuser. It is safe to re-run (guards included).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sawa_app') THEN
    CREATE ROLE sawa_app WITH LOGIN PASSWORD 'sawa_local_dev';
  END IF;
END
$$;

SELECT 'CREATE DATABASE sawa OWNER sawa_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sawa')\gexec

GRANT ALL PRIVILEGES ON DATABASE sawa TO sawa_app;
