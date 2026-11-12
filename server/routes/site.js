// The public site outside the app: robots, llms and sitemap files, the editorial pages, and old tour URLs
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import express from "express";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { mergedBlogSlugs } from "../blog-publication.js";
import { publicCatalogue } from "../catalogue-public.js";
import { pool } from "../db/index.js";
import { mergedTarget } from "../departure-merge.js";
import { catalogueV2Enabled } from "../features.js";
import { canonicalPathRedirect } from "../path-canonical.js";
import { robotsTxt, llmsTxt, llmsFullTxt, sitemapXml, canonicalTourPath } from "../seo.js";
import { tourSlug } from "../slug.js";
import { injectStaticSchema } from "../static-seo.js";
import { routeContext } from "../route-context.js";

const {
  app, h, cacheClearers, queryOf, __dirname,
} = routeContext();

// ============================ AI-readability files ============================
app.get("/blog/:slug", h(async (req, res, next) => {
  const target = mergedBlogSlugs[req.params.slug];
  if (!target) return next();
  const result = await pool.query("SELECT id FROM blog_posts WHERE slug=$1 AND status='published' AND (published_at IS NULL OR published_at <= now())", [target]);
  if (!result.rows.length) return next();
  res.set("Cache-Control", "no-store");
  return res.redirect(301, `/blog/${target}`);
}));

app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt()));
app.get("/llms.txt", (_req, res) => res.type("text/plain").send(llmsTxt()));
// llms-full.txt now embeds a live tours/departures snapshot; cache briefly so
// crawler bursts don't turn into query storms.
let llmsFullCache = { at: 0, body: "" };
cacheClearers.push(() => { llmsFullCache = { at: 0, body: "" }; });
app.get("/llms-full.txt", h(async (_req, res) => {
  if (Date.now() - llmsFullCache.at > 5 * 60 * 1000) {
    llmsFullCache = { at: Date.now(), body: await llmsFullTxt() };
  }
  res.type("text/plain").send(llmsFullCache.body);
}));
app.get("/sitemap.xml", h(async (_req, res) => res.type("application/xml").send(await sitemapXml())));

// ============================ MARKETING SITE (editorial) ============================
// Static editorial pages live in /site (index, departures, trust, operators,
// verify, widget, about, contact, faq). Served at the root so their relative
// links (index.html, departures.html, assets/…) resolve as-authored. Tour CTAs
// point at tour.html / pricing.html which don't exist as static pages — redirect
// those to the live React booking app so real departures keep working.
const siteDir = join(__dirname, "..", "site");
if (existsSync(siteDir)) {
  // One public URL per document. This removes trailing-slash duplicates before
  // static files or the SPA can answer 200, and retires the literal placeholder
  // URL once advertised by the old WebSite/SearchAction schema.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = canonicalPathRedirect(req.originalUrl);
    return target ? res.redirect(301, target) : next();
  });

  // `trust` was renamed to `goahead-promise`; keep the old clean URL working.
  // HTML-file variants (including nested destination pages) are normalized by
  // canonicalPathRedirect above before express.static can serve a duplicate.
  app.get("/trust", (_req, res) => res.redirect(301, "/goahead-promise"));
  // The catalogue moved from /tours to /itineraries (and /packages was only
  // ever an alias of it). 301 so indexed links and old referral URLs
  // (…/tours?ref=CODE) carry over, query string included.
  const toItineraries = (req, res) => {
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(301, `/itineraries${qs}`);
  };
  app.get(["/tours", "/packages"], toItineraries);

  // These pages are hand-written HTML with no JSON-LD of their own, and
  // buildHead() — which builds the graph for every SPA route — only runs for
  // routes that reach the SPA handler. Serving them straight off disk
  // therefore left 18 of the site's 35 indexed URLs carrying no structured
  // data at all, "/" among them. That is the one page Google reads the
  // Organization entity and its logo from, so the brand declared a logo on
  // tour detail pages and nowhere that counted.
  //
  // Injecting on the way out keeps the graph single-sourced from brand.js
  // rather than pasted into eighteen files that would immediately start to
  // drift.
  const siteRoot = resolve(siteDir);
  // Keyed by file AND url path: /destinations and /destinations/index resolve
  // to the same file but describe themselves differently. Validated by mtime,
  // so this is one parse per file per deploy, not per request.
  const schemaCache = new Map();

  // Resolve a URL path to the file express.static would have served for it.
  // The pattern admits no "." at all, so "..", dotfiles and encoded traversal
  // never reach the filesystem; the containment check is the second lock on
  // that door rather than the first.
  const staticHtmlFor = (urlPath) => {
    if (urlPath === "/") return join(siteRoot, "index.html");
    if (!/^\/[a-z0-9][a-z0-9\-/]*$/i.test(urlPath)) return null;
    const rel = urlPath.slice(1);
    for (const candidate of [join(siteRoot, `${rel}.html`), join(siteRoot, rel, "index.html")]) {
      const abs = resolve(candidate);
      if (abs !== siteRoot && !abs.startsWith(siteRoot + sep)) continue;
      if (existsSync(abs)) return abs;
    }
    return null;
  };

  // Copy that goes out with catalogue_v2 (the privacy page's sentence on
  // reservation signals) is marked <!-- catalogue_v2 -->…<!-- /catalogue_v2 -->
  // and left out while the flag is off.
  const flaggedCopy = (html) => (catalogueV2Enabled() ? html : html.replace(/<!-- catalogue_v2 -->[\s\S]*?<!-- \/catalogue_v2 -->\n?/g, ""));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let abs = null;
    try { abs = staticHtmlFor(req.path); } catch { return next(); }
    if (!abs) return next();
    try {
      const { mtimeMs } = statSync(abs);
      const key = `${abs}|${req.path}`;
      let hit = schemaCache.get(key);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        hit = { mtimeMs, html: injectStaticSchema(flaggedCopy(readFileSync(abs, "utf8")), req.path) };
        schemaCache.set(key, hit);
      }
      // Matches what express.static would have sent, so adding schema does not
      // quietly change how these pages cache.
      res.set("Cache-Control", "public, max-age=0");
      res.set("Last-Modified", new Date(mtimeMs).toUTCString());
      return res.type("html").send(hit.html);
    } catch (e) {
      // A page served without its schema beats a page not served at all.
      console.error("[seo] static schema injection failed for", req.path, "-", e.message);
      return next();
    }
  });

  // Still the fallback for assets, images and anything the injector skipped.
  // extensions:["html"] serves /operators from operators.html, etc.
  app.use(express.static(siteDir, { extensions: ["html"] }));
}

