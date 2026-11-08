import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { blogSchedule, isBlogPublished, publicBlogHtml, stripBlogSources, mergedBlogSlugs } from "./blog-publication.js";
import { cleanBlogHtml } from "./sanitize.js";
import { importScheduledBlogs, BLOG_BATCH_MARKER, REVIEWED_DRAFT } from "./db/import-scheduled-blogs.js";

test("67 daily releases use Cairo time and stay hidden until the boundary", () => {
  assert.equal(blogSchedule.length, 67);
  assert.equal(new Set(blogSchedule.map(p => p.slug)).size, 67);
  for (const [i, entry] of blogSchedule.entries()) {
    const at = Date.parse(entry.publishAt);
    const row = { status: "published", published_at: entry.publishAt };
    assert.equal(isBlogPublished(row, at - 1), false);
    assert.equal(isBlogPublished(row, at), true);
    assert.equal(isBlogPublished({ ...row, status: "draft" }, at + 1), false);
    if (i) assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" }).format(at), "09:00");
    if (i > 1) assert.equal(at - Date.parse(blogSchedule[i - 1].publishAt), 86400000);
  }
  for (const target of Object.values(mergedBlogSlugs)) assert.ok(blogSchedule.some(p => p.slug === target));
});

test("source removal preserves adjacent content and future links activate without restart", () => {
  const { slug, publishAt } = blogSchedule[1];
  const html = `<p>Body</p><h2>Sources</h2><ul><li>Reference</li></ul><p>Photo credit</p><a href="/blog/${slug}">Related</a>`;
  assert.equal(stripBlogSources(html), `<p>Body</p><p>Photo credit</p><a href="/blog/${slug}">Related</a>`);
  assert.equal(publicBlogHtml(html, Date.parse(publishAt) - 1), "<p>Body</p><p>Photo credit</p>Related");
  assert.match(publicBlogHtml(html, Date.parse(publishAt)), /href=/);
});

test("prepared articles have complete content, images, metadata, safe tables and no competitor links", () => {
  const allowed = new Set(["visa2egypt.gov.eg", "whc.unesco.org", "egymonuments.com", "egymonuments.gov.eg", "gov.uk", "travel.state.gov", "travel.gc.ca", "insurance.wa.gov", "etaa-egypt.org", "moneyhelper.org.uk", "tickets.gem.eg", "abelatrains.com", "commons.wikimedia.org", "creativecommons.org"]);
  for (const entry of blogSchedule) {
    const post = JSON.parse(readFileSync(new URL(`../content/blog/${entry.slug}.json`, import.meta.url)));
    assert.equal(post.published_at, entry.publishAt);
    assert.ok(post.title && post.meta_title && post.meta_description && post.cover_alt, entry.slug);
    assert.ok(post.body_html.length > 4500, entry.slug);
    assert.ok(existsSync(new URL(`../public${post.cover_image}`, import.meta.url)), post.cover_image);
    assert.doesNotMatch(post.body_html, /<h\d[^>]*>Sources<\/h\d>|\[(?:VERIFY|TODO|OWNER)|\uFFFD/);
    const clean = cleanBlogHtml(post.body_html);
    assert.equal((clean.match(/<table>/g) || []).length, (post.body_html.match(/<table>/g) || []).length);
    for (const match of post.body_html.matchAll(/href="(https?:[^" ]+)"/g)) {
      assert.ok(allowed.has(new URL(match[1]).hostname.replace(/^www\./, "")), `${entry.slug}: ${match[1]}`);
    }
    assert.ok(post.body_html.includes('href="https://'), entry.slug);
    assert.ok(post.body_html.includes('href="/blog/'), entry.slug);
    for (const faq of post.faq) assert.ok(faq.q && faq.a, entry.slug);
  }
  const dirty = '<table><tr><td onclick="bad()">Value</td></tr></table><script>bad()</script>';
  assert.equal(cleanBlogHtml(dirty), "<table><tr><td>Value</td></tr></table>");
});

test("deployment imports once with explicit publication dates and cleans older source lists", async () => {
  let marked = false;
  const inserted = [], updated = [];
  const client = { async query(sql, values) {
    if (sql.startsWith("SELECT 1 FROM schema_migrations")) return { rows: marked ? [{}] : [] };
    if (sql.startsWith("SELECT id, body_html")) return { rows: [{ id: "old", body_html: "<p>Keep</p><h2>Sources</h2><ul><li>Drop</li></ul>" }] };
    if (sql.startsWith("INSERT INTO blog_posts")) inserted.push(values);
    if (sql.startsWith("UPDATE blog_posts")) updated.push(values);
    if (sql.startsWith("INSERT INTO schema_migrations")) { assert.equal(values[0], BLOG_BATCH_MARKER); marked = true; }
    return { rows: [] };
  } };
  await importScheduledBlogs(client);
  assert.equal(await importScheduledBlogs(client), "already applied");
  assert.equal(inserted.length, 67);
  inserted.forEach((values, i) => { assert.equal(values[9], blogSchedule[i].publishAt); assert.equal(values.length, 23); });
  assert.deepEqual(updated, [["<p>Keep</p>", "old"]]);
});

test("colliding posts and failed inserts abort without recording the batch marker", async () => {
  for (const mode of ["collision", "failure"]) {
    const client = { async query(sql) {
      assert.doesNotMatch(sql, /INSERT INTO schema_migrations/);
      if (sql.startsWith("SELECT id, slug, status") && mode === "collision") return { rows: [{ id: "draft" }] };
      if (sql.startsWith("INSERT INTO blog_posts")) throw new Error("insert failed");
      return { rows: [] };
    } };
    await assert.rejects(importScheduledBlogs(client), mode === "collision" ? /already exists/ : /insert failed/);
  }
});

test("only the backed-up matching draft is replaced, preserving its ID; later edits abort", async () => {
  for (const edited of [false, true]) {
    const updates = [];
    const client = { async query(sql, values) {
      if (sql.startsWith("SELECT id, slug, status") && values[1] === REVIEWED_DRAFT.slug) return { rows: [{
        id: REVIEWED_DRAFT.id, slug: REVIEWED_DRAFT.slug, status: "draft",
        updated_at: edited ? "2026-11-08T00:00:00Z" : REVIEWED_DRAFT.updatedAt,
      }] };
      if (sql.startsWith("UPDATE blog_posts SET slug=")) updates.push(values);
      return { rows: [] };
    } };
    if (edited) await assert.rejects(importScheduledBlogs(client), /already exists/);
    else {
      await importScheduledBlogs(client);
      assert.equal(updates.length, 1);
      assert.equal(updates[0][0], REVIEWED_DRAFT.id);
      assert.equal(updates[0][1], REVIEWED_DRAFT.slug);
      assert.equal(updates[0][9], blogSchedule.find(p => p.slug === REVIEWED_DRAFT.slug).publishAt);
    }
  }
});

test("all public blog SQL reads enforce publication time", () => {
  for (const file of ["app.js", "seo.js"]) {
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    const reads = code.match(/SELECT [^"`\n]*FROM blog_posts[^"`\n]*status='published'[^"`\n]*/g) || [];
    assert.ok(reads.length > 0);
    for (const read of reads) assert.match(read, /published_at <= now\(\)/);
  }
});
