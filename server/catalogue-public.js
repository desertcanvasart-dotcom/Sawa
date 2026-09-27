// What a traveller sees of the catalogue, when the catalogue_v2 flag is on
// (model phase 1). With the flag off none of this runs.
//
// The public site keeps its pages, URLs and booking engine. With the flag on,
// what those pages are fed changes:
//
//   - only ACTIVE catalogue products with a PUBLISHED specification in effect,
//     linked to a listing, are shown; held and retired products are hidden
//   - title from the catalogue; inclusions, exclusions, itinerary, timings and
//     pickup from the active specification (never from the listing)
//   - dates are the catalogue's open departures, labelled "Going ahead" or
//     "X of 4 needed", until their cut-off
//   - no operator names anywhere
//   - a retired product's old URL 301-redirects to the product it was merged
//     into; a hidden product's URL goes to the itineraries page
//
// Price, photos and the overview text still come from the listing: pricing
// belongs to a later phase, and the booking engine prices from the listing.
import { pool } from "./db/index.js";
import { tourPath, tourSlug } from "../shared/slug.js";
import { activeSpec, publicDateLabel, publiclyListed } from "../shared/catalogue.js";
import {
  mapCatalogueProduct, mapSpec, todayIn, departureInstants, isMissingCatalogueTables,
} from "./catalogue.js";

const TTL_MS = 30_000;
let memo = { at: 0, value: undefined, pending: null };

export function clearPublicCatalogue() {
  memo = { at: 0, value: undefined, pending: null };
}

// null when migration 047 is not applied: callers then serve the site as it
// was, rather than an empty catalogue.
export async function publicCatalogue(now = Date.now()) {
  if (memo.value !== undefined && now - memo.at < TTL_MS) return memo.value;
  if (!memo.pending) {
    memo.pending = build(now)
      .then((value) => { memo = { at: Date.now(), value, pending: null }; return value; })
      .catch((e) => {
        memo.pending = null;
        if (isMissingCatalogueTables(e)) return null;
        throw e;
      });
  }
  return memo.pending;
}

async function build(now) {
  const today = todayIn(now);
  const [products, specs, listings, departures] = await Promise.all([
    pool.query("SELECT * FROM catalogue_products ORDER BY catalogue_no"),
    pool.query("SELECT * FROM catalogue_spec_versions WHERE state = 'published'"),
    pool.query(`SELECT id, title, city, type, default_time, nights, status, active FROM tour_products
                 WHERE id IN (SELECT legacy_product_id FROM catalogue_products WHERE legacy_product_id IS NOT NULL)`),
    pool.query(`SELECT cd.*, s.seats_sold FROM catalogue_departures cd
                  JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
                 WHERE cd.status IN ('open', 'go_ahead') AND cd.legacy_departure_id IS NOT NULL AND cd.date >= $1`, [today]),
  ]);
  const listingBy = new Map(listings.rows.map((t) => [t.id, t]));
  const specsBy = new Map();
  for (const s of specs.rows.map(mapSpec)) {
    if (!specsBy.has(s.productId)) specsBy.set(s.productId, []);
    specsBy.get(s.productId).push(s);
  }

  const all = products.rows.map(mapCatalogueProduct).map((product) => {
    const listing = product.legacyProductId ? listingBy.get(product.legacyProductId) : null;
    const spec = activeSpec(specsBy.get(product.id) || [], today);
    const visible = product.status === "active" && !!listing && !!spec
      && listing.status === "approved" && listing.active !== false;
    // The page lives where the listing's type puts it (/tour or /package),
    // under a slug from the catalogue title: the same rule the SPA uses to
    // build links, so both sides agree on every URL.
    const path = listing ? tourPath({ title: product.title, city: listing.city, type: listing.type }) : null;
    const oldPath = listing ? tourPath(listing) : null;
    return { product, listing, spec, visible, path, oldPath };
  });
  const byCatalogueId = new Map(all.map((e) => [e.product.id, e]));

  const byListingId = new Map();
  for (const e of all) if (e.visible) byListingId.set(e.listing.id, e);

  // Old URL → where it goes now. Keyed by the full path, prefix included.
  const redirects = new Map();
  const add = (from, to, status) => { if (from && to && from !== to && !redirects.has(from)) redirects.set(from, { to, status }); };
  for (const e of all) {
    if (e.visible) { add(e.oldPath, e.path, 301); continue; }
    const target = e.product.status === "retired" && e.product.mergedIntoId ? byCatalogueId.get(e.product.mergedIntoId) : null;
    if (target?.visible) {
      add(e.oldPath, target.path, 301);
      add(e.path, target.path, 301);
      const prefix = target.listing.type === "package" ? "package" : "tour";
      add(`/${prefix}/${e.product.slug}`, target.path, 301);
    } else {
      // Held, retired without a live successor, or not published yet: not
      // for sale, and may come back. A temporary redirect, not a 404.
      add(e.oldPath, "/itineraries", 302);
      add(e.path, "/itineraries", 302);
    }
  }

  // Bookable dates by the ordinary departure id each is sold through.
  const dates = new Map();
  const datesByProduct = new Map();
  for (const row of departures.rows) {
    const e = byCatalogueId.get(Number(row.product_id));
    if (!e?.visible) continue;
    const dep = { date: String(row.date instanceof Date ? row.date.toISOString() : row.date).slice(0, 10) };
    const at = departureInstants(dep, e.product, {
      startTime: e.spec?.content?.startTime || e.listing.default_time, nights: e.listing.nights,
    });
    const status = row.status;
    const seatsSold = Number(row.seats_sold) || 0;
    if (!publiclyListed({ status, cutoffAt: at.cutoffAt }, now)) continue;
    const label = publicDateLabel({ status, seatsSold, goaheadMin: e.product.goaheadMin });
    dates.set(Number(row.legacy_departure_id), { catalogueStatus: status, catalogueLabel: label });
    if (!datesByProduct.has(e.product.id)) datesByProduct.set(e.product.id, []);
    datesByProduct.get(e.product.id).push({ date: dep.date, label });
  }

  // Each visible product with its bookable dates, soonest first: for "other
  // dates" and "try instead" suggestions (the below-minimum notice).
  const byProduct = new Map();
  for (const e of all) {
    if (!e.visible) continue;
    byProduct.set(e.product.id, {
      product: e.product, path: e.path,
      dates: (datesByProduct.get(e.product.id) || []).sort((a, b) => (a.date < b.date ? -1 : 1)),
    });
  }

  return { byListingId, redirects, dates, byProduct };
}

