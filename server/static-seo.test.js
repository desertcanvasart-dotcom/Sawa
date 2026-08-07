// Unit tests for structured data on the hand-written /site pages. Pure — no
// DB, no server. (This is why the module does not import seo.js, which opens a
// pool at import time and cannot be loaded under `node --test`.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEntities, pageTitle, metaContent, faqFromHtml,
  staticPageGraph, injectStaticSchema, cleanPath,
} from "./static-seo.js";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const page = (name) => readFileSync(join(siteDir, name), "utf8");
const nodeOfType = (graph, t) => graph.find((n) => n["@type"] === t);
const pageNode = (graph) => graph.find((n) => String(n["@type"]).endsWith("Page"));

const doc = (head, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("decodes the entities that appear in real page metadata", () => {
  assert.equal(decodeEntities("Cairo &amp; Giza"), "Cairo & Giza");
  assert.equal(decodeEntities("&quot;quoted&quot;"), '"quoted"');
  assert.equal(decodeEntities("it&#39;s"), "it's");
  assert.equal(decodeEntities("&#x2014;"), "—");
  // Anything unrecognised is left exactly as found rather than mangled.
  assert.equal(decodeEntities("100% &notarealentity; ok"), "100% &notarealentity; ok");
});

test("reads a description containing an apostrophe in full", () => {
  // The bug this guards: a character class of [^\"']* ends the match at the
  // first quote of EITHER kind, so a literal apostrophe inside a
  // double-quoted attribute truncated four real pages to their first two or
  // three words.
  const html = doc(`<meta name="description" content="Sawa means 'together'. We pool travelers.">`);
  assert.equal(metaContent(html, "description"), "Sawa means 'together'. We pool travelers.");
});

test("reads attributes regardless of order or quote style", () => {
  assert.equal(metaContent(doc(`<meta content="Backwards" name="description">`), "description"), "Backwards");
  assert.equal(metaContent(doc(`<meta name='description' content='Single quoted'>`), "description"), "Single quoted");
  assert.equal(metaContent(doc(`<meta name="DESCRIPTION" content="Upper">`), "description"), "Upper");
  // A ">" inside a value must not end the tag early.
  assert.equal(metaContent(doc(`<meta name="description" content="4 > 3 travellers">`), "description"), "4 > 3 travellers");
  assert.equal(metaContent(doc(`<meta name="other" content="x">`), "description"), "");
});

test("ignores metadata that is not in the head", () => {
  const html = doc(`<title>Real</title>`, `<meta name="description" content="In the body">`);
  assert.equal(metaContent(html, "description"), "");
  assert.equal(pageTitle(html), "Real");
});

test("every static page yields a title and a description", () => {
  // A silently empty name or description is the failure mode that matters
  // here: the schema still validates, it just describes nothing.
  for (const [path, file] of Object.entries(PAGES)) {
    const html = page(file);
    assert.ok(pageTitle(html).length > 10, `${path} has no usable <title>`);
    assert.ok(metaContent(html, "description").length > 30, `${path} has no usable description`);
  }
});

const PAGES = {
  "/": "index.html",
  "/about": "about.html",
  "/contact": "contact.html",
  "/faq": "faq.html",
  "/how-it-works": "how-it-works.html",
  "/departures": "departures.html",
  "/goahead": "goahead.html",
  "/goahead-promise": "goahead-promise.html",
  "/operators": "operators.html",
  "/verify": "verify.html",
  "/widget": "widget.html",
  "/privacy": "privacy.html",
  "/cookies": "cookies.html",
  "/terms": "terms.html",
  "/destinations": join("destinations", "index.html"),
  "/destinations/cairo": join("destinations", "cairo.html"),
  "/destinations/luxor": join("destinations", "luxor.html"),
  "/destinations/aswan": join("destinations", "aswan.html"),
  "/destinations/siwa": join("destinations", "siwa.html"),
  "/destinations/abu-simbel": join("destinations", "abu-simbel.html"),
};

test("every static page declares the brand and the site", () => {
  // The reason this module exists: /" carried no Organization entity at all,
  // which is where the logo is read from.
  for (const [path, file] of Object.entries(PAGES)) {
    const graph = staticPageGraph(path, page(file));
    const org = nodeOfType(graph, "TravelAgency");
    assert.ok(org, `${path} declares no organisation`);
    assert.equal(org.logo, "https://sawa.tours/images/logo-sawa.png", `${path} logo`);
    assert.ok(nodeOfType(graph, "WebSite"), `${path} declares no website`);
    assert.ok(pageNode(graph), `${path} declares no page node`);
  }
});

test("the page node points at the page it is on", () => {
  const graph = staticPageGraph("/about", page("about.html"));
  const node = pageNode(graph);
  assert.equal(node["@type"], "AboutPage");
  assert.equal(node.url, "https://sawa.tours/about");
  assert.equal(node["@id"], "https://sawa.tours/about#webpage");
  assert.match(node.name, /^About Sawa/);
  assert.match(node.description, /^Sawa means 'together'\./);
});

test("the homepage resolves to the bare domain and has no breadcrumb", () => {
  const graph = staticPageGraph("/", page("index.html"));
  assert.equal(pageNode(graph).url, "https://sawa.tours/");
  // A single-item trail from Home to Home is noise.
  assert.equal(nodeOfType(graph, "BreadcrumbList"), undefined);
});

test("breadcrumbs are positioned and nested correctly", () => {
  const flat = nodeOfType(staticPageGraph("/contact", page("contact.html")), "BreadcrumbList");
  assert.deepEqual(flat.itemListElement.map((i) => [i.position, i.name]), [[1, "Home"], [2, "Contact"]]);

  const nested = nodeOfType(staticPageGraph("/destinations/cairo", page(PAGES["/destinations/cairo"])), "BreadcrumbList");
  assert.deepEqual(
    nested.itemListElement.map((i) => [i.position, i.name, i.item]),
    [
      [1, "Home", "https://sawa.tours/"],
      [2, "Destinations", "https://sawa.tours/destinations"],
      [3, "Cairo & Giza", "https://sawa.tours/destinations/cairo"],
    ]
  );
});

test("destination pages describe the destination", () => {
  const graph = staticPageGraph("/destinations/luxor", page(PAGES["/destinations/luxor"]));
  const place = nodeOfType(graph, "TouristDestination");
  assert.equal(place.name, "Luxor");
  assert.equal(place.containedInPlace.name, "Egypt");
  // The page is about both the brand and the place, and both are referenced
  // by @id rather than being restated inline.
  assert.deepEqual(pageNode(graph).about, [
    { "@id": "https://sawa.tours/#organization" },
    { "@id": "https://sawa.tours/destinations/luxor#place" },
  ]);
});

test("the FAQ schema reproduces the questions actually on the page", () => {
  // Google requires FAQPage markup to match visible content. A hardcoded list
  // is what drifts away from it, so the questions are read from the accordion.
  const html = page("faq.html");
  const faq = faqFromHtml(html);
  assert.ok(faq.length >= 10, `expected the full accordion, got ${faq.length}`);
  for (const { q, a } of faq) {
    assert.ok(html.includes(q), `question not present on the page: ${q}`);
    assert.ok(a.length > 20, `answer too short to be real: ${q}`);
    assert.ok(!/[<>]/.test(q + a), `markup leaked into the schema text: ${q}`);
  }
  const node = pageNode(staticPageGraph("/faq", html));
  assert.equal(node["@type"], "FAQPage");
  assert.equal(node.mainEntity.length, faq.length);
  assert.equal(node.mainEntity[0].acceptedAnswer["@type"], "Answer");
});

test("a page with no questions does not claim to be an FAQ", () => {
  // An FAQPage with an empty mainEntity is invalid; degrade instead.
  const node = pageNode(staticPageGraph("/faq", doc("<title>FAQ</title>")));
  assert.equal(node["@type"], "WebPage");
  assert.equal(node.mainEntity, undefined);
});

test("injection puts exactly one graph in the head", () => {
  const html = injectStaticSchema(page("index.html"), "/");
  const blocks = html.match(/<script type="application\/ld\+json">/g) || [];
  assert.equal(blocks.length, 1);
  assert.ok(html.indexOf("application/ld+json") < html.indexOf("</head>"), "injected outside the head");

  // Re-running must not stack a second copy — a page that grows its own schema
  // later keeps it and is left alone.
  assert.equal(injectStaticSchema(html, "/"), html);
});

test("dollar sequences survive injection intact", () => {
  // String.replace gives "$" special meaning in a STRING replacement: "$$"
  // becomes "$", and "$&" / "$`" / "$1" splice pieces of the match in. This
  // shipped: the brand's priceRange of "$$" was reaching the page as "$".
  // Anything carrying a price or a currency symbol is exposed to it.
  const html = injectStaticSchema(
    doc(`<title>T</title><meta name="description" content="From $$100 — $& $\` $1 per person">`),
    "/about"
  );
  const graph = JSON.parse(/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1])["@graph"];
  assert.equal(pageNode(graph).description, "From $$100 — $& $` $1 per person");
  assert.equal(nodeOfType(graph, "TravelAgency").priceRange, "$$");
});

