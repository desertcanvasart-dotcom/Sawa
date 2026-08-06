// Tests for the SEO/AEO outputs. seo.js imports the pg pool at module load, so
// a dummy DATABASE_URL is set before importing — pg connects lazily, and
// sitemapXml() catches DB failures, which is exactly what exercises the static
// portion of its output here. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
const { robotsTxt, sitemapXml, llmsTxt, inlineScriptJson, sliceBootstrapForRoute, iso } = await import("./seo.js");

// ---- sliceBootstrapForRoute ------------------------------------------------
// The payload is inlined into every rendered page, so it is sliced to what the
// route actually renders. The invariant under test is that slicing never
// removes anything a card, filter or counter reads — only detail-page fields,
// and only for products the visitor is not looking at.

const HEAVY = ["overviewHtml", "itinerary", "included", "notIncluded", "policiesHtml",
               "meetingPoint", "meetingPoints", "whatToBring", "pickupNote", "faq", "highlights"];

const product = (over = {}) => ({
  id: "tour_1", type: "day_tour", title: "Giza Pyramids and Sphinx", city: "Cairo",
  duration: "4 hours", guide: "Licensed Egyptologist", publishedRate: 75, breakPrice: 58,
  minSeats: 4, maxSeats: 12, description: "A short description.",
  images: [{ url: "/a.jpg", alt: "a" }, { url: "/b.jpg", alt: "b" }, { url: "/c.jpg", alt: "c" }],
  overviewHtml: "<p>long</p>", itinerary: [{ title: "Stop" }], included: ["Guide"],
  notIncluded: ["Tips"], policiesHtml: "<p>p</p>", meetingPoint: "Museum",
  meetingPoints: [{ point: "Museum steps" }], pickupNote: "Hotel pickup included",
  highlights: ["Sphinx"], whatToBring: ["Hat"], faq: [{ q: "?", a: "!" }], ...over,
});

const payloadOf = (...products) => ({ agencies: [], cities: [{ id: 1, name: "Cairo" }], tourProducts: products, departures: [{ id: 1 }] });

test("slice keeps the route's product complete and strips the rest", () => {
  const focus = product();
  const other = product({ id: "tour_2", title: "Luxor East Bank temples", city: "Luxor" });
  const out = sliceBootstrapForRoute(payloadOf(focus, other), "/tour/giza-pyramids-sphinx-from-cairo");

  const kept = out.tourProducts.find((p) => p.id === "tour_1");
  const slim = out.tourProducts.find((p) => p.id === "tour_2");
  for (const f of HEAVY) {
    assert.ok(f in kept, `the route's own product must keep ${f}`);
    assert.ok(!(f in slim), `an unrelated product should not carry ${f}`);
  }
  assert.equal(kept.detailPending, undefined, "the focused product is complete");
  assert.equal(slim.detailPending, true, "a slimmed product must say so");
  assert.equal(out.partial, true);
});

test("slice resolves the focus by raw id as well as slug (old /tour/<id> links)", () => {
  const out = sliceBootstrapForRoute(payloadOf(product()), "/tour/tour_1");
  assert.ok("itinerary" in out.tourProducts[0], "an id-addressed product must still be complete");
});

test("slice matches packages on the /package/ route", () => {
  const pkg = product({ id: "pkg_1", type: "package", title: "Classic Egypt 8-day with Nile cruise" });
  const out = sliceBootstrapForRoute(payloadOf(pkg), "/package/classic-egypt-8-day-with-nile-cruise");
  assert.ok("itinerary" in out.tourProducts[0]);
  assert.equal(out.partial, false, "nothing was slimmed, so the payload is complete");
});

