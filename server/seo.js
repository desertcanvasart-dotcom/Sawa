// ============================================================
// Server-side SEO / GEO: builds the <head> (title, meta, OG,
// Twitter, canonical, JSON-LD) injected into the served HTML so
// crawlers and AI engines read fully-formed pages — plus
// robots.txt, sitemap.xml and llms.txt.
// ============================================================
import { pool } from "./db/index.js";
import { BRAND, ORG_ID, SITE_ID, travelAgencySchema, websiteSchema } from "./brand.js";
import { tourSlug } from "./slug.js";
import { cleanHtml } from "./sanitize.js";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

// JSON destined for inside a <script> block, which is NOT the same as JSON in a
// response body. The HTML parser ends the block at the first "</script>"
// anywhere in the text — including inside a JSON string — so a tour titled
// `</script><img onerror=...>` would break out and execute. Escaping "<" shuts
// that off. U+2028/U+2029 are legal in JSON but are line terminators in JS
// source, so leaving them raw is a syntax error that blanks the payload.
// Tour titles, descriptions and blog excerpts are operator-supplied: this is
// untrusted input, not a formality.
export function inlineScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
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

// Resolve by raw DB id first (back-compat), then by the derived SEO slug.
//
// status='approved' is REQUIRED here. An agency's listing is meant to stay
// offline until a platform admin approves it, and /api/bootstrap enforces that
// so the React app hides it — but this lookup didn't, so a pending or rejected
// listing still rendered a fully-formed page (title, description, overview,
// price) to any crawler or anyone with the URL. Users couldn't see it; Google
// could. Same filter as app.js and the /tours listing below.
async function findTourProduct(idOrSlug) {
  const VISIBLE = "active IS NOT FALSE AND status = 'approved'";
  let r = await pool.query(`SELECT * FROM tour_products WHERE id=$1 AND ${VISIBLE} LIMIT 1`, [idOrSlug]);
  if (!r.rows.length) {
    const all = await pool.query(`SELECT * FROM tour_products WHERE ${VISIBLE}`);
    const match = all.rows.find((row) => tourSlug(row) === idOrSlug);
    if (match) r = { rows: [match] };
  }
  return r.rows[0] || null;
}

async function tourSchema(idOrSlug, url) {
  const p = await findTourProduct(idOrSlug);
  if (!p) return null;
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
    // Analytics. The same file the 18 static pages load, so the measurement ID
    // lives in exactly one place (site/assets/analytics.js) rather than being
    // pasted into every head on the site.
    `<script src="/assets/analytics.js"></script>`,
  ].join("\n");

  return { title: m.title, head, notFound: !!m.notFound };
}

// ---- Route-scoped bootstrap slice --------------------------------------
// The inlined payload used to carry every product in full on every page. These
// fields are the bulk of a product record and are read in exactly two places:
// the detail page for the ONE product it is about, and the agency portal —
// which never receives an inlined payload (see needsCatalogue in app.js). Cards,
// filters, city stats and the summary counts read none of them.
//
// So every product except the one the visitor is actually looking at is sent
// without them. Nothing that renders on first paint loses a field, which is the
// constraint that matters: a slice that changed any visible number would just
// reintroduce the flicker this whole change set exists to remove.
const DETAIL_ONLY_PRODUCT_FIELDS = [
  "overviewHtml", "itinerary", "included", "notIncluded", "policiesHtml",
  "meetingPoint", "meetingPoints", "whatToBring", "pickupNote", "faq", "highlights",
];

// Cards use images[0] only (coverImage); the gallery is detail-page furniture.
const CARD_IMAGE_COUNT = 1;

export function sliceBootstrapForRoute(payload, pathname) {
  if (!payload || !Array.isArray(payload.tourProducts)) return payload;
  const path = clean(pathname);
  const m = /^\/(tour|package)\/([^/]+)$/.exec(path);
  // Accept the raw id as well as the slug, mirroring how the client resolves a
  // route product — an old /tour/<id> link must still get its full record.
  const focus = m ? decodeURIComponent(m[2]) : null;

  let slimmed = 0;
  const tourProducts = payload.tourProducts.map((p) => {
    if (focus && (p.id === focus || tourSlug(p) === focus)) return p;
    const slim = { ...p };
    for (const field of DETAIL_ONLY_PRODUCT_FIELDS) delete slim[field];
    if (Array.isArray(slim.images) && slim.images.length > CARD_IMAGE_COUNT) {
      slim.images = slim.images.slice(0, CARD_IMAGE_COUNT);
    }
    // Marks the record as card-complete but detail-incomplete. The client uses
    // this to tell "this tour genuinely lists nothing under Included" apart from
    // "the detail hasn't arrived yet" — the two must not look the same.
    slim.detailPending = true;
    slimmed += 1;
    return slim;
  });

  return { ...payload, tourProducts, partial: slimmed > 0 };
}

