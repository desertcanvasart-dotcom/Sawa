import { readFile } from "node:fs/promises";
import { cleanHtml } from "../sanitize.js";

export const ARTICLE_MARKER = "content_private_group_diy_egypt_v1";
const HERO_MARKER = "content_private_group_diy_egypt_hero_v1";

// Update only this article's image fields, once. Later admin edits are preserved.
export async function addPrivateTourHero(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [HERO_MARKER]);
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1", [HERO_MARKER]
  );
  if (applied.rows.length) return;
  const post = JSON.parse(await readFile(
    new URL("../../content/blog/private-tour-group-tour-or-diy-egypt.json", import.meta.url), "utf8"
  ));
  await client.query(
    `UPDATE blog_posts SET cover_image=$1, og_image=$1, cover_alt=$2,
       cover_caption=$3, updated_at=now() WHERE id=$4 AND slug=$5`,
    [post.cover_image, post.cover_alt, post.cover_caption, post.id, post.slug]
  );
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [HERO_MARKER]);
}

// Called inside the deploy data-fix transaction. This creates only this post;
// subsequent deploys never overwrite edits or republish a deleted article.
export async function publishPrivateTourArticle(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ARTICLE_MARKER]);
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1", [ARTICLE_MARKER]
  );
  if (applied.rows.length) return "already applied";

  const post = JSON.parse(await readFile(
    new URL("../../content/blog/private-tour-group-tour-or-diy-egypt.json", import.meta.url), "utf8"
  ));
  const existing = await client.query(
    "SELECT id FROM blog_posts WHERE id = $1 OR slug = $2", [post.id, post.slug]
  );
  // Refuse to silently overwrite an article (including an unpublished draft).
  if (existing.rows.length) throw new Error(`Article already exists: ${post.slug}; review before importing`);

  await client.query(
    `INSERT INTO blog_posts
      (id, slug, title, excerpt, body_html, author, author_credentials, tags,
       status, published_at, meta_title, meta_description, keywords,
       canonical_url, tldr, faq, geo_region, geo_place, local_keywords)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'published',now(),$9,$10,
       $11::jsonb,$12,$13,$14::jsonb,$15,$16,$17::jsonb)`,
    [post.id, post.slug, post.title, post.excerpt, cleanHtml(post.body_html),
      post.author, post.author_credentials, JSON.stringify(post.tags),
      post.meta_title, post.meta_description, JSON.stringify(post.keywords),
      post.canonical_url, post.tldr, JSON.stringify(post.faq), post.geo_region,
      post.geo_place, JSON.stringify(post.local_keywords)]
  );
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [ARTICLE_MARKER]);
  return "published";
}