// ---------------------------------------------------------------- overlays
const specList = (v) => (Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : []);

function publicSpec(entry) {
  const c = entry.spec?.content || {};
  return {
    code: entry.product.code,
    type: entry.product.type,
    endCity: entry.product.endCity,
    specVersion: entry.spec?.version ?? null,
    guideLanguages: specList(c.guideLanguages),
    meals: c.meals || null,
    pickupArea: c.pickupArea || null,
    pickupWindow: c.pickupWindow || null,
    vehicleByBand: c.vehicleByBand || null,
    addons: Array.isArray(c.addons) ? c.addons.filter((a) => a && a.name) : [],
    roomCategories: Array.isArray(c.roomCategories) ? c.roomCategories.filter((r) => r && r.name) : [],
  };
}

// A mapped (camelCase) product from the bootstrap, as the catalogue shows it.
export function overlayProduct(p, entry) {
  const c = entry.spec?.content || {};
  return {
    ...p,
    title: entry.product.title,
    included: specList(c.inclusions),
    notIncluded: specList(c.exclusions),
    itinerary: Array.isArray(c.itinerary) ? c.itinerary : [],
    duration: c.duration || p.duration,
    defaultTime: c.startTime || p.defaultTime,
    meetingPoint: c.pickupArea || null,
    agencyId: null,
    operatorAgencyId: null,
    catalogue: publicSpec(entry),
  };
}

// A tour_products row (snake_case), for the server-rendered page and sitemap.
export function overlayRow(row, entry) {
  const c = entry.spec?.content || {};
  return {
    ...row,
    title: entry.product.title,
    included: specList(c.inclusions),
    not_included: specList(c.exclusions),
    itinerary: Array.isArray(c.itinerary) ? c.itinerary : [],
    duration: c.duration || row.duration,
    default_time: c.startTime || row.default_time,
    meeting_point: c.pickupArea || null,
    agency_id: null,
  };
}

// The bootstrap payload, as the catalogue shows it. `viewer` is undefined for
// the public payload; an agency keeps the dates holding its own bookings so its
// dashboard history survives, but sees only catalogue dates as new inventory.
export function overlayBootstrap(payload, cat, viewer) {
  const products = (payload.tourProducts || [])
    .filter((p) => cat.byListingId.has(p.id))
    .map((p) => overlayProduct(p, cat.byListingId.get(p.id)));
  const titleBy = new Map(products.map((p) => [p.id, p.title]));
  const ownBooking = (d) => viewer?.agencyId && (d.pledges || []).some((pl) => pl.agencyId === viewer.agencyId);
  const departures = (payload.departures || [])
    .filter((d) => cat.dates.has(Number(d.id)) || ownBooking(d))
    .map((d) => ({
      ...d,
      ...(titleBy.has(d.tourProductId) ? { route: titleBy.get(d.tourProductId) } : {}),
      operatorAgencyId: null,
      ...(cat.dates.get(Number(d.id)) || {}),
    }));
  return { ...payload, tourProducts: products, departures, operatorsByProduct: {}, catalogue: { enabled: true } };
}

// Server-rendered tour pages and the sitemap read tour_products rows directly.
// With the flag on, keep only visible products, as the catalogue shows them.
export async function catalogueRowsFor(rows) {
  const cat = await publicCatalogue();
  if (!cat) return rows;
  return rows.filter((r) => cat.byListingId.has(r.id)).map((r) => overlayRow(r, cat.byListingId.get(r.id)));
}

export { tourSlug };