// ---- robots.txt ----
// A crawler obeys ONLY the most specific User-agent group that matches it and
// ignores "*" entirely. Every named group here previously held a bare
// "Allow: /" with no Disallow lines, so the app internals were blocked for
// nobody except unnamed crawlers — Googlebot, Bingbot and every AI crawler were
// explicitly invited into /api/ and the dashboards, the exact opposite of the
// intent. The disallow list is therefore repeated into each group.
const CRAWLERS = [
  // Search
  "Googlebot", "Bingbot",
  // AI search & training (allowed for discoverability)
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web",
  "PerplexityBot", "Google-Extended", "CCBot",
];
// App internals: no crawler should spend budget here, and none of it is public.
const DISALLOW = ["/api/", "/admin", "/agency", "/portal", "/embed"];

export function robotsTxt() {
  const group = (agent) =>
    `User-agent: ${agent}\nAllow: /\n${DISALLOW.map((p) => `Disallow: ${p}`).join("\n")}\n`;
  return `# Sawa Tours — robots
# Every group repeats the same Disallow list on purpose: robots.txt gives a
# crawler only its most specific matching group, so rules in "*" would not
# reach any crawler named below.

${CRAWLERS.map(group).join("\n")}
# Default for everyone else
${group("*")}
Sitemap: ${BRAND.url}/sitemap.xml
`;
}

