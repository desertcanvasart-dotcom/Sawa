-- Rollback of 066, together with the code from before it (the old code's
-- migration list stops at 065, so its 049 puts the version lock trigger back).
-- Puts every archived version and draft back as it was. Departures keep their
-- rate_version_id; their snapshots and the rate cards stay (unused by the old
-- code). A rate card saved after 066 is NOT turned into a version: publish it
-- again in the old editor.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_066_rate_cards.down.sql
BEGIN;
ALTER TABLE catalogue_rate_versions DISABLE TRIGGER trg_catalogue_rate_immutable;
INSERT INTO catalogue_rate_versions
SELECT (jsonb_populate_record(NULL::catalogue_rate_versions, a.row_data)).*
  FROM catalogue_rate_versions_archive a
 WHERE NOT EXISTS (SELECT 1 FROM catalogue_rate_versions v WHERE v.id = a.id);
ALTER TABLE catalogue_rate_versions ENABLE TRIGGER trg_catalogue_rate_immutable;
SELECT setval(pg_get_serial_sequence('catalogue_rate_versions', 'id'), GREATEST((SELECT MAX(id) FROM catalogue_rate_versions), 1));
DELETE FROM schema_migrations WHERE name = '066_rate_cards';
COMMIT;
