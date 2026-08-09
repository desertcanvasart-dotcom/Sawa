// ============================================================
// Structured data for the hand-written editorial pages in /site.
//
// Those 18 pages are served by express.static, so buildHead() — which builds
// the JSON-LD for every SPA route — never runs for them. The result was that
// 18 of the site's 35 indexed URLs carried no structured data at all,
// including "/" itself. The homepage is precisely where Google reads the
// Organization entity and its logo, so the brand had a logo declared on tour
// detail pages and nowhere that mattered.
//
// The page's OWN <title> and <meta name="description"> are the source for the
// WebPage node. Re-declaring them here would be a second copy to keep in sync,
// and the failure mode is silent: the schema keeps confidently describing a
// page that no longer says that. Reading them back off the markup means the
// two cannot disagree.
//
// No database import on purpose — this keeps the module unit-testable, which
// seo.js is not (it opens a pool at import time).
// ============================================================
import { BRAND, ORG_ID, SITE_ID, travelAgencySchema, websiteSchema } from "./brand.js";
import { ldScript } from "./inline-json.js";

// ---- HTML reading -------------------------------------------------------

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Titles and descriptions in the markup are HTML-escaped ("Cairo &amp; Giza").
// JSON-LD is not HTML, so leaving them encoded would publish the raw entity
// text as the page name.
export function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const hit = NAMED[ent.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

const head = (html) => String(html || "").split(/<\/head>/i)[0];
const collapse = (s) => s.replace(/\s+/g, " ").trim();

export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head(html));
  return m ? collapse(decodeEntities(m[1])) : "";
}

// Attribute order is not guaranteed (`content` may precede `name`), so match
// the whole tag and pull the attributes out of it rather than assuming a
// layout.
//
// The quote character is captured and back-referenced rather than treated as
// "either quote". A class like [^"']* ends the match at the first quote of
// EITHER kind, so `content="Sawa means 'together'. We pool…"` — a literal
// apostrophe inside a double-quoted attribute, which four of these pages have
// — silently yielded the two words "Sawa means" as the page description.
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  return m ? m[2] : null;
};

// Skips over quoted sections so a ">" inside an attribute value does not end
// the tag early.
const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

export function metaContent(html, wanted) {
  const tags = head(html).match(META_TAG) || [];
  for (const tag of tags) {
    const name = attr(tag, "name");
    if (!name || name.toLowerCase() !== wanted) continue;
    const content = attr(tag, "content");
    if (content != null) return collapse(decodeEntities(content));
  }
  return "";
}

// The FAQ page is an accordion:
//   <div class="item">
//     <button class="q">Question<span class="pm">…icon…</span></button>
//     <div class="a"><p>Answer</p></div>
//   </div>
//
// Google requires FAQPage markup to reproduce question and answer text that is
// actually present on the page. seo.js carries a hardcoded FAQ_SCHEMA whose
// five questions do not appear on this page at all — emitting that here would
// be the exact mismatch the guidelines call out. Reading the real accordion is
// both accurate and self-maintaining.
export function faqFromHtml(html) {
  const out = [];
  const re = /<button[^>]*\bclass="[^"]*\bq\b[^"]*"[^>]*>([\s\S]*?)<\/button>\s*<div[^>]*\bclass="[^"]*\ba\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const q = collapse(decodeEntities(m[1].replace(/<[^>]+>/g, " ")));
    const a = collapse(decodeEntities(m[2].replace(/<[^>]+>/g, " ")));
    if (q && a) out.push({ q, a });
  }
  return out;
}

// ---- Page facts ---------------------------------------------------------