// ---- sitemap.xml (dynamic from DB) ----
// A DATE column comes back from pg as a Date; a text column as a string. The
// sitemap protocol wants W3C datetime, so normalise, and drop anything
// unparseable rather than emitting a malformed <lastmod> that invalidates the
// document.
export function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function sitemapXml() {
  const urls = [];
  const add = (loc, lastmod, freq) => urls.push({ loc: BRAND.url + loc, lastmod, freq });
  add("/", null, "weekly");
  // /tours is the main catalogue and was missing entirely, as were
  // /how-it-works and /booking — all three have real meta in STATIC above and
  // are listed as core pages in llms.txt, so leaving them out of the sitemap
  // was an oversight rather than a choice.
  add("/tours", null, "daily");
  ["/how-it-works", "/departures", "/goahead-promise", "/operators", "/verify", "/widget",
   "/about", "/contact", "/faq", "/blog", "/booking", "/privacy", "/terms",
   // The destination pages are real, linked from the primary nav, and now carry
   // canonicals — but were absent from the sitemap entirely.
   "/destinations", "/destinations/cairo", "/destinations/luxor", "/destinations/aswan",
   "/destinations/siwa", "/destinations/abu-simbel"].forEach((p) => add(p, null, "monthly"));
  try {
    // Only approved listings — a sitemap must never advertise a tour that the
    // site itself refuses to show (see findTourProduct).
    //
    // lastmod is GREATEST(the product's own updated_at, its newest departure).
    // A tour page shows its bookable dates, so publishing a date genuinely
    // changes the page and is worth a recrawl. Seat counts deliberately do NOT
    // move it: a booking changes a number the crawler doesn't care about, and
    // letting every pledge bump lastmod is how the field stops being believed.
    const tours = await pool.query(`
      SELECT p.id, p.title, p.city, p.type,
             GREATEST(p.updated_at, COALESCE(MAX(d.created_at), p.updated_at)) AS lastmod
        FROM tour_products p
        LEFT JOIN departures d
               ON d.tour_product_id = p.id
              AND d.status NOT IN ('cancelled', 'pending_review')
       WHERE p.active IS NOT FALSE AND p.status = 'approved'
       GROUP BY p.id`);
    tours.rows.forEach((t) =>
      add(`/${t.type === "package" ? "package" : "tour"}/${encodeURIComponent(tourSlug(t))}`, iso(t.lastmod), "weekly")
    );
    const posts = await pool.query("SELECT slug, updated_at FROM blog_posts WHERE status='published'");
    posts.rows.forEach((p) => add(`/blog/${encodeURIComponent(p.slug)}`, iso(p.updated_at), "monthly"));
  } catch { /* DB optional */ }
  const body = urls.map((u) =>
    `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}${u.freq ? `<changefreq>${u.freq}</changefreq>` : ""}</url>`
  ).join("\n");
  // NOTE: sitemapS.org — the protocol's namespace has an "s". It read
  // "sitemap.org" here, which is not the sitemap namespace, so the whole
  // document was invalid and search engines could reject it outright.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

// ---- Server-rendered body content (GEO) ----------------------------------
// AI crawlers (GPTBot, ClaudeBot, PerplexityBot) and first-pass search
// crawlers do NOT execute JavaScript, so SPA routes render an empty shell to
// them. buildBody() returns semantic HTML injected inside <div id="root">;
// React's createRoot(...).render() replaces it on mount, so JS users never
// see it while every crawler gets the real content.

const money = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? `$${Math.round(Number(n))}` : null);
const dateLabel = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? `${d}T12:00:00Z` : d);
  return isNaN(dt) ? "" : dt.toLocaleDateString("en", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

// Upcoming public departures (with live seat counts) for one tour or all.
async function upcomingDepartures(tourProductId = null) {
  const r = await pool.query(
    `SELECT d.*, COALESCE(SUM(CASE WHEN p.status <> 'cancelled' THEN p.seats ELSE 0 END), 0) AS seats_taken
       FROM departures d
       LEFT JOIN pledges p ON p.departure_id = d.id
      WHERE d.status IN ('open', 'minimum_reached', 'supplier_confirmed')
        AND COALESCE(d.start_date, d.date) >= CURRENT_DATE
        AND ($1::text IS NULL OR d.tour_product_id = $1)
      GROUP BY d.id
      ORDER BY COALESCE(d.start_date, d.date) ASC
      LIMIT 40`,
    [tourProductId]
  );
  return r.rows.map((d) => {
    const seats = Number(d.seats_taken) || 0;
    const min = Math.max(1, Number(d.min_seats) || 4);
    const confirmed = d.status === "supplier_confirmed" || seats >= min;
    return {
      route: d.route, date: d.start_date || d.date, endDate: d.end_date, time: d.time,
      seats, max: Number(d.max_seats) || 12, min,
      label: confirmed ? "confirmed to run (GoAhead)" : `forming — ${Math.max(0, min - seats)} more traveller${min - seats === 1 ? "" : "s"} to confirm`,
      productId: d.tour_product_id,
    };
  });
}

function departureListHtml(deps) {
  if (!deps.length) {
    return `<p>No public dates are forming right now — you can start your own date on this page: pick the day that suits you, our team reviews it, and nothing is charged unless it reaches GoAhead.</p>`;
  }
  return `<ul>${deps.map((d) => `<li>${esc(dateLabel(d.date))}${d.endDate ? ` – ${esc(dateLabel(d.endDate))}` : ""}${d.time ? ` at ${esc(d.time)}` : ""} — ${d.seats} of ${d.max} seats taken, ${esc(d.label)}</li>`).join("")}</ul>`;
}

const wrapBody = (inner) =>
  `<div data-server-rendered="true" style="max-width:720px;margin:40px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.65;color:#1b1a16">${inner}</div>`;

// Returns the crawler-visible HTML for a pathname, or "" when the route has
// no server-renderable content (portal, booking lookup, unknown routes).
export async function buildBody(pathname) {
  const path = clean(pathname);

  if (/^\/(tour|package)\/[^/]+$/.test(path)) {
    const p = await findTourProduct(decodeURIComponent(path.split("/")[2]));
    if (!p) return "";
    const deps = await upcomingDepartures(p.id);
    const from = money(p.break_price) || money(p.published_rate);
    const itin = Array.isArray(p.itinerary) ? p.itinerary.filter((d) => d && (d.title || d.description)) : [];
    const included = Array.isArray(p.included) ? p.included.filter(Boolean) : [];
    const notIncluded = Array.isArray(p.not_included) ? p.not_included.filter(Boolean) : [];
    return wrapBody(`
<article>
  <h1>${esc(p.title)}</h1>
  <p>${esc(p.city || "Egypt")}${p.duration ? ` · ${esc(p.duration)}` : ""} · shared departure for ${Math.max(1, Number(p.min_seats) || 4)}–${Number(p.max_seats) || 12} travellers${from ? ` · from ${from} per person` : ""}${Array.isArray(p.operating_days) && p.operating_days.length ? ` · departs on ${p.operating_days.map((d) => ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][d]).join(", ")}` : ""}</p>
  ${p.overview_html ? cleanHtml(p.overview_html) : `<p>${esc(p.description || "")}</p>`}
  <h2>Upcoming departures</h2>
  ${departureListHtml(deps)}
  <p>Every date needs ${Math.max(1, Number(p.min_seats) || 4)} travellers to be confirmed (the GoAhead). Hold a seat free — a deposit is only charged once the date confirms. Don't see your day? Start your own date on this page; our team reviews it before it opens.</p>
  ${itin.length ? `<h2>Itinerary</h2><ol>${itin.map((d) => `<li><strong>${esc(d.title || "")}</strong>${d.description ? ` — ${esc(plain(d.description, 400))}` : ""}</li>`).join("")}</ol>` : ""}
  ${included.length ? `<h2>Included</h2><ul>${included.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${notIncluded.length ? `<h2>Not included</h2><ul>${notIncluded.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${p.meeting_point ? `<h2>Meeting point</h2><p>${esc(p.meeting_point)}</p>` : ""}
  <p>Operated by an operator registered with the Egyptian Ministry of Tourism &amp; Antiquities and verified by ${esc(BRAND.name)}.</p>
</article>`);
  }

  if (/^\/blog\/[^/]+$/.test(path)) {
    const r = await pool.query("SELECT * FROM blog_posts WHERE slug=$1 AND status='published' LIMIT 1", [decodeURIComponent(path.split("/")[2])]);
    if (!r.rows.length) return "";
    const p = r.rows[0];
    const faq = Array.isArray(p.faq) ? p.faq.filter((f) => f && f.q) : [];
    return wrapBody(`
<article>
  <h1>${esc(p.title)}</h1>
  <p>${p.author ? `By ${esc(p.author)} · ` : ""}${esc(dateLabel(p.published_at))}</p>
  ${p.tldr ? `<p><strong>In short:</strong> ${esc(p.tldr)}</p>` : ""}
  ${cleanHtml(p.body_html || "")}
  ${faq.length ? `<h2>Questions</h2>${faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a || "")}</p>`).join("")}` : ""}
</article>`);
  }

  if (path === "/blog") {
    const r = await pool.query("SELECT slug, title, excerpt, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 50");
    return wrapBody(`
<h1>Notes from the Nile — the Sawa blog</h1>
<ul>${r.rows.map((p) => `<li><a href="/blog/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>${p.excerpt ? ` — ${esc(p.excerpt)}` : ""} (${esc(dateLabel(p.published_at))})</li>`).join("")}</ul>`);
  }

  if (path === "/tours") {
    const r = await pool.query("SELECT * FROM tour_products WHERE active IS NOT FALSE AND status='approved' ORDER BY id");
    const deps = await upcomingDepartures(null);
    const byProduct = new Map();
    deps.forEach((d) => byProduct.set(d.productId, (byProduct.get(d.productId) || 0) + 1));
    return wrapBody(`
<h1>Egypt tours &amp; shared departures</h1>
<p>Shared day tours and multi-day packages run by Ministry-licensed Egyptian operators. Join a forming date — or start your own on any tour's page. Every date is confirmed (GoAhead) at its minimum travellers; you only pay once it confirms.</p>
<ul>${r.rows.map((p) => {
      const from = money(p.break_price) || money(p.published_rate);
      const n = byProduct.get(p.id) || 0;
      return `<li><a href="/${p.type === "package" ? "package" : "tour"}/${encodeURIComponent(tourSlug(p))}">${esc(p.title)}</a> — ${esc(p.city || "Egypt")}${p.duration ? `, ${esc(p.duration)}` : ""}${from ? `, from ${from}/person` : ""}${n ? `, ${n} date${n === 1 ? "" : "s"} forming` : ""}</li>`;
    }).join("")}</ul>`);
  }

  return "";
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

// llms-full.txt: the curated guide PLUS a live snapshot of tours and
// forming departures, so AI assistants can answer "what runs in October?"
// with real dates instead of guessing. Queries are cheap and cached by the
// route handler.
export async function llmsFullTxt() {
  let live = "";
  try {
    const [products, deps] = await Promise.all([
      pool.query("SELECT * FROM tour_products WHERE active IS NOT FALSE AND status='approved' ORDER BY id"),
      upcomingDepartures(null),
    ]);
    const titleById = new Map(products.rows.map((p) => [p.id, p.title]));
    live = `

## Live tours (current)

${products.rows.map((p) => {
      const from = money(p.break_price) || money(p.published_rate);
      return `- [${p.title}](${BRAND.url}/${p.type === "package" ? "package" : "tour"}/${encodeURIComponent(tourSlug(p))}) — ${p.city || "Egypt"}${p.duration ? `, ${p.duration}` : ""}${from ? `, from ${from}/person` : ""}`;
    }).join("\n")}

## Departures forming now (live)

${deps.length ? deps.map((d) => `- ${dateLabel(d.date)}${d.endDate ? ` – ${dateLabel(d.endDate)}` : ""}: ${titleById.get(d.productId) || d.route} — ${d.seats} of ${d.max} seats taken, ${d.label}`).join("\n") : "- No public departures forming at the moment — travellers can start a date on any tour page."}
`;
  } catch {
    // Live data is a bonus; the curated guide must never fail because of it.
  }
  return llmsTxt() + live + `

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
