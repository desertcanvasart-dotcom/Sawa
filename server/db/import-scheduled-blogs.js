import { readFile } from "node:fs/promises";
import { blogSchedule, stripBlogSources } from "../blog-publication.js";
import { cleanBlogHtml } from "../sanitize.js";

export const BLOG_BATCH_MARKER = "content_daily_blogs_november_2026_v1";

// Runs in the deploy transaction. Never overwrites a colliding draft or repeats
// an import after staff edit or delete a post in the dashboard.
export async function importScheduledBlogs(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [BLOG_BATCH_MARKER]);
  const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [BLOG_BATCH_MARKER]);
  if (applied.rows.length) return "already applied";
  const columns = ["id", "slug", "title", "excerpt", "body_html", "author", "author_credentials", "tags", "status", "published_at", "meta_title", "meta_description", "keywords", "canonical_url", "tldr", "faq", "geo_region", "geo_place", "local_keywords", "cover_image", "cover_alt", "cover_caption", "og_image"];
  for (const entry of blogSchedule) {
    const post = JSON.parse(await readFile(new URL(`../../content/blog/${entry.slug}.json`, import.meta.url), "utf8"));
    const collision = await client.query("SELECT id FROM blog_posts WHERE id=$1 OR slug=$2", [post.id, post.slug]);
    if (collision.rows.length) throw new Error(`Blog already exists: ${post.slug}`);
    post.body_html = cleanBlogHtml(post.body_html);
    const values = columns.map(k => Array.isArray(post[k]) ? JSON.stringify(post[k]) : post[k]);
    await client.query(`INSERT INTO blog_posts (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`, values);
  }
  // Apply the requested Sources removal to the older published articles too.
  const existing = await client.query("SELECT id, body_html FROM blog_posts WHERE status='published'");
  for (const row of existing.rows) {
    const body = stripBlogSources(row.body_html || "");
    if (body !== row.body_html) await client.query("UPDATE blog_posts SET body_html=$1, updated_at=now() WHERE id=$2", [body, row.id]);
  }
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [BLOG_BATCH_MARKER]);
  return `imported ${blogSchedule.length} scheduled posts`;
}