// Breadcrumb labels. Deliberately short — a breadcrumb is not the <title>,
// which on these pages carries a marketing clause and the brand suffix.
const CRUMB = {
  "/how-it-works": "How it works",
  "/departures": "Departures",
  "/goahead": "GoAhead departures",
  "/goahead-promise": "The GoAhead Promise",
  "/operators": "For operators",
  "/verify": "List your departures",
  "/widget": "Widget",
  "/about": "About",
  "/contact": "Contact",
  "/faq": "FAQ",
  "/privacy": "Privacy",
  "/cookies": "Cookies",
  "/terms": "Terms",
  "/destinations": "Destinations",
  "/destinations/cairo": "Cairo & Giza",
  "/destinations/luxor": "Luxor",
  "/destinations/aswan": "Aswan",
  "/destinations/siwa": "Siwa Oasis",
  "/destinations/abu-simbel": "Abu Simbel",
};

// WebPage subtypes where a more specific one exists. FAQPage is handled
// separately because it needs mainEntity built from the markup.
const PAGE_TYPE = {
  "/about": "AboutPage",
  "/contact": "ContactPage",
  "/faq": "FAQPage",
  "/destinations": "CollectionPage",
  "/departures": "CollectionPage",
  "/goahead": "CollectionPage",
};

export const cleanPath = (p) => {
  const s = String(p || "/").split(/[?#]/)[0];
  return s.replace(/\/+$/, "") || "/";
};

// ---- Graph --------------------------------------------------------------

export function staticPageGraph(pathname, html) {
  const path = cleanPath(pathname);
  const url = BRAND.url + (path === "/" ? "/" : path);
  const title = pageTitle(html);
  const description = metaContent(html, "description");

  const page = {
    "@type": PAGE_TYPE[path] || "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: title || BRAND.name,
    description: description || undefined,
    isPartOf: { "@id": SITE_ID },
    about: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    inLanguage: "en",
  };

  const graph = [travelAgencySchema(), websiteSchema(), page];

  if (path === "/faq") {
    const faq = faqFromHtml(html);
    // Without questions there is nothing to declare, and an empty mainEntity
    // is an invalid FAQPage — fall back to a plain WebPage rather than
    // publishing a broken node.
    if (faq.length) {
      page.mainEntity = faq.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      }));
    } else {
      page["@type"] = "WebPage";
    }
  }

  // Destination pages describe a place, so say which one. The page is `about`
  // the destination; the brand stays the publisher.
  const dest = /^\/destinations\/([a-z-]+)$/.exec(path);
  if (dest && CRUMB[path]) {
    const id = `${url}#place`;
    graph.push({
      "@type": "TouristDestination",
      "@id": id,
      name: CRUMB[path],
      description: description || undefined,
      url,
      containedInPlace: { "@type": "Country", name: "Egypt" },
      touristType: "Small-group shared tour",
    });
    page.about = [{ "@id": ORG_ID }, { "@id": id }];
  }

  if (path !== "/") {
    const crumbs = [{ name: "Home", url: BRAND.url + "/" }];
    if (dest) crumbs.push({ name: CRUMB["/destinations"], url: `${BRAND.url}/destinations` });
    crumbs.push({ name: CRUMB[path] || title || path, url });
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((c, i) => ({
        "@type": "ListItem", position: i + 1, name: c.name, item: c.url,
      })),
    });
  }

  return graph;
}

// Returns the page with its JSON-LD injected, or the page unchanged when it
// already has some (so a page that grows its own schema later is never given a
// competing second copy) or has no </head> to inject into.
export function injectStaticSchema(html, pathname) {
  const source = String(html);
  if (/<script[^>]+type=["']application\/ld\+json["']/i.test(source)) return source;
  if (!/<\/head>/i.test(source)) return source;
  const tag = ldScript({ "@context": "https://schema.org", "@graph": staticPageGraph(pathname, source) });
  // The replacement MUST be a function. As a string, "$" is special to
  // String.replace: "$$" collapses to a single "$" — which silently turned the
  // brand's priceRange of "$$" into "$" — and "$&", "$`" and "$1" splice parts
  // of the match into the output. The JSON carries operator-supplied text, so
  // this is a correctness bug and a content-injection route at once. (The SPA
  // renderer in app.js already passes functions here for the same reason.)
  return source.replace(/<\/head>/i, () => `${tag}\n</head>`);
}
