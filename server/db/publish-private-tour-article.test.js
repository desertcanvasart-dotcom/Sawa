import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { publishPrivateTourArticle, ARTICLE_MARKER } from "./publish-private-tour-article.js";
import { cleanHtml } from "../sanitize.js";

test("article import inserts one sanitized post and skips subsequent deploys", async () => {
  let marked = false;
  const inserts = [];
  const client = { async query(sql, values) {
    if (sql.startsWith("SELECT 1 FROM schema_migrations")) return { rows: marked ? [{}] : [] };
    if (sql.startsWith("SELECT id FROM blog_posts")) return { rows: [] };
    if (sql.startsWith("INSERT INTO blog_posts")) inserts.push({ sql, values });
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      assert.equal(values[0], ARTICLE_MARKER);
      marked = true;
    }
    return { rows: [] };
  } };
  assert.equal(await publishPrivateTourArticle(client), "published");
  assert.equal(await publishPrivateTourArticle(client), "already applied");
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /'published',now\(\)/);
  assert.equal(inserts[0].values[1], "private-tour-group-tour-or-diy-egypt");
  assert.equal(inserts[0].values[4], cleanHtml(inserts[0].values[4]));
  assert.equal(JSON.parse(inserts[0].values[13]).length, 8);
});

test("an existing post or draft is never overwritten", async () => {
  const client = { async query(sql) {
    assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
    return { rows: sql.startsWith("SELECT id FROM blog_posts") ? [{id:"existing"}] : [] };
  } };
  await assert.rejects(publishPrivateTourArticle(client), /Article already exists/);
});

test("a failed insert is not marked as applied", async () => {
  const client = { async query(sql) {
    assert.doesNotMatch(sql, /INSERT INTO schema_migrations/);
    if (sql.startsWith("INSERT INTO blog_posts")) throw new Error("insert failed");
    return { rows: [] };
  } };
  await assert.rejects(publishPrivateTourArticle(client), /insert failed/);
});

test("article is complete, with readable comparisons and no editorial placeholders", async () => {
  const post = JSON.parse(await readFile(new URL(
    "../../content/blog/private-tour-group-tour-or-diy-egypt.json", import.meta.url
  ), "utf8"));
  assert.doesNotMatch(JSON.stringify(post), /\[(VERIFY|OWNER)|Editor's checklist|private quote\]|\uFFFD/);
  for (const title of ["Shared departure", "Private tour", "Big-bus package", "DIY independent"]) {
    assert.ok(cleanHtml(post.body_html).includes(`<h3>${title}</h3>`));
  }
  assert.match(post.body_html, /href="\/terms"/);
  assert.match(post.body_html, /href="\/itineraries"/);
  assert.equal(post.faq.length, 8);
  assert.ok(post.faq.every(f => f.q.endsWith("?") && f.a.length > 40));
});
