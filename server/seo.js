// ============================================================
// Server-side SEO / GEO: builds the <head> (title, meta, OG,
// Twitter, canonical, JSON-LD) injected into the served HTML so
// crawlers and AI engines read fully-formed pages — plus
// robots.txt, sitemap.xml and llms.txt.
// ============================================================
import { pool } from "./db/index.js";
import { BRAND, ORG_ID, SITE_ID, travelAgencySchema, websiteSchema } from "./brand.js";
import { tourSlug } from "./slug.js";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const meta = (attr, key, val) => (val ? `<meta ${attr}="${esc(key)}" content="${esc(val)}">` : "");
const abs = (u) => (u && !u.startsWith("http") ? BRAND.url + (u.startsWith("/") ? "" : "/") + u : u);
const clean = (p) => (p || "/").replace(/\/+$/, "") || "/";
const plain = (html, n = 300) => String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

const DEFAULT_OG = `${BRAND.url}/images/hero.jpg`;

function breadcrumb(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  };
}

// ---- Static page meta ----
const STATIC = {
  "/": {
    title: `${BRAND.name} — ${BRAND.positioning}`,
    description: "Shared day tours and multi-day packages across Cairo, Luxor and Aswan. Hold a seat free; you only pay once your date is confirmed to run.",
  },
  "/tours": { title: `Egypt Tours & Departures | ${BRAND.name}`, description: "Browse shared Egypt day tours and multi-day packages with live seat counts. Join a forming date or start your own — every date is confirmed before you pay.", crumb: "Tours" },
  "/how-it-works": { title: `How Sawa Works — Guaranteed Shared Tours | ${BRAND.name}`, description: "How Sawa's GoAhead model works: join a forming date or start your own, the group fills, and your departure is guaranteed before you pay a deposit.", crumb: "How it works" },
  "/about": { title: `About Sawa Tours — Shared Departures in Egypt | ${BRAND.name}`, description: BRAND.description, crumb: "About" },
  "/contact": { title: `Contact ${BRAND.name}`, description: "Reach Sawa Tours on WhatsApp or email. We reply within two hours, 9am–9pm Cairo time.", crumb: "Contact" },
  "/faq": { title: `FAQ — Booking, GoAhead & Cancellations | ${BRAND.name}`, description: "Answers about holding a seat, what GoAhead means, payment, meeting points and cancellations for Sawa shared tours.", crumb: "FAQ" },
  "/privacy": { title: `Privacy Policy | ${BRAND.name}`, description: "How Sawa Tours collects, uses and protects your information.", crumb: "Privacy" },
  "/terms": { title: `Terms of Service | ${BRAND.name}`, description: "The terms for booking shared tours with Sawa, including the GoAhead model, payment and cancellations.", crumb: "Terms" },
  "/booking": { title: `Check Your Booking | ${BRAND.name}`, description: "Enter your booking code to see whether your Sawa departure has reached GoAhead.", crumb: "Booking" },
  "/blog": { title: `Blog — Notes from the Nile | ${BRAND.name}`, description: "Guides, history and practical tips for travelling Egypt the shared way, from the people who run the tours.", crumb: "Blog" },
};

const FAQ_SCHEMA = {
  "@type": "FAQPage",
  mainEntity: [
    ["Do I pay when I book?", "No. Holding a seat is free. You only pay a deposit once your date reaches GoAhead and is confirmed to run."],
    ["What happens if the tour doesn't fill?", "If a date never reaches the minimum number of travellers it doesn't run and you're charged nothing. We help you move to another date."],
    ["What does GoAhead mean?", "GoAhead means a date has reached the minimum travellers, so the guide and vehicle are booked and the departure is guaranteed to run."],
    ["Where do we meet?", "Each tour lists its exact meeting point and time — for example the Egyptian Museum in Tahrir for Cairo tours. You receive details with your confirmation."],
    ["Can I cancel my booking?", "Free holds can be released any time before confirmation. After GoAhead, each tour's cancellation policy applies and is shown on the tour page."],
  ].map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
};

