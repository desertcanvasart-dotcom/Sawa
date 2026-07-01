// One-off backfill: sanitize rich-HTML columns that were stored BEFORE
// server-side sanitization existed (tour overview/policies/itinerary, blog body).
// Uses the exact same allow-list as the live write path (../sanitize.js), so
// existing content ends up identical to freshly-saved content.
//
// Safe to re-run: each row is only written when sanitizing actually changes it,
// so a second run is a no-op and reports 0 updates.
//
// Run: node server/db/sanitize-existing-html.js
import { pool } from "./index.js";
import { cleanHtml, cleanItinerary } from "../sanitize.js";

async function run() {
  let tourFields = 0, tourRows = 0, blogRows = 0;

  // ---- tour_products: overview_html, policies_html, itinerary[].description ----
  const products = await pool.query(
    `SELECT id, overview_html, policies_html, itinerary
       FROM tour_products
      WHERE overview_html IS NOT NULL
         OR policies_html IS NOT NULL
         OR (itinerary IS NOT NULL AND jsonb_typeof(itinerary) = 'array' AND jsonb_array_length(itinerary) > 0)`
  );

  for (const row of products.rows) {
    const sets = [];
    const vals = [];

    if (row.overview_html != null) {
      const clean = cleanHtml(row.overview_html) || null;
      if (clean !== row.overview_html) { sets.push(`overview_html = $${vals.push(clean)}`); tourFields++; }
    }
    if (row.policies_html != null) {
      const clean = cleanHtml(row.policies_html) || null;
      if (clean !== row.policies_html) { sets.push(`policies_html = $${vals.push(clean)}`); tourFields++; }
    }
    if (Array.isArray(row.itinerary) && row.itinerary.length) {
      const clean = cleanItinerary(row.itinerary);
      if (JSON.stringify(clean) !== JSON.stringify(row.itinerary)) {
        sets.push(`itinerary = $${vals.push(JSON.stringify(clean))}::jsonb`);
        tourFields++;
      }
    }

    if (sets.length) {
      vals.push(row.id);
      await pool.query(`UPDATE tour_products SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      tourRows++;
      console.log(`  tour_products ${row.id}: sanitized ${sets.length} field(s)`);
    }
  }

  // ---- blog_posts: body_html ----
  const posts = await pool.query(`SELECT id, body_html FROM blog_posts WHERE body_html IS NOT NULL`);
  for (const row of posts.rows) {
    const clean = cleanHtml(row.body_html) || null;
    if (clean !== row.body_html) {
      await pool.query(`UPDATE blog_posts SET body_html = $1 WHERE id = $2`, [clean, row.id]);
      blogRows++;
      console.log(`  blog_posts ${row.id}: sanitized body_html`);
    }
  }

  console.log(
    `\nDone. tour_products: ${tourRows} row(s) / ${tourFields} field(s) changed; blog_posts: ${blogRows} row(s) changed.`
  );
}

run()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Sanitize backfill failed:", err);
    pool.end().finally(() => process.exit(1));
  });