test("slice never removes a field a card, filter or counter reads", () => {
  // These drive the catalogue grid, the city chips and the summary counts. If
  // any of them went missing the visible numbers would change after load —
  // the exact regression the inlined payload exists to prevent.
  const CARD_FIELDS = ["id", "type", "title", "city", "duration", "guide",
                       "publishedRate", "breakPrice", "minSeats", "maxSeats", "description", "images"];
  const out = sliceBootstrapForRoute(payloadOf(product()), "/tours");
  const slim = out.tourProducts[0];
  for (const f of CARD_FIELDS) assert.ok(f in slim, `card field ${f} must survive slicing`);
  assert.ok(slim.images.length >= 1, "coverImage() reads images[0]");
  assert.deepEqual(out.cities, [{ id: 1, name: "Cairo" }], "cities drive the filters and must be untouched");
  assert.deepEqual(out.departures, [{ id: 1 }], "departures carry the seat counts and must be untouched");
});

test("slice does not mutate the shared cached payload", () => {
  // publicBootstrapPayload() memoises one object and every request slices it.
  // Mutating in place would progressively strip the cache for everyone.
  const original = payloadOf(product());
  const before = JSON.stringify(original);
  sliceBootstrapForRoute(original, "/tours");
  assert.equal(JSON.stringify(original), before, "the cached payload must be untouched");
});

test("slice on a non-detail route slims every product", () => {
  const out = sliceBootstrapForRoute(payloadOf(product(), product({ id: "tour_2" })), "/blog");
  assert.ok(out.tourProducts.every((p) => p.detailPending === true));
  assert.equal(out.partial, true);
});

test("slice tolerates a payload with no products", () => {
  assert.deepEqual(sliceBootstrapForRoute({ tourProducts: [] }, "/tours"), { tourProducts: [], partial: false });
  assert.equal(sliceBootstrapForRoute(null, "/tours"), null);
});

// ---- inlineScriptJson ------------------------------------------------------
// The bootstrap payload is written straight into a <script> in the server-
// rendered page, and it carries operator-supplied text (tour titles, blog
// excerpts). Everything here is about that block being un-escapable.

test("inlineScriptJson escapes < so a payload cannot close the script block", () => {
  const out = inlineScriptJson({ title: "</script><img src=x onerror=alert(1)>" });
  assert.ok(!out.includes("</script>"), "payload must not contain a literal </script>");
  assert.ok(!out.includes("<"), "no raw < should survive");
  assert.ok(out.includes("\\u003c"));
});

test("inlineScriptJson escapes U+2028/U+2029, which are line breaks in JS source", () => {
  const LS = "\u2028", PS = "\u2029";
  const out = inlineScriptJson({ a: `one${LS}two`, b: `three${PS}four` });
  assert.ok(!out.includes(LS), "raw U+2028 would be a syntax error in the script");
  assert.ok(!out.includes(PS), "raw U+2029 would be a syntax error in the script");
  assert.ok(out.includes("\\u2028") && out.includes("\\u2029"));
});

test("inlineScriptJson output still parses back to the original value", () => {
  const value = {
    tourProducts: [{ id: "t1", title: "Giza </script> & <b>Sphinx</b>", price: 75 }],
    departures: [{ id: 1, date: "2026-10-01", note: "line\u2028break" }],
    nested: { nul: null, yes: true, list: [1, 2, 3] },
  };
  // The escapes are JS string escapes inside a JSON string, so JSON.parse
  // resolves them back — the round trip must be lossless or the SPA boots with
  // corrupted data.
  assert.deepEqual(JSON.parse(inlineScriptJson(value)), value);
});

test("inlineScriptJson round-trips through an actual script-tag extraction", () => {
  const payload = { title: "Nasty </script><script>alert(1)</script>" };
  const html = `<script>window.__SAWA_BOOTSTRAP__=${inlineScriptJson(payload)}</script>`;
  // Mimic the parser: the block ends at the FIRST </script>. If escaping is
  // right, that is the closing tag we wrote, and the JSON is intact.
  const body = html.slice(html.indexOf(">") + 1, html.indexOf("</script>"));
  const json = body.replace("window.__SAWA_BOOTSTRAP__=", "");
  assert.deepEqual(JSON.parse(json), payload);
});

// ---- robots.txt ------------------------------------------------------------