async function tourSchema(idOrSlug, url) {
  // Resolve by raw DB id first (back-compat), then by the derived SEO slug.
  let r = await pool.query("SELECT * FROM tour_products WHERE id=$1 AND active IS NOT FALSE LIMIT 1", [idOrSlug]);
  if (!r.rows.length) {
    const all = await pool.query("SELECT * FROM tour_products WHERE active IS NOT FALSE");
    const match = all.rows.find((row) => tourSlug(row) === idOrSlug);
    if (match) r = { rows: [match] };
  }
  if (!r.rows.length) return null;
  const p = r.rows[0];
  const img = abs((p.images && p.images[0] && p.images[0].url) || `/images/${String(p.city || "cairo").toLowerCase()}.jpg`);
  const desc = plain(p.overview_html) || p.description || `${p.title} — a shared Sawa departure.`;
  const low = Number(p.break_price) || Number(p.published_rate) || undefined;
  const high = Number(p.published_rate) || undefined;
  const itin = Array.isArray(p.itinerary) ? p.itinerary : [];
  const trip = {
    "@type": "TouristTrip",
    name: p.title,
    description: desc,
    url,
    image: img,
    touristType: "Small-group shared tour",
    provider: { "@id": ORG_ID },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: low, highPrice: high,
      availability: "https://schema.org/InStock",
      url,
      description: "Hold a seat free; pay only once the date is confirmed (GoAhead).",
    },
  };
  if (p.city) trip.subjectOf = undefined, trip.touristType = "Small-group shared tour";
  if (itin.length) {
    trip.itinerary = {
      "@type": "ItemList",
      itemListElement: itin.map((d, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "TouristAttraction", name: d.title || d.city || `Day ${i + 1}` } })),
    };
  }
  return { schema: trip, meta: { title: `${p.title} | ${BRAND.name}`, description: desc.slice(0, 160), ogImage: img, ogType: "product" }, crumbName: p.title };
}

