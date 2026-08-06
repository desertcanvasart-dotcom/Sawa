-- 018: track when a tour product last actually changed, for sitemap <lastmod>.
--
-- Google ignores <changefreq> entirely and does read <lastmod> — but only while
-- it trusts it. A lastmod that moves when the page didn't teaches the crawler to
-- disregard the field for the whole site, which is worse than omitting it. So
-- the value has to come from a real per-row timestamp, and tour_products had
-- none: blog_posts was the only table carrying updated_at.
--
-- Idempotent.
ALTER TABLE tour_products
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- A trigger rather than `SET updated_at = now()` on each statement. There are
-- five separate write paths for this table today (listing upsert, approve,
-- reject, rate edit, activate/deactivate) plus the Autoura sync, and a stale
-- lastmod is exactly the failure this column exists to prevent — so correctness
-- can't depend on every future writer remembering. This is the first trigger in
-- the schema; blog_posts maintains its own timestamp inline, which is fine
-- there because it has a single writer.
CREATE OR REPLACE FUNCTION tour_products_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Only when something actually changed. An upsert that rewrites a row with
  -- identical values (a re-run of the Autoura sync, a no-op admin save) must not
  -- announce the page as freshly modified.
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tour_products_updated_at ON tour_products;
CREATE TRIGGER trg_tour_products_updated_at
  BEFORE UPDATE ON tour_products
  FOR EACH ROW
  EXECUTE FUNCTION tour_products_touch_updated_at();