test("injection is inert when there is nothing to inject into", () => {
  const fragment = "<p>no head here</p>";
  assert.equal(injectStaticSchema(fragment, "/"), fragment);
});

test("the injected block is valid JSON and safe inside a script tag", () => {
  const html = injectStaticSchema(
    doc(`<title>Break &amp; out</title><meta name="description" content="</script><img onerror=alert(1)>">`),
    "/about"
  );
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed["@context"], "https://schema.org");
  assert.ok(Array.isArray(parsed["@graph"]));
  // The closing tag in the description must not have terminated the block.
  assert.ok(!m[1].includes("</script>"));
  assert.equal(pageNode(parsed["@graph"]).name, "Break & out");
});

test("trailing slashes and query strings resolve to the same page", () => {
  assert.equal(cleanPath("/about/"), "/about");
  assert.equal(cleanPath("/about?utm_source=x"), "/about");
  assert.equal(cleanPath("/about#top"), "/about");
  assert.equal(cleanPath(""), "/");
  assert.equal(cleanPath("/"), "/");
  assert.equal(
    staticPageGraph("/about/", page("about.html")).find((n) => n["@type"] === "AboutPage").url,
    "https://sawa.tours/about"
  );
});

test("the static page set and the sitemap have not drifted apart", () => {
  // These are the URLs the sitemap advertises; each one needs a file to serve.
  for (const [path, file] of Object.entries(PAGES)) {
    assert.ok(existsSync(join(siteDir, file)), `${path} has no file at site/${file}`);
  }
});