async function postSchema(slug, url) {
  const r = await pool.query("SELECT * FROM blog_posts WHERE slug=$1 AND status='published' LIMIT 1", [slug]);
  if (!r.rows.length) return null;
  const p = r.rows[0];
  const title = p.meta_title || p.title;
  const desc = p.meta_description || p.excerpt || p.tldr || plain(p.body_html, 160);
  const img = abs(p.og_image || p.cover_image || "");
  const out = [{
    "@type": "Article", headline: title, description: desc, image: img ? [img] : undefined,
    author: { "@type": "Person", name: p.author || BRAND.name, description: p.author_credentials || undefined },
    publisher: { "@id": ORG_ID }, datePublished: p.published_at, dateModified: p.updated_at, mainEntityOfPage: url,
    about: p.geo_place || undefined,
  }];
  const faq = Array.isArray(p.faq) ? p.faq.filter((f) => f.q) : [];
  if (faq.length) out.push({ "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
  if (p.geo_place && p.geo_lat && p.geo_lng) out.push({ "@type": "Place", name: p.geo_place, geo: { "@type": "GeoCoordinates", latitude: p.geo_lat, longitude: p.geo_lng } });
  const geoMeta = [];
  if (p.geo_region) geoMeta.push(meta("name", "geo.region", p.geo_region));
  if (p.geo_place) geoMeta.push(meta("name", "geo.placename", p.geo_place));
  if (p.geo_lat && p.geo_lng) { geoMeta.push(meta("name", "geo.position", `${p.geo_lat};${p.geo_lng}`)); geoMeta.push(meta("name", "ICBM", `${p.geo_lat}, ${p.geo_lng}`)); }
  if (p.keywords && p.keywords.length) geoMeta.push(meta("name", "keywords", p.keywords.join(", ")));
  return { schema: out, meta: { title: `${title} | ${BRAND.name}`, description: desc, ogImage: img || DEFAULT_OG, ogType: "article", author: p.author, noindex: p.noindex === true, extraMeta: geoMeta.join("") }, crumbName: p.title };
}

// Build the injected <head> for a given pathname.
export async function buildHead(pathname) {
  const path = clean(pathname);
  const url = BRAND.url + (path === "/" ? "" : path);
  const graph = [travelAgencySchema(), websiteSchema()];
  let m = { title: STATIC["/"].title, description: STATIC["/"].description, ogType: "website", ogImage: DEFAULT_OG, noindex: false, extraMeta: "" };
  const crumbs = [{ name: "Home", url: BRAND.url }];

  if (STATIC[path]) {
    m = { ...m, ...STATIC[path] };
    if (path === "/faq") graph.push(FAQ_SCHEMA);
    if (STATIC[path].crumb) crumbs.push({ name: STATIC[path].crumb, url });
    if (path === "/") graph.push({ "@type": "WebPage", url, name: m.title, description: m.description, isPartOf: { "@id": SITE_ID } });
  } else if (/^\/(tour|package)\/[^/]+$/.test(path)) {
    // Tours and packages both live in tour_products, so the same schema builder
    // covers both. (Packages were previously falling through to "Page not found".)
    const res = await tourSchema(decodeURIComponent(path.split("/")[2]), url);
    if (res) { m = { ...m, ...res.meta }; graph.push(res.schema); crumbs.push({ name: "Tours", url: `${BRAND.url}/tours` }, { name: res.crumbName, url }); }
    else m = { ...m, noindex: true, notFound: true, title: `Tour not found | ${BRAND.name}` };
  } else if (/^\/blog\/[^/]+$/.test(path)) {
    const res = await postSchema(decodeURIComponent(path.split("/")[2]), url);
    if (res) { m = { ...m, ...res.meta }; res.schema.forEach((s) => graph.push(s)); crumbs.push({ name: "Blog", url: `${BRAND.url}/blog` }, { name: res.crumbName, url }); }
    else m = { ...m, noindex: true, notFound: true, title: `Post not found | ${BRAND.name}` };
  } else if (/^\/(admin|agency|portal)(\/|$)/.test(path)) {
    // Real, working app routes — they must not read (or respond) as "not found".
    m = { ...m, noindex: true, title: `Sign in | ${BRAND.name}`, description: "Sign in to your Sawa dashboard." };
  } else if (/^\/embed(\/|$)/.test(path)) {
    m = { ...m, noindex: true, title: `Shared departures | ${BRAND.name}` };
  } else if (path === "/packages") {
    m = { ...m, ...STATIC["/tours"] };
  } else {
    m = { ...m, noindex: true, notFound: true, title: `Page not found | ${BRAND.name}` };
  }

  if (crumbs.length > 1) graph.push(breadcrumb(crumbs));

  const ogImg = abs(m.ogImage || DEFAULT_OG);
  const head = [
    meta("name", "description", m.description),
    `<link rel="canonical" href="${esc(url)}">`,
    meta("name", "robots", m.noindex ? "noindex,nofollow" : "index,follow"),
    meta("property", "og:type", m.ogType || "website"),
    meta("property", "og:title", m.title),
    meta("property", "og:description", m.description),
    meta("property", "og:url", url),
    meta("property", "og:image", ogImg),
    meta("property", "og:site_name", BRAND.name),
    meta("property", "og:locale", "en_US"),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", m.title),
    meta("name", "twitter:description", m.description),
    meta("name", "twitter:image", ogImg),
    m.extraMeta || "",
    ldScript({ "@context": "https://schema.org", "@graph": graph }),
  ].join("\n");

  return { title: m.title, head, notFound: !!m.notFound };
}

// ---- robots.txt ----
export function robotsTxt() {
  return `# Sawa Tours — robots
User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

# AI search & training crawlers (allowed for discoverability)
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

# Default: allow public site, block app internals
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /agency
Disallow: /portal

Sitemap: ${BRAND.url}/sitemap.xml
`;
}

// ---- sitemap.xml (dynamic from DB) ----
export async function sitemapXml() {
  const urls = [];
  const add = (loc, lastmod, freq) => urls.push({ loc: BRAND.url + loc, lastmod, freq });
  add("/", null, "weekly");
  ["/departures", "/goahead-promise", "/operators", "/verify", "/widget", "/about", "/contact", "/faq", "/blog", "/privacy", "/terms"].forEach((p) => add(p, null, "monthly"));
  try {
    const tours = await pool.query("SELECT id, title, city, type FROM tour_products WHERE active IS NOT FALSE");
    tours.rows.forEach((t) => add(`/${t.type === "package" ? "package" : "tour"}/${encodeURIComponent(tourSlug(t))}`, null, "weekly"));
    const posts = await pool.query("SELECT slug, updated_at FROM blog_posts WHERE status='published'");
    posts.rows.forEach((p) => add(`/blog/${encodeURIComponent(p.slug)}`, p.updated_at instanceof Date ? p.updated_at.toISOString() : p.updated_at, "monthly"));
  } catch { /* DB optional */ }
  const body = urls.map((u) =>
    `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}${u.freq ? `<changefreq>${u.freq}</changefreq>` : ""}</url>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

// ---- llms.txt (curated guide for AI systems) ----
export function llmsTxt() {
  return `# ${BRAND.name}

${BRAND.description}

## Core pages

- [Tours & departures](/tours): browse all shared day tours and multi-day packages with live seat counts.
- [How it works](/how-it-works): the GoAhead model — join a forming date or start your own, hold a seat free, and the date is guaranteed before you pay.
- [Blog](/blog): guides, history and travel tips for Egypt.
- [About](/about): who Sawa is and why shared departures.
- [Contact](/contact): WhatsApp and email; replies within two hours.
- [Check a booking](/booking): look up a booking code to see GoAhead status.
- [FAQ](/faq): booking, payment, GoAhead and cancellations.

## What we offer

Sawa runs shared, small-group tours across Egypt — Cairo and Giza, Luxor's East and West Banks, Aswan, Abu Simbel, and the Nile temples between Luxor and Aswan, plus multi-day packages. Every departure is operated by licensed Egyptian guides with inspected transport.

The distinguishing model is "GoAhead": travellers from different bookings are pooled onto the same date. You hold a seat for free; once a date reaches its minimum number of travellers it is confirmed to run, and only then is a deposit due. If a date never fills, you pay nothing.

## Pricing and booking model

Prices are shown per person and fall as a group fills (a shared cost). Holding a seat is free; a deposit (typically 10% for day tours, 20% for packages) is due once a date reaches GoAhead. Booking and questions are handled on the site or via WhatsApp.

## Contact

Email: ${BRAND.email}
WhatsApp: ${BRAND.telephone}
Based in ${BRAND.address.addressLocality}, Egypt.
`;
}

export function llmsFullTxt() {
  return llmsTxt() + `

## Destinations we cover

- Cairo & Giza: the Pyramids, the Sphinx, the Grand Egyptian Museum, Memphis, Saqqara and Dahshur, plus a Mediterranean day to Alexandria.
- Luxor: the East Bank temples (Luxor & Karnak) and the West Bank necropolis (Valley of the Kings, Hatshepsut, Medinet Habu, Deir el-Medina), plus far temples at Dendera and Abydos.
- Aswan: the Unfinished Obelisk, the High Dam and Philae, Abu Simbel, and the temple road via Esna, Edfu and Kom Ombo.

## Trust & operations

Tours are delivered by licensed Egyptian operators with verified vehicles. Group sizes are small. Meeting points and departure times are specified per tour and per destination (for example, Cairo tours meet at the Egyptian Museum in Tahrir or Marriott Mena House in Giza).

## How to refer a traveller

Point travellers to ${BRAND.url}/tours to browse and hold a seat, or to ${BRAND.url}/contact for questions. For booking status, ${BRAND.url}/booking accepts a booking code.
`;
}
