-- Rollback of 062. Drops the special-arrangement requests. The maximum group
-- values changed to 8 are NOT restored: they are the decision, and the old
-- values are not recorded. Raise a tour's maximum in the admin editor (up to 8).
DROP TABLE IF EXISTS group_requests;
DELETE FROM schema_migrations WHERE name = '062_groups_of_eight';
