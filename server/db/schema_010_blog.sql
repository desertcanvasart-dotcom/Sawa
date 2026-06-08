-- Blog posts with SEO, Generative-Engine-Optimization (GEO) and geographic fields.
CREATE TABLE IF NOT EXISTS blog_posts (
  id            text PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  title         text NOT NULL,
  excerpt       text,
  cover_image   text,
  body_html     text,
  author        text,
  author_credentials text,
  tags          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'draft',     -- draft | published
  published_at  timestamptz,
  -- SEO
  meta_title        text,
  meta_description  text,
  keywords          jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_url     text,
  og_image          text,
  noindex           boolean NOT NULL DEFAULT false,
  -- GEO: Generative Engine Optimization (AI answer engines)
  tldr           text,
  key_takeaways  jsonb NOT NULL DEFAULT '[]'::jsonb,
  faq            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ "q": "...", "a": "..." }]
  -- GEO: geographic / local
  geo_region     text,
  geo_place      text,
  geo_lat        text,
  geo_lng        text,
  local_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON blog_posts (status, published_at DESC);
