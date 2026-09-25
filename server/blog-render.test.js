import test from "node:test";
import assert from "node:assert/strict";
import { mapPost } from "./blog-post.js";

process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
const { pool } = await import("./db/index.js");
const { buildHead, buildBody } = await import("./seo.js");
const row = {
  id: "blog_fixture", slug: "fayoum-in-a-day-from-cairo", status: "published",
  title: 'Fayoum </script><script>alert("test")</script>',
  body_html: '<p>A complete Fayoum guide.</p><script>alert("bad")</script>',
  published_at: new Date("2026-08-15T00:00:00Z"),
  internal_note: "must not be sent to a visitor",
};

test("published blog HTML includes safe, route-specific data for React", async (t) => {
  t.mock.method(pool, "query", async (sql, params) => {
    assert.match(sql, /status='published'/);
    assert.deepEqual(params, [row.slug]);
    return { rows: [row] };
  });
  const result = await buildHead(`/blog/${row.slug}`);
  assert.equal(result.notFound, false);
  const match = result.head.match(/<script type="application\/json" id="sawa-blog-post">(.*?)<\/script>/s);
  assert.ok(match, "article data must be in the HTML, not fetched only after mount");
  const post = JSON.parse(match[1]);
  assert.equal(post.slug, row.slug);
  assert.equal(post.title, row.title);
  assert.equal(post.bodyHtml, "<p>A complete Fayoum guide.</p>");
  assert.equal(post.publishedAt, "2026-08-15T00:00:00.000Z");
  assert.equal(post.internal_note, undefined);
  assert.doesNotMatch(match[1], /<|\u2028|\u2029/);
  const body = await buildBody(`/blog/${row.slug}`);
  assert.match(body, /A complete Fayoum guide/);
  assert.doesNotMatch(body, /<script/);
});

test("unknown or unpublished posts remain actual 404s without inline content", async (t) => {
  t.mock.method(pool, "query", async (sql) => {
    assert.match(sql, /status='published'/);
    return { rows: [] };
  });
  const result = await buildHead("/blog/unpublished");
  assert.equal(result.notFound, true);
  assert.match(result.head, /noindex/);
  assert.doesNotMatch(result.head, /sawa-blog-post/);
  assert.equal(await buildBody("/blog/unpublished"), "");
});

test("non-article routes never inherit another page's article data", async () => {
  assert.doesNotMatch((await buildHead("/blog")).head, /sawa-blog-post/);
  assert.doesNotMatch((await buildHead("/admin")).head, /sawa-blog-post/);
});

test("API mapper preserves article fields and omits unlisted database fields", () => {
  const post = mapPost({ ...row, cover_alt: "Meidum pyramid", cover_caption: "The collapsed casing" });
  assert.equal(post.coverAlt, "Meidum pyramid");
  assert.equal(post.coverCaption, "The collapsed casing");
  assert.equal(post.internal_note, undefined);
  assert.equal(post.bodyHtml, row.body_html);
});
