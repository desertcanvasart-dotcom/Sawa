-- Rollback for 048. Drops the notices table. The deadline values are left as
-- they are: 30 days is the decided value, and 21 was only a placeholder.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_048_catalogue_notices.down.sql
BEGIN;
DROP TABLE IF EXISTS catalogue_notices;
DELETE FROM schema_migrations WHERE name = '048_catalogue_notices';
COMMIT;