// 055: a link to a merged date (/tour/<slug>?date=<id>) goes to the date kept.
app.use(h(async (req, res, next) => {
  if (req.method !== "GET" || !/^\/(tour|package)\/[^/]+\/?$/.test(req.path)) return next();
  const want = Number(req.query?.date);
  if (!Number.isInteger(want) || want <= 0) return next();
  const target = await mergedTarget(pool, want);
  if (!target || target === want) return next();
  const q = new URLSearchParams(req.query);
  q.set("date", String(target));
  return res.redirect(301, `${req.path}?${q.toString()}`);
}));

// catalogue_v2: a retired product's old URL goes to the product it was merged
// into (301); a product whose catalogue title changed its slug moves to the new
// one (301); a hidden product (held, or not yet published) goes to the
// itineraries page (302, as it may come back). The operator directory is not
// shown to travellers at launch. With the flag off this passes straight through.
app.use(h(async (req, res, next) => {
  if (req.method !== "GET" || !catalogueV2Enabled()) return next();
  if (/^\/partners\/?$/.test(req.path)) return res.redirect(302, "/itineraries");
  if (!/^\/(tour|package)\/[^/]+\/?$/.test(req.path)) return next();
  const cat = await publicCatalogue();
  const hit = cat?.redirects.get(decodeURIComponent(req.path.replace(/\/$/, "")));
  if (!hit || hit.to === req.path) return next();
  return res.redirect(hit.status, hit.to + queryOf(req));
}));

// ============================ LEGACY TOUR URL → SEO SLUG (301) ============================
// Old ugly URLs (/tour/<db-id>) permanently redirect to the clean slug URL so any
// existing links / search-engine index entries pass their value to the new URL.
// Clean slug URLs (no tour_/pkg_ prefix) fall through to the SPA untouched.
app.use(h(async (req, res, next) => {
  if (req.method !== "GET") return next();
  const m = req.path.match(/^\/(tour|package)\/([^/]+)\/?$/);
  if (!m) return next();
  const seg = decodeURIComponent(m[2]);
  if (!/^(tour|pkg)_/.test(seg)) {
    // A clean slug, but possibly under the WRONG PREFIX. `type` decides whether
    // a product lives at /tour or /package, so correcting a mistyped product
    // moves its URL — and the old one kept answering 200 with a canonical
    // pointing at itself. Two live URLs for one product, each claiming to be the
    // original, which is the duplicate a search engine has to pick between.
    //
    // Not specific to the one product that caused it: any future retype gets
    // this, which is the difference between a fix and a patch.
    const canonical = await canonicalTourPath(seg);
    if (!canonical || canonical === req.path) return next();
    // Keep the query: ?date= (F06) and ?ref= must survive the move.
    return res.redirect(301, canonical + queryOf(req));
  }
  const r = await pool.query("SELECT id, title, city, type FROM tour_products WHERE id=$1 AND active IS NOT FALSE LIMIT 1", [seg]);
  if (!r.rows.length) return next();
  const kind = r.rows[0].type === "package" ? "package" : "tour";
  const target = `/${kind}/${tourSlug(r.rows[0])}`;
  // Never 301 a URL to itself. tourSlug can no longer return an id-shaped slug,
  // but a 301 loop is cached by the browser and survives the server-side fix —
  // so the cheap guard stays regardless of what the slug logic does later.
  if (target === req.path) return next();
  return res.redirect(301, target + queryOf(req));
}));
