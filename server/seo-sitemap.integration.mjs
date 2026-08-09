// INTEGRATION — these hit the real database. NOT part of `npm test`.
//
// sitemapXml() queries tour_products and blog_posts, so these five assertions
// made five live Supabase round-trips on every unit-test run. That is the most
// likely source of an intermittent failure seen four times: the suite reported
// a decremented count, and the failure was a FILE-level one, which names the
// file rather than a test.
//
// (The reporter was never broken — it does name the file. My method was: I kept
// re-running `npm test` to find the failure instead of reading the output of the
// run that failed. Recorded in the runbook so nobody repeats it.)
//
// A unit suite must not need a network. These moved rather than being mocked,
// because what they actually assert is the shape of a document built from real
// rows — mocking the rows would only test the mock.
//
//   npm run test:integration
//
// Deliberately named so `node --test server/ src/` cannot pick it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sitemapXml } from "./seo.js";

test("sitemap.xml: uses the real sitemaps.org namespace", async () => {
  // Regression: this read "http://www.sitemap.org/..." (no "s"), which is not
  // the sitemap protocol namespace — the document was invalid and could be
  // rejected wholesale.
  const xml = await sitemapXml();
  assert.ok(
    xml.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'),
    "sitemap must declare the sitemaps.org namespace"
  );
  assert.ok(!xml.includes("www.sitemap.org"), "the sitemap.org typo must not come back");
});

test("sitemap.xml: is structurally well formed", async () => {
  const xml = await sitemapXml();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<\/urlset>\s*$/);
  const opens = (xml.match(/<url>/g) || []).length;
  const closes = (xml.match(/<\/url>/g) || []).length;
  const locs = (xml.match(/<loc>/g) || []).length;
  assert.equal(opens, closes);
  assert.equal(opens, locs);
  assert.ok(locs > 0, "sitemap should not be empty");
});

test("sitemap.xml: includes the commercially important routes", async () => {
  // The three catalogue surfaces (/itineraries, /departures, /goahead) plus
  // the pages advertised in llms.txt as core.
  const xml = await sitemapXml();
  for (const path of ["/itineraries", "/departures", "/goahead", "/how-it-works", "/booking", "/faq", "/blog", "/contact"]) {
    assert.ok(xml.includes(`<loc>https://sawa.tours${path}</loc>`), `sitemap missing ${path}`);
  }
});

test("sitemap.xml: every loc is absolute and XML-escaped", async () => {
  const xml = await sitemapXml();
  for (const [, loc] of xml.matchAll(/<loc>([^<]*)<\/loc>/g)) {
    assert.match(loc, /^https?:\/\//, `relative loc: ${loc}`);
    assert.ok(!/[<>"]/.test(loc), `unescaped character in loc: ${loc}`);
    assert.ok(!loc.includes("&") || /&(amp|lt|gt|quot|#\d+);/.test(loc), `raw ampersand in loc: ${loc}`);
  }
});

test("the static portion of the sitemap carries no lastmod", async () => {
  // Nothing on disk gives an honest per-page modified date — a deploy rewrites
  // every file mtime — so the marketing pages deliberately have none. Only
  // database-backed URLs (tours, packages, posts) can claim one.
  //
  // This asserted `xml.includes("<lastmod>") === false` over the WHOLE document,
  // which contradicts the paragraph above it. It passed only because the
  // departures and blog tables were empty when it was written; with 14 products
  // and a published post it fails, and the failure is the test being wrong
  // rather than the sitemap. Splitting the DB tests out of the unit suite is
  // what surfaced it.
  const xml = await sitemapXml();
  assert.ok(xml.includes("<loc>"), "sitemap should still list the static pages");

  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  assert.ok(urls.length > 10, `expected the full URL set, got ${urls.length}`);

  const isDatabaseBacked = (block) => /<loc>[^<]*\/(tour|package|blog)\//.test(block);
  const staticWithLastmod = urls.filter((u) => !isDatabaseBacked(u) && u.includes("<lastmod>"))
    .map((u) => (u.match(/<loc>([^<]*)<\/loc>/) || [])[1]);
  assert.deepEqual(staticWithLastmod, [], "a static page claimed a modified date it cannot know");

  // And the converse, so this cannot pass again by the tables being empty.
  const dbBacked = urls.filter(isDatabaseBacked);
  assert.ok(dbBacked.length > 0, "no database-backed URLs in the sitemap — is the catalogue empty?");
  assert.ok(dbBacked.every((u) => u.includes("<lastmod>")),
    "a database-backed URL is missing the lastmod it can legitimately claim");
});