// Parse into { agent: [directives] } the way a crawler groups them.
function parseRobots(txt) {
  const groups = {};
  let current = null;
  for (const line of txt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const ua = /^User-agent:\s*(.+)$/i.exec(trimmed);
    if (ua) { current = ua[1].trim(); groups[current] = groups[current] || []; continue; }
    if (current) groups[current].push(trimmed);
  }
  return groups;
}

const BLOCKED = ["/api/", "/admin", "/agency", "/portal"];

test("robots.txt: every named crawler group carries the disallow list", () => {
  // Regression: a crawler obeys only its most specific matching group and
  // ignores "*", so named groups holding a bare "Allow: /" meant Googlebot,
  // Bingbot and every AI crawler were invited into /api/ and the dashboards.
  const groups = parseRobots(robotsTxt());
  const named = Object.keys(groups).filter((a) => a !== "*");
  assert.ok(named.length >= 10, `expected the named crawler groups, got ${named.length}`);
  for (const agent of [...named, "*"]) {
    for (const path of BLOCKED) {
      assert.ok(
        groups[agent].includes(`Disallow: ${path}`),
        `${agent} is missing "Disallow: ${path}" — rules in "*" will not reach it`
      );
    }
    assert.ok(groups[agent].includes("Allow: /"), `${agent} should still allow the public site`);
  }
});

test("robots.txt: declares the sitemap", () => {
  assert.match(robotsTxt(), /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
});

// ---- sitemap.xml -----------------------------------------------------------

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
  // /tours is the catalogue and was absent entirely; /how-it-works and /booking
  // have real meta and are advertised in llms.txt as core pages.
  const xml = await sitemapXml();
  for (const path of ["/tours", "/how-it-works", "/booking", "/faq", "/blog", "/contact"]) {
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

// ---- llms.txt --------------------------------------------------------------

test("llms.txt: leads with the brand and lists the core pages", () => {
  const txt = llmsTxt();
  assert.match(txt, /^# Sawa Tours/);
  for (const path of ["/tours", "/how-it-works", "/blog", "/contact", "/faq"]) {
    assert.ok(txt.includes(`(${path})`), `llms.txt missing a link to ${path}`);
  }
});

// ---- sitemap <lastmod> -----------------------------------------------------
// Google ignores <changefreq> and reads <lastmod> — but only while it trusts
// it. A malformed value invalidates the document; a fabricated one teaches the
// crawler to disregard the field site-wide. iso() is the seam where both go
// wrong, so it drops anything it cannot parse rather than emitting it.

test("iso normalises a Date to W3C datetime", () => {
  assert.equal(iso(new Date("2026-08-06T09:31:37.793Z")), "2026-08-06T09:31:37.793Z");
});
test("iso normalises a timestamp string", () => {
  // pg returns a string rather than a Date depending on column type and parser.
  assert.equal(iso("2026-08-06T09:31:37.793Z"), "2026-08-06T09:31:37.793Z");
  assert.equal(iso("2026-08-06"), "2026-08-06T00:00:00.000Z");
});
test("iso drops absent values instead of guessing at 'now'", () => {
  // A missing timestamp must produce NO <lastmod>. Substituting the current
  // time would claim every page changed on every sitemap fetch.
  for (const v of [null, undefined, ""]) assert.equal(iso(v), null);
});
test("iso drops unparseable values rather than emitting invalid XML content", () => {
  for (const v of ["not-a-date", "0000-00-00", {}, NaN]) assert.equal(iso(v), null);
});

test("the static portion of the sitemap carries no lastmod", async () => {
  // Nothing on disk gives an honest per-page modified date — a deploy rewrites
  // every file mtime — so the marketing pages deliberately have none. Only
  // database-backed URLs (tours, packages, posts) can claim one.
  const xml = await sitemapXml();
  assert.ok(xml.includes("<loc>"), "sitemap should still list the static pages");
  assert.equal(xml.includes("<lastmod>"), false);
});
