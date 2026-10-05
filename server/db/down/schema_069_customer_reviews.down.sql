-- Rollback of 069. Deletes every review collected, with the code from before
-- it. The uploaded photos and videos stay in the `review-media` storage bucket;
-- empty it in Supabase if they should go too.
--
--   psql "$DATABASE_URL" -f server/db/down/schema_069_customer_reviews.down.sql
BEGIN;
DROP TABLE IF EXISTS customer_reviews;
DELETE FROM schema_migrations WHERE name = '069_customer_reviews';
COMMIT;
