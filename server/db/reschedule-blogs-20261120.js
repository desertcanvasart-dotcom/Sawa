import { readFileSync } from "node:fs";

export const RESCHEDULE_MARKER = "content_blog_three_day_schedule_20261120";
export const blogReschedule = JSON.parse(readFileSync(new URL("../../content/blog-reschedule-20261120.json", import.meta.url), "utf8"));

// Called inside the deploy transaction. Only reviewed, still-future posts may
// change; unrelated posts, drafts and already-public dates remain untouched.
export async function rescheduleBlogs(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [RESCHEDULE_MARKER]);
  const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [RESCHEDULE_MARKER]);
  if (applied.rows.length) return "already applied";
  for (const post of blogReschedule) {
    const result = await client.query(
      `UPDATE blog_posts SET published_at=$1
       WHERE id=$2 AND slug=$3 AND status='published' AND published_at > now()
         AND published_at IN ($4::timestamptz, $1::timestamptz)
       RETURNING id`,
      [post.publishAt, post.id, post.slug, post.previousPublishAt]
    );
    if (result.rows.length !== 1) throw new Error(`Scheduled post changed since review: ${post.slug}`);
  }
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [RESCHEDULE_MARKER]);
  return `rescheduled ${blogReschedule.length} future posts`;
}
