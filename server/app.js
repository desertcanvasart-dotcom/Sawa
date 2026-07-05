import "dotenv/config";
import express from "express";
import { z } from "zod";
import { pool, withTransaction } from "./db/index.js";
import { mapAgency, mapCity, mapProduct, mapDeparture, mapPledge } from "./db/mappers.js";
import {
  enrichDeparture,
  computePledgePricing,
  seatsTotal,
  goAheadSeatsFor,
  defaultDepositFor,
  bookingClosed,
  DEFAULT_GO_AHEAD,
} from "./domain.js";
import { attachUser, requireAuth, requireRole, isPlatform, isAgency, AuthError } from "./auth.js";
import { supabaseAdmin } from "./supabase.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logAudit } from "./audit.js";
import {
  sendEmail, emailMode,
  inviteEmail, bookingConfirmationEmail, goAheadEmail, cancellationEmail,
  listingApprovedEmail, listingRejectedEmail,
} from "./email.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHead, robotsTxt, sitemapXml, llmsTxt, llmsFullTxt } from "./seo.js";
import { tourSlug } from "./slug.js";
import { cleanHtml, cleanItinerary } from "./sanitize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");

const app = express();
app.disable("x-powered-by");
// In production we serve the SPA from the same origin, so relax CSP/CORP that
// would otherwise block the bundled assets. API security is unaffected.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// The embeddable booking widget (/embed/*) must be frameable on ANY external
// site (WordPress, custom sites, etc.), so drop the same-origin frame guard
// for those routes only. The rest of the app stays SAMEORIGIN-protected.
app.use((req, res, next) => {
  if (req.path.startsWith("/embed")) {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *;");
  }
  next();
});
// 12mb allows base64-encoded image uploads (~9mb raw) through /api/admin/uploads.
// (The route-level json parser ran too late because this global one parses first.)
app.use(express.json({ limit: "12mb" }));

// --- CORS: restrict to known origins (configurable via CORS_ORIGINS) ---
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  } else if (!origin) {
    res.set("Access-Control-Allow-Origin", allowedOrigins[0] || "*");
  }
  res.set({
    "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Rate limiting: general cap + stricter cap on booking/write paths ---
const generalLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
app.use("/api/", generalLimiter);

// Attach req.user from the Supabase JWT (if present) on every request.
app.use(attachUser);

// Any successful API write can change the public catalogue (new booking seats,
// approved listing, published date, price edit…), so drop the cached public
// bootstrap on every non-GET so the next public load rebuilds fresh.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.path.startsWith("/api/")) {
    res.on("finish", () => { if (res.statusCode < 400) invalidatePublicBootstrap(); });
  }
  next();
});

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Tenant-aware pledge visibility ----------------------------------------
// Platform staff see everything. An agency sees full detail only on its own
// pledges; other agencies' customer/financial details are redacted. Anonymous
// visitors see no pledge details (only seat counts, which come from the
// aggregate the frontend computes). This keeps customer data isolated.
function viewPledges(pledges, user) {
  if (isPlatform(user)) return pledges;
  return pledges.map((p) => {
    const owned = user && isAgency(user) && p.agencyId === user.agencyId;
    if (owned) return p;
    return {
      id: p.id,
      agencyId: p.agencyId,
      agency: p.agency,
      seats: p.seats,
      // redact customer + financial detail
      customers: null,
      createdAt: p.createdAt,
    };
  });
}

function presentDeparture(enriched, user) {
  return { ...enriched, pledges: viewPledges(enriched.pledges, user) };
}

// ---- DB helpers ------------------------------------------------------------
async function loadDeparture(client, id, { forUpdate = false } = {}) {
  const dep = await client.query(
    `SELECT * FROM departures WHERE id = $1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [id]
  );
  if (!dep.rows.length) return null;
  const pledges = await client.query(
    `SELECT * FROM pledges WHERE departure_id = $1 ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return enrichDeparture(mapDeparture(dep.rows[0], pledges.rows));
}

async function loadProduct(client, id) {
  const r = await client.query(`SELECT * FROM tour_products WHERE id = $1`, [id]);
  return r.rows.length ? mapProduct(r.rows[0]) : null;
}

function publicBookingCode() {
  return `SAWA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// ---- Validation ------------------------------------------------------------
const pledgeSchema = z.object({
  seats: z.coerce.number().int().min(1),
  customers: z.string().optional(),
  customerEmail: z.string().trim().email("A valid email is required.").optional().or(z.literal("")),
  customerPhone: z.string().trim().optional(),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
});

const publicBookingSchema = z.object({
  customerName: z.string().trim().min(1, "Customer name is required."),
  customerEmail: z.string().trim().email("A valid email is required.").optional().or(z.literal("")),
  customerPhone: z.string().trim().optional(),
  seats: z.coerce.number().int().min(1),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
  refCode: z.string().trim().max(60).optional(),
});

// Agency-created pooling request. Numeric fields are bounded so a malformed or
// hostile body can't create a departure with negative seats or absurd pricing.
const createDepartureSchema = z.object({
  route: z.string().trim().min(1, "Route is required."),
  tourProductId: z.string().trim().optional(),
  date: z.string().trim().optional(),
  time: z.string().trim().optional(),
  city: z.string().trim().optional(),
  customers: z.string().trim().optional(),
  cutoff: z.string().trim().optional(),
  minSeats: z.coerce.number().int().positive().max(200).optional(),
  maxSeats: z.coerce.number().int().positive().max(200).optional(),
  baseCost: z.coerce.number().min(0).max(1_000_000).optional(),
  publishedRate: z.coerce.number().positive().max(1_000_000).optional(),
  breakPrice: z.coerce.number().min(0).max(1_000_000).optional(),
}).refine((v) => !(v.minSeats && v.maxSeats) || v.maxSeats >= v.minSeats, {
  message: "Max seats cannot be less than min seats.",
});

// Referral codes: lowercase, url-safe, capped. Returns "" if nothing usable.
function cleanRefCode(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function parse(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(422, result.error.issues[0]?.message || "Invalid request.");
  }
  return result.data;
}

// ============================ ROUTES ============================

app.get("/api/health", h(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

// Who am I (frontend uses this after login).
app.get("/api/me", requireAuth, h(async (req, res) => {
  let agency = null;
  if (req.user.agencyId) {
    const r = await pool.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId]);
    agency = r.rows[0] ? mapAgency(r.rows[0]) : null;
  }
  res.json({ user: req.user, agency });
}));

// Anonymous visitors all get the identical, fully-redacted public catalogue, but
// building it hits the DB for every product/departure/pledge (2–4s). Cache that
// one payload briefly so tour pages open instantly instead of sitting on the
// loading screen. Authenticated users (agency/admin) always build fresh — their
// view is viewer-specific — and any catalogue write clears the cache immediately.
const PUBLIC_BOOTSTRAP_TTL = 30_000;
let publicBootstrapCache = { at: 0, payload: null };
function invalidatePublicBootstrap() { publicBootstrapCache = { at: 0, payload: null }; }

// Bootstrap — open to all; pledge detail redacted per viewer.
app.get("/api/bootstrap", h(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const anon = !req.user;
  if (anon && publicBootstrapCache.payload && Date.now() - publicBootstrapCache.at < PUBLIC_BOOTSTRAP_TTL) {
    return res.json(publicBootstrapCache.payload);
  }
  // Platform staff see every product (incl. pending/rejected/archived) so they can
  // manage them. Everyone else — the public site and agencies browsing to book —
  // only sees live, approved listings. An agency's own pending/rejected listings
  // are served separately via GET /api/agency/tour-products.
  const canSeeAll = req.user && (req.user.role === "super_admin" || req.user.role === "ops_staff");
  const productsSql = canSeeAll
    ? "SELECT * FROM tour_products ORDER BY id"
    : "SELECT * FROM tour_products WHERE active IS NOT FALSE AND status = 'approved' ORDER BY id";
  const [agencies, cities, products, departures, pledges] = await Promise.all([
    pool.query("SELECT * FROM agencies ORDER BY id"),
    pool.query("SELECT * FROM cities ORDER BY id"),
    pool.query(productsSql),
    pool.query("SELECT * FROM departures ORDER BY id"),
    pool.query("SELECT * FROM pledges ORDER BY created_at ASC, id ASC"),
  ]);

  const byDep = new Map();
  for (const p of pledges.rows) {
    if (!byDep.has(p.departure_id)) byDep.set(p.departure_id, []);
    byDep.get(p.departure_id).push(p);
  }

  const payload = {
    // Only platform staff get the agency directory; agencies/public don't need it.
    agencies: isPlatform(req.user) ? agencies.rows.map(mapAgency) : [],
    cities: cities.rows.map(mapCity),
    tourProducts: products.rows.map(mapProduct),
    departures: departures.rows.map((d) =>
      presentDeparture(enrichDeparture(mapDeparture(d, byDep.get(d.id) || [])), req.user)
    ),
  };
  if (anon) publicBootstrapCache = { at: Date.now(), payload };
  res.json(payload);
}));

// Agency creates a custom day-tour pooling request (agency users only).
app.post("/api/departures", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const body = parse(createDepartureSchema, req.body);
  const route = body.route;

  const departure = await withTransaction(async (c) => {
    const agencyRes = await c.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId]);
    const agency = agencyRes.rows[0];
    const id = (await c.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;
    const publishedRate = Number(body.publishedRate || 80);

    await c.query(
      `INSERT INTO departures
        (id, type, tour_product_id, route, date, time, city, guide, vehicle,
         min_seats, max_seats, base_cost, published_rate, break_price, quality,
         cutoff, status, notes, deposit_percent)
       VALUES ($1,'day_tour',$2,$3,$4,$5,$6,'Verified guide','Shared vehicle',
         $7,$8,$9,$10,$11,4.6,$12,'open',$13,10)`,
      [
        id, body.tourProductId || null, route, body.date || "2026-05-25",
        body.time || "09:00", body.city || "Cairo",
        Number(body.minSeats || 4), Number(body.maxSeats || 12),
        Number(body.baseCost || 280), publishedRate,
        Number(body.breakPrice || Math.round(publishedRate * 0.8)),
        body.cutoff || "Open until 18:00",
        "New pooling request. Agencies can add seats before supplier confirmation.",
      ]
    );
    await c.query(
      `INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, created_by_user_id)
       VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [`pl_new_${Date.now()}`, id, agency.id, agency.name, body.customers || "Lead request", req.user.id]
    );
    return loadDeparture(c, id);
  });

  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));

// Admin publishes a departure from a product (platform staff only).
app.post("/api/admin/departures", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const departure = await withTransaction(async (c) => {
    const product = await loadProduct(c, body.tourProductId);
    if (!product) throw new AppError(404, "Tour product not found.");

    const isPkg = product.type === "package";
    const startDate = body.startDate || body.date || "2026-05-25";
    let endDate = body.endDate || null;
    if (isPkg && !endDate && product.nights) {
      const e = new Date(`${startDate}T12:00:00`);
      e.setDate(e.getDate() + Number(product.nights));
      endDate = e.toISOString().slice(0, 10);
    }
    const id = (await c.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;

    await c.query(
      `INSERT INTO departures
        (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
         city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
         quality, cutoff, status, notes, deposit_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'open',$21,$22)`,
      [
        id, product.type, product.id, product.title, startDate,
        isPkg ? startDate : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, body.time || product.defaultTime,
        product.city, product.guide, product.vehicle,
        Number(body.minSeats || product.minSeats), Number(body.maxSeats || product.maxSeats),
        Number(body.baseCost || product.baseCost || 0), Number(body.publishedRate || product.publishedRate),
        Number(body.breakPrice || product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality, body.cutoff || "Open until 18:00", product.description,
        Number(product.depositPercent || defaultDepositFor(product)),
      ]
    );
    return loadDeparture(c, id);
  });
  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));

// Shared upsert used by both the admin editor and the agency listing editor.
// `review` carries the approval state to write: { status, agencyId, submittedBy, reviewedBy }.
async function upsertTourProduct(c, body, review) {
  const title = String(body.title || "").trim();
  if (!title) throw new AppError(422, "Title is required.");
  const type = body.type === "package" ? "package" : "day_tour";
  const id = body.id ||
    `${type === "package" ? "pkg" : "tour"}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}_${Date.now().toString(36)}`;
  const publishedRate = Number(body.publishedRate || 0);
  const now = new Date().toISOString();
  const reviewedAt = review.status === "approved" ? now : null;
  await c.query(
    `INSERT INTO tour_products
      (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
       min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
       description, included, not_included, itinerary, accommodation_tiers,
       overview_html, policies_html, what_to_bring, meeting_point, pickup_note, booking_cutoff_hours, images,
       meeting_points, status, agency_id, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
     ON CONFLICT (id) DO UPDATE SET
       type=EXCLUDED.type, title=EXCLUDED.title, city=EXCLUDED.city, cities=EXCLUDED.cities,
       nights=EXCLUDED.nights, duration=EXCLUDED.duration,
       guide=EXCLUDED.guide, vehicle=EXCLUDED.vehicle, min_seats=EXCLUDED.min_seats,
       max_seats=EXCLUDED.max_seats, published_rate=EXCLUDED.published_rate,
       break_price=EXCLUDED.break_price, deposit_percent=EXCLUDED.deposit_percent,
       description=EXCLUDED.description, included=EXCLUDED.included, not_included=EXCLUDED.not_included,
       itinerary=EXCLUDED.itinerary, accommodation_tiers=EXCLUDED.accommodation_tiers,
       overview_html=EXCLUDED.overview_html, policies_html=EXCLUDED.policies_html,
       what_to_bring=EXCLUDED.what_to_bring, meeting_point=EXCLUDED.meeting_point,
       pickup_note=EXCLUDED.pickup_note, booking_cutoff_hours=EXCLUDED.booking_cutoff_hours,
       images=EXCLUDED.images, meeting_points=EXCLUDED.meeting_points,
       status=EXCLUDED.status, submitted_at=EXCLUDED.submitted_at,
       submitted_by=EXCLUDED.submitted_by, reviewed_by=EXCLUDED.reviewed_by,
       reviewed_at=EXCLUDED.reviewed_at, rejection_reason=EXCLUDED.rejection_reason,
       agency_id=COALESCE(tour_products.agency_id, EXCLUDED.agency_id)`,
    [
      id, type, title, body.city || "Cairo",
      type === "package" ? JSON.stringify(body.cities || [body.city || "Cairo"]) : null,
      type === "package" ? Number(body.nights || 3) : null,
      body.duration || (type === "package" ? `${Number(body.nights || 3) + 1} days · ${body.nights || 3} nights` : "4 hours"),
      body.defaultTime || "08:00", body.guide || "Licensed Egyptologist",
      body.vehicle || (type === "package" ? "Private van + flights" : "Van, 10 seats"),
      Number(body.minSeats || 4), Number(body.maxSeats || (type === "package" ? 12 : 10)),
      Number(body.baseCost || 0), publishedRate,
      Number(body.breakPrice || Math.round(publishedRate * 0.8)), Number(body.quality || 4.7),
      Number(body.depositPercent || (type === "package" ? 20 : 10)), body.description || "",
      JSON.stringify(body.included || []), JSON.stringify(body.notIncluded || []),
      type === "package" ? JSON.stringify(cleanItinerary(body.itinerary || [])) : null,
      type === "package" ? JSON.stringify(body.accommodationTiers || []) : null,
      cleanHtml(body.overviewHtml) || null, cleanHtml(body.policiesHtml) || null,
      JSON.stringify(body.whatToBring || []), body.meetingPoint || null,
      body.pickupNote || null, Number.isFinite(Number(body.bookingCutoffHours)) ? Number(body.bookingCutoffHours) : 24,
      JSON.stringify(body.images || []),
      JSON.stringify(Array.isArray(body.meetingPoints) ? body.meetingPoints : []),
      review.status, review.agencyId || null, review.submittedBy || null, now,
      review.reviewedBy || null, reviewedAt, null,
    ]
  );
  return loadProduct(c, id);
}

// Admin creates / updates a tour product (platform staff only). Admin edits are
// auto-approved — a platform admin publishing a tour needs no second sign-off.
app.post("/api/admin/tour-products", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const product = await withTransaction((c) =>
    upsertTourProduct(c, body, { status: "approved", submittedBy: req.user.id, reviewedBy: req.user.id }));
  res.status(201).json({ product });
}));

// Agency submits / edits a tour listing. It goes to 'pending' and stays offline
// until a platform admin approves it. Editing an approved listing sends it back
// to pending (re-approval required).
app.post("/api/agency/tour-products", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const body = req.body || {};
  if (!req.user.agencyId) throw new AppError(403, "Your account is not linked to an agency.");
  const product = await withTransaction(async (c) => {
    if (body.id) {
      const owner = await c.query(`SELECT agency_id FROM tour_products WHERE id=$1`, [body.id]);
      if (!owner.rows.length) throw new AppError(404, "Listing not found.");
      if (owner.rows[0].agency_id && owner.rows[0].agency_id !== req.user.agencyId) {
        throw new AppError(403, "You can only edit your own listings.");
      }
    }
    return upsertTourProduct(c, body, { status: "pending", agencyId: req.user.agencyId, submittedBy: req.user.id });
  });
  await logAudit(req, { action: "listing.submit", entity: "tour_product", entityId: product.id, detail: { title: product.title } });
  res.status(201).json({ product });
}));

// Agency lists its own submissions (all statuses).
app.get("/api/agency/tour-products", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM tour_products WHERE agency_id=$1 ORDER BY submitted_at DESC NULLS LAST, id`,
    [req.user.agencyId]
  );
  res.json({ products: r.rows.map(mapProduct) });
}));

// Resolve the best notification address for a listing's owning agency.
async function listingOwnerContact(product) {
  if (product.submittedBy) {
    const u = await pool.query(`SELECT email, full_name FROM app_users WHERE id=$1`, [product.submittedBy]);
    if (u.rows[0]?.email) return u.rows[0];
  }
  if (product.agencyId) {
    const o = await pool.query(
      `SELECT email, full_name FROM app_users WHERE agency_id=$1 AND role='agency_owner' AND status='active' LIMIT 1`,
      [product.agencyId]
    );
    if (o.rows[0]?.email) return o.rows[0];
  }
  return null;
}

// Admin approves a pending listing -> goes live, agency notified by email.
app.post("/api/admin/tour-products/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const product = await withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE tour_products SET status='approved', reviewed_by=$1, reviewed_at=now(), rejection_reason=NULL, active=true WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!r.rows.length) throw new AppError(404, "Listing not found.");
    return mapProduct(r.rows[0]);
  });
  await logAudit(req, { action: "listing.approve", entity: "tour_product", entityId: product.id, detail: { title: product.title } });
  const contact = await listingOwnerContact(product);
  if (contact?.email) {
    sendEmail(listingApprovedEmail({ to: contact.email, fullName: contact.full_name, title: product.title })).catch(() => {});
  }
  res.json({ product, notified: !!contact?.email });
}));

// Admin rejects a pending listing with a reason -> stays offline, agency notified.
app.post("/api/admin/tour-products/:id/reject", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) throw new AppError(422, "A reason for the rejection is required.");
  const product = await withTransaction(async (c) => {
    const r = await c.query(
      `UPDATE tour_products SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    if (!r.rows.length) throw new AppError(404, "Listing not found.");
    return mapProduct(r.rows[0]);
  });
  await logAudit(req, { action: "listing.reject", entity: "tour_product", entityId: product.id, detail: { title: product.title, reason } });
  const contact = await listingOwnerContact(product);
  if (contact?.email) {
    sendEmail(listingRejectedEmail({ to: contact.email, fullName: contact.full_name, title: product.title, reason })).catch(() => {});
  }
  res.json({ product, notified: !!contact?.email });
}));

// Admin updates pricing; cascades to that product's departures (platform staff only).
app.post("/api/admin/tour-products/:id/pricing", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const result = await withTransaction(async (c) => {
    const product = await loadProduct(c, req.params.id);
    if (!product) throw new AppError(404, "Tour product not found.");
    const publishedRate = Number(body.publishedRate || product.publishedRate);
    const breakPrice = Number(body.breakPrice || product.breakPrice);
    if (!(publishedRate > 0) || !(breakPrice > 0)) throw new AppError(422, "Prices must be positive numbers.");
    if (breakPrice > publishedRate) throw new AppError(422, "Break price cannot be higher than the GoAhead price.");

    await c.query(`UPDATE tour_products SET published_rate=$1, break_price=$2 WHERE id=$3`, [publishedRate, breakPrice, product.id]);
    await c.query(`UPDATE departures SET published_rate=$1, break_price=$2 WHERE tour_product_id=$3`, [publishedRate, breakPrice, product.id]);
    const updated = await loadProduct(c, product.id);
    const deps = await c.query(`SELECT id FROM departures WHERE tour_product_id=$1 ORDER BY id`, [product.id]);
    const departures = [];
    for (const row of deps.rows) departures.push(await loadDeparture(c, row.id));
    return { product: updated, departures };
  });
  res.json({ product: result.product, departures: result.departures.map((d) => presentDeparture(d, req.user)) });
}));

// Admin confirms go-ahead (platform staff only).
app.post("/api/admin/departures/:id/confirm", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    const required = goAheadSeatsFor(dep);
    if (seatsTotal(dep.pledges) < required) {
      throw new AppError(409, `${required} booked seats are required for go-ahead.`);
    }
    await c.query(`UPDATE departures SET status='supplier_confirmed' WHERE id=$1`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure.confirm", entity: "departure", entityId: departure.id, detail: { route: departure.route } });
  const dateLabel = departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date;
  const recips = await pool.query(`SELECT DISTINCT customer_email FROM pledges WHERE departure_id=$1 AND customer_email IS NOT NULL`, [departure.id]);
  for (const row of recips.rows) {
    sendEmail(goAheadEmail({ to: row.customer_email, route: departure.route, dateLabel })).catch(() => {});
  }
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Agency pledge — identity (agency) comes from the token, never the body.
app.post("/api/departures/:id/pledges", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const input = parse(pledgeSchema, req.body);
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been cancelled.");
    if (seatsTotal(dep.pledges) + input.seats > dep.maxSeats) {
      throw new AppError(409, "This pledge exceeds capacity.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const agency = (await c.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
    const pricing = computePledgePricing(dep, product, input);

    await insertPledge(c, dep.id, {
      id: `pl_${dep.id}_${Date.now()}`,
      agencyId: agency.id,
      agency: agency.name,
      seats: input.seats,
      customers: (input.customers || "Customer details pending").trim(),
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      createdByUserId: req.user.id,
      ...pricing,
    });
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "pledge.create", entity: "departure", entityId: Number(req.params.id), detail: { seats: input.seats, agencyId: req.user.agencyId } });
  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));

// Public (direct traveller) booking — intentionally open, no auth, but the
// stricter write limiter guards this and the public cancel below from abuse.
app.post("/api/public/departures/:id/bookings", writeLimiter, h(async (req, res) => {
  const input = parse(publicBookingSchema, req.body);
  const result = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been cancelled.");
    if (seatsTotal(dep.pledges) + input.seats > dep.maxSeats) {
      throw new AppError(409, "This booking exceeds the remaining seats.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const pricing = computePledgePricing(dep, product, input);
    const refCode = cleanRefCode(input.refCode);
    if (refCode) {
      // Make sure the partner exists so a booking always shows in the report,
      // even if the click-through visit wasn't tracked.
      await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [refCode]);
    }
    const pledgeId = `pl_${dep.id}_${Date.now()}`;
    const booking = {
      id: pledgeId,
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      source: "public",
      bookingCode: publicBookingCode(),
      refCode: refCode || null,
      ...pricing,
    };
    await insertPledge(c, dep.id, booking);
    const departure = await loadDeparture(c, dep.id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]) };
  });
  await logAudit(req, { action: "booking.create", entity: "pledge", entityId: result.booking.id, detail: { departureId: Number(req.params.id), seats: input.seats, source: "public" } });
  if (input.customerEmail) {
    const d = result.departure;
    sendEmail(bookingConfirmationEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      depositDue: result.booking.depositDue, balanceDue: result.booking.balanceDue,
      balanceDueDate: result.booking.balanceDueDate, bookingCode: result.booking.bookingCode,
    })).catch(() => {});
  }
  // The direct traveller gets their own booking receipt back in full.
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// Agency cancels a pledge — only its own (platform may cancel any).
app.delete("/api/departures/:id/pledges/:pledgeId", requireAuth, requireRole("agency_owner", "agency_agent", "super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "supplier_confirmed" && !isPlatform(req.user)) {
      throw new AppError(409, "Supplier-confirmed departures need admin cancellation.");
    }
    const found = await c.query(`SELECT * FROM pledges WHERE id=$1 AND departure_id=$2`, [req.params.pledgeId, dep.id]);
    if (!found.rows.length) throw new AppError(404, "Pledge not found.");
    // Tenant check: an agency can only cancel its own pledges.
    if (!isPlatform(req.user) && found.rows[0].agency_id !== req.user.agencyId) {
      throw new AppError(403, "You can only cancel your own agency's bookings.");
    }
    await c.query(`DELETE FROM pledges WHERE id=$1 AND departure_id=$2`, [req.params.pledgeId, dep.id]);
    await refreshStatus(c, dep.id);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "pledge.cancel", entity: "departure", entityId: Number(req.params.id), detail: { pledgeId: req.params.pledgeId } });
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Public cancels a booking — open, but only public-sourced pledges.
app.delete("/api/public/departures/:id/bookings/:pledgeId", writeLimiter, h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "supplier_confirmed") throw new AppError(409, "Supplier-confirmed departures need support cancellation.");
    const del = await c.query(
      `DELETE FROM pledges WHERE id=$1 AND departure_id=$2 AND source='public'`,
      [req.params.pledgeId, dep.id]
    );
    if (del.rowCount === 0) throw new AppError(404, "Public booking not found.");
    await refreshStatus(c, dep.id);
    return loadDeparture(c, dep.id);
  });
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Public: look up a booking by its code to see GoAhead status. No auth, no PII.
app.get("/api/public/bookings/:code", h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const r = await pool.query(
    `SELECT p.booking_code, p.seats, p.status AS pledge_status,
            d.id AS dep_id, d.route, d.date, d.start_date, d.end_date, d.city,
            d.status AS dep_status, d.min_seats,
            (SELECT COALESCE(SUM(seats), 0) FROM pledges WHERE departure_id = d.id AND status <> 'cancelled') AS seats_booked,
            tp.title AS product_title
       FROM pledges p
       JOIN departures d ON d.id = p.departure_id
       LEFT JOIN tour_products tp ON tp.id = d.tour_product_id
      WHERE UPPER(p.booking_code) = UPPER($1)
      LIMIT 1`,
    [code]
  );
  if (!r.rows.length) throw new AppError(404, "Booking not found.");
  const b = r.rows[0];
  const goAhead = Number(b.min_seats) || 4;
  const seatsBooked = Number(b.seats_booked) || 0;
  const cancelled = b.pledge_status === "cancelled";
  const confirmed = !cancelled && (b.dep_status === "supplier_confirmed" || seatsBooked >= goAhead);
  const fmt = (s) => {
    if (!s) return "";
    const d = s instanceof Date ? s : new Date(`${s}T12:00:00`);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  };
  const dateLabel = b.start_date ? `${fmt(b.start_date)} – ${fmt(b.end_date)}` : fmt(b.date);
  res.json({ booking: {
    code: b.booking_code,
    tourTitle: b.product_title || b.route,
    city: b.city || "",
    dateLabel,
    seats: Number(b.seats),
    seatsBooked,
    goAhead,
    confirmed,
    statusLabel: cancelled ? "Cancelled" : confirmed ? "Confirmed — GoAhead" : "Forming",
    statusTone: cancelled ? "cancelled" : confirmed ? "go" : "pending",
  } });
}));

// ---- Referrals / affiliate tracking -----------------------------------------

// Public: count a click-through from a partner widget. Fire-and-forget.
app.post("/api/track/referral", h(async (req, res) => {
  const code = cleanRefCode((req.body || {}).code);
  if (!code) return res.status(204).end();
  await pool.query(
    `INSERT INTO referrals (code, visits) VALUES ($1, 1)
     ON CONFLICT (code) DO UPDATE SET visits = referrals.visits + 1`,
    [code]
  );
  res.status(204).end();
}));

// Admin: per-partner performance (visits, bookings, revenue, commission).
app.get("/api/admin/referrals", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const r = await pool.query(
    `SELECT r.code, r.name, r.commission_percent, r.visits, r.active, r.created_at,
            COUNT(p.id) FILTER (WHERE p.status <> 'cancelled') AS bookings,
            COALESCE(SUM(p.seats) FILTER (WHERE p.status <> 'cancelled'), 0) AS travellers,
            COALESCE(SUM(p.booking_total) FILTER (WHERE p.status <> 'cancelled'), 0) AS revenue
       FROM referrals r
       LEFT JOIN pledges p ON p.ref_code = r.code
      GROUP BY r.code
      ORDER BY revenue DESC, r.visits DESC, r.code`
  );
  res.json({ referrals: r.rows.map((x) => {
    const revenue = Number(x.revenue) || 0;
    const visits = Number(x.visits) || 0;
    const bookings = Number(x.bookings) || 0;
    const commissionPercent = Number(x.commission_percent) || 0;
    return {
      code: x.code, name: x.name || "", commissionPercent, visits, bookings,
      travellers: Number(x.travellers) || 0, revenue, active: x.active !== false,
      conversion: visits ? Math.round((bookings / visits) * 1000) / 10 : 0,
      commission: Math.round(revenue * commissionPercent) / 100,
    };
  }) });
}));

// Agency: fetch (or auto-create) this agency's own referral code + its stats,
// so it can self-serve the tracked widget without the admin.
app.get("/api/agency/widget", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const agencyId = req.user.agencyId;
  if (!agencyId) throw new AppError(403, "This account is not linked to an agency.");
  let row = (await pool.query("SELECT * FROM referrals WHERE agency_id = $1 LIMIT 1", [agencyId])).rows[0];
  if (!row) {
    const ag = (await pool.query("SELECT name FROM agencies WHERE id = $1", [agencyId])).rows[0];
    const base = cleanRefCode(ag?.name) || `agency-${cleanRefCode(agencyId)}`;
    let code = base, n = 1;
    while ((await pool.query("SELECT 1 FROM referrals WHERE code = $1", [code])).rowCount) code = `${base}-${++n}`;
    await pool.query("INSERT INTO referrals (code, name, agency_id) VALUES ($1, $2, $3)", [code, ag?.name || "Agency", agencyId]);
    row = (await pool.query("SELECT * FROM referrals WHERE code = $1", [code])).rows[0];
  }
  const agg = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled') AS bookings,
            COALESCE(SUM(booking_total) FILTER (WHERE status <> 'cancelled'), 0) AS revenue
       FROM pledges WHERE ref_code = $1`, [row.code])).rows[0];
  res.json({
    code: row.code, name: row.name || "", visits: row.visits || 0,
    bookings: Number(agg.bookings) || 0, revenue: Number(agg.revenue) || 0,
    commissionPercent: Number(row.commission_percent) || 0,
  });
}));

// Admin: create or update a partner code.
app.post("/api/admin/referrals", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const code = cleanRefCode(body.code || body.name);
  if (!code) throw new AppError(422, "A code (or name) is required.");
  const commission = Math.min(100, Math.max(0, Number(body.commissionPercent) || 0));
  await pool.query(
    `INSERT INTO referrals (code, name, commission_percent, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), referrals.name),
       commission_percent = EXCLUDED.commission_percent,
       active = EXCLUDED.active`,
    [code, String(body.name || "").trim(), commission, body.active === false ? false : true]
  );
  await logAudit(req, { action: "referral.upsert", entity: "referral", entityId: code });
  res.status(201).json({ code });
}));

// ---- Destinations: tourist-facing cities, each owning its meeting points ----
const mapDest = (d) => ({
  id: d.id, name: d.name, meetingPoints: d.meeting_points || [],
  active: d.active !== false, sortOrder: d.sort_order,
});

// Public: active destinations (used by the tour editor + site).
app.get("/api/destinations", h(async (_req, res) => {
  const r = await pool.query("SELECT * FROM destinations WHERE active = true ORDER BY sort_order, name");
  res.json({ destinations: r.rows.map(mapDest) });
}));

// Admin: all destinations (including inactive).
app.get("/api/admin/destinations", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const r = await pool.query("SELECT * FROM destinations ORDER BY sort_order, name");
  res.json({ destinations: r.rows.map(mapDest) });
}));

// Admin: create or update a destination.
app.post("/api/admin/destinations", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw new AppError(422, "Destination name is required.");
  const mps = Array.isArray(req.body?.meetingPoints)
    ? req.body.meetingPoints.map((m) => ({ point: String(m.point || "").trim(), note: String(m.note || "").trim() })).filter((m) => m.point)
    : [];
  const active = req.body?.active !== false;
  const sortOrder = Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0;
  let row;
  if (req.body?.id) {
    const r = await pool.query(
      "UPDATE destinations SET name=$1, meeting_points=$2, active=$3, sort_order=$4 WHERE id=$5 RETURNING *",
      [name, JSON.stringify(mps), active, sortOrder, Number(req.body.id)]
    );
    if (!r.rows.length) throw new AppError(404, "Destination not found.");
    row = r.rows[0];
  } else {
    const r = await pool.query(
      `INSERT INTO destinations (name, meeting_points, active, sort_order) VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET meeting_points=EXCLUDED.meeting_points, active=EXCLUDED.active, sort_order=EXCLUDED.sort_order
       RETURNING *`,
      [name, JSON.stringify(mps), active, sortOrder]
    );
    row = r.rows[0];
  }
  await logAudit(req, { action: "destination.save", entity: "destination", entityId: row.id, detail: { name } });
  res.status(201).json({ destination: mapDest(row) });
}));

// Admin: delete a destination.
app.delete("/api/admin/destinations/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const r = await pool.query("DELETE FROM destinations WHERE id=$1 RETURNING id", [Number(req.params.id)]);
  if (!r.rows.length) throw new AppError(404, "Destination not found.");
  await logAudit(req, { action: "destination.delete", entity: "destination", entityId: Number(req.params.id) });
  res.json({ ok: true });
}));

// ---- Blog posts (content + SEO + GEO) ----
const mapPost = (b) => ({
  id: b.id, slug: b.slug, title: b.title, excerpt: b.excerpt || "", coverImage: b.cover_image || "",
  bodyHtml: b.body_html || "", author: b.author || "", authorCredentials: b.author_credentials || "",
  tags: b.tags || [], status: b.status || "draft",
  publishedAt: b.published_at instanceof Date ? b.published_at.toISOString() : b.published_at,
  metaTitle: b.meta_title || "", metaDescription: b.meta_description || "", keywords: b.keywords || [],
  canonicalUrl: b.canonical_url || "", ogImage: b.og_image || "", noindex: b.noindex === true,
  tldr: b.tldr || "", keyTakeaways: b.key_takeaways || [], faq: b.faq || [],
  geoRegion: b.geo_region || "", geoPlace: b.geo_place || "", geoLat: b.geo_lat || "", geoLng: b.geo_lng || "",
  localKeywords: b.local_keywords || [],
  updatedAt: b.updated_at instanceof Date ? b.updated_at.toISOString() : b.updated_at,
});
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "post";

// Public: published posts (list).
app.get("/api/blog", h(async (_req, res) => {
  const r = await pool.query("SELECT * FROM blog_posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, updated_at DESC");
  res.json({ posts: r.rows.map(mapPost) });
}));

// Public: a single published post by slug.
app.get("/api/blog/:slug", h(async (req, res) => {
  const r = await pool.query("SELECT * FROM blog_posts WHERE slug=$1 AND status='published' LIMIT 1", [req.params.slug]);
  if (!r.rows.length) throw new AppError(404, "Post not found.");
  res.json({ post: mapPost(r.rows[0]) });
}));

// Admin: all posts (incl. drafts).
app.get("/api/admin/blog", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const r = await pool.query("SELECT * FROM blog_posts ORDER BY updated_at DESC");
  res.json({ posts: r.rows.map(mapPost) });
}));

// Admin: create or update a post.
app.post("/api/admin/blog", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim();
  if (!title) throw new AppError(422, "Title is required.");
  const id = b.id || `blog_${slugify(title).slice(0, 32)}_${Math.random().toString(36).slice(2, 8)}`;
  const slug = slugify(b.slug || title);
  const status = b.status === "published" ? "published" : "draft";
  const arr = (v) => JSON.stringify(Array.isArray(v) ? v : []);
  const faq = JSON.stringify(Array.isArray(b.faq) ? b.faq.map((f) => ({ q: String(f.q || "").trim(), a: String(f.a || "").trim() })).filter((f) => f.q) : []);
  const row = (await pool.query(
    `INSERT INTO blog_posts
       (id, slug, title, excerpt, cover_image, body_html, author, author_credentials, tags, status, published_at,
        meta_title, meta_description, keywords, canonical_url, og_image, noindex,
        tldr, key_takeaways, faq, geo_region, geo_place, geo_lat, geo_lng, local_keywords, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        CASE WHEN $10='published' THEN COALESCE($11::timestamptz, now()) ELSE $11::timestamptz END,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now())
     ON CONFLICT (id) DO UPDATE SET
        slug=EXCLUDED.slug, title=EXCLUDED.title, excerpt=EXCLUDED.excerpt, cover_image=EXCLUDED.cover_image,
        body_html=EXCLUDED.body_html, author=EXCLUDED.author, author_credentials=EXCLUDED.author_credentials,
        tags=EXCLUDED.tags, status=EXCLUDED.status,
        published_at=CASE WHEN EXCLUDED.status='published' THEN COALESCE(blog_posts.published_at, now()) ELSE EXCLUDED.published_at END,
        meta_title=EXCLUDED.meta_title, meta_description=EXCLUDED.meta_description, keywords=EXCLUDED.keywords,
        canonical_url=EXCLUDED.canonical_url, og_image=EXCLUDED.og_image, noindex=EXCLUDED.noindex,
        tldr=EXCLUDED.tldr, key_takeaways=EXCLUDED.key_takeaways, faq=EXCLUDED.faq,
        geo_region=EXCLUDED.geo_region, geo_place=EXCLUDED.geo_place, geo_lat=EXCLUDED.geo_lat,
        geo_lng=EXCLUDED.geo_lng, local_keywords=EXCLUDED.local_keywords, updated_at=now()
     RETURNING *`,
    [
      id, slug, title, b.excerpt || null, b.coverImage || null, cleanHtml(b.bodyHtml) || null, b.author || null,
      b.authorCredentials || null, arr(b.tags), status, b.publishedAt || null,
      b.metaTitle || null, b.metaDescription || null, arr(b.keywords), b.canonicalUrl || null, b.ogImage || null,
      b.noindex === true, b.tldr || null, arr(b.keyTakeaways), faq, b.geoRegion || null, b.geoPlace || null,
      b.geoLat || null, b.geoLng || null, arr(b.localKeywords),
    ]
  )).rows[0];
  await logAudit(req, { action: "blog.save", entity: "blog_post", entityId: row.id, detail: { title, status } });
  res.status(201).json({ post: mapPost(row) });
}));

// Admin: delete a post.
app.delete("/api/admin/blog/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const r = await pool.query("DELETE FROM blog_posts WHERE id=$1 RETURNING id", [req.params.id]);
  if (!r.rows.length) throw new AppError(404, "Post not found.");
  await logAudit(req, { action: "blog.delete", entity: "blog_post", entityId: req.params.id });
  res.json({ ok: true });
}));

// ---- shared write helpers ----
async function insertPledge(c, departureId, p) {
  await c.query(
    `INSERT INTO pledges
      (id, departure_id, agency_id, agency, seats, customers, price_per_person, booking_total,
       deposit_percent, deposit_due, balance_due, balance_due_date, source, booking_code,
       rooming_type, accommodation_tier, accommodation_tier_name, created_by_user_id, customer_email,
       customer_phone, ref_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      p.id, departureId, p.agencyId ?? null, p.agency ?? null, p.seats, p.customers ?? null,
      p.pricePerPerson ?? null, p.bookingTotal ?? null, p.depositPercent ?? null,
      p.depositDue ?? null, p.balanceDue ?? null, p.balanceDueDate ?? null,
      p.source ?? null, p.bookingCode ?? null, p.roomingType ?? null,
      p.accommodationTier ?? null, p.accommodationTierName ?? null, p.createdByUserId ?? null,
      p.customerEmail ?? null, p.customerPhone ?? null, p.refCode ?? null,
    ]
  );
  await refreshStatus(c, departureId);
}

async function refreshStatus(c, departureId) {
  const dep = await c.query(`SELECT * FROM departures WHERE id=$1`, [departureId]);
  const row = dep.rows[0];
  if (["supplier_confirmed", "closed", "cancelled"].includes(row.status)) return;
  // Cancelled pledges have freed their seats — exclude them from the count.
  const seats = (await c.query(
    `SELECT COALESCE(SUM(seats),0) AS s FROM pledges WHERE departure_id=$1 AND status <> 'cancelled'`,
    [departureId]
  )).rows[0].s;
  const required = Math.max(1, Number(row.min_seats) || DEFAULT_GO_AHEAD);
  const status = Number(seats) >= required ? "minimum_reached" : "open";
  await c.query(`UPDATE departures SET status=$1 WHERE id=$2`, [status, departureId]);
}

// ============================ STAFF & AGENCY MANAGEMENT ============================
// Email isn't built until Phase 5, so creating an account returns a one-time
// temporary password the creator shares manually. Phase 5 swaps this for invites.

function tempPassword() {
  // Readable, reasonably strong one-time password.
  const part = () => Math.random().toString(36).slice(2, 6);
  return `Sawa-${part()}-${part()}`;
}

function requireAdmin() {
  return requireRole("super_admin");
}

// Create a Supabase auth user + app_users profile. Returns { id, tempPassword }.
async function provisionUser({ email, fullName, role, agencyId }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) throw new AppError(422, "Email is required.");
  if (!supabaseAdmin) throw new AppError(500, "Server is not configured to create accounts.");

  // Reject if an app profile already exists for this email.
  const existing = await pool.query(`SELECT id FROM app_users WHERE lower(email) = $1`, [normalizedEmail]);
  if (existing.rows.length) throw new AppError(409, "An account with that email already exists.");

  const password = tempPassword();
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName || null },
  });
  if (error) {
    // If the auth user exists but no profile, surface a clear message.
    throw new AppError(409, error.message || "Could not create the login.");
  }

  try {
    await pool.query(
      `INSERT INTO app_users (id, email, full_name, role, agency_id, status)
       VALUES ($1,$2,$3,$4,$5,'active')`,
      [data.user.id, normalizedEmail, fullName || null, role, agencyId]
    );
  } catch (e) {
    // Roll back the auth user if the profile insert fails, so we don't orphan it.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw e;
  }
  return { id: data.user.id, tempPassword: password };
}

const newStaffSchema = z.object({
  email: z.string().email("A valid email is required."),
  fullName: z.string().trim().min(1, "Name is required."),
  role: z.enum(["agency_agent", "agency_owner"]).default("agency_agent"),
});

// --- Agency owner: manage their own team -----------------------------------

app.get("/api/agency/staff", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT id, email, full_name, role, status, created_at
       FROM app_users WHERE agency_id = $1 ORDER BY created_at ASC`,
    [req.user.agencyId]
  );
  res.json({ staff: r.rows.map(mapStaff) });
}));

app.post("/api/agency/staff", requireAuth, requireRole("agency_owner"), writeLimiter, h(async (req, res) => {
  const input = newStaffSchema.parse(req.body || {});
  const created = await provisionUser({
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    agencyId: req.user.agencyId, // always the owner's own agency — cannot target another
  });
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [created.id])).rows[0];
  const agencyName = (await pool.query(`SELECT name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0]?.name;
  await logAudit(req, { action: "staff.create", entity: "user", entityId: created.id, detail: { email: input.email, role: input.role, agencyId: req.user.agencyId } });
  sendEmail(inviteEmail({ to: input.email, fullName: input.fullName, agencyName, tempPassword: created.tempPassword, role: input.role })).catch(() => {});
  res.status(201).json({ staff: mapStaff(row), tempPassword: created.tempPassword, emailMode });
}));

app.patch("/api/agency/staff/:id", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const target = await loadAgencyStaff(req.params.id, req.user.agencyId);
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot change your own role or status.");

  const role = req.body?.role;
  const status = req.body?.status;
  if (role && !["agency_owner", "agency_agent"].includes(role)) throw new AppError(422, "Invalid role.");
  if (status && !["active", "disabled"].includes(status)) throw new AppError(422, "Invalid status.");

  await pool.query(
    `UPDATE app_users SET role = COALESCE($1, role), status = COALESCE($2, status) WHERE id = $3`,
    [role || null, status || null, target.id]
  );
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  res.json({ staff: mapStaff(row) });
}));

app.delete("/api/agency/staff/:id", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const target = await loadAgencyStaff(req.params.id, req.user.agencyId);
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot remove your own account.");
  // Deactivate (keeps history + bookings intact) and revoke the login.
  await pool.query(`UPDATE app_users SET status='disabled' WHERE id=$1`, [target.id]);
  if (supabaseAdmin) await supabaseAdmin.auth.admin.updateUserById(target.id, { ban_duration: "876000h" }).catch(() => {});
  res.json({ ok: true });
}));

async function loadAgencyStaff(id, agencyId) {
  const r = await pool.query(`SELECT * FROM app_users WHERE id=$1`, [id]);
  const row = r.rows[0];
  if (!row || row.agency_id !== agencyId) throw new AppError(404, "Team member not found.");
  return row;
}

function mapStaff(r) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

// --- Super admin: manage agencies + their owners ---------------------------

app.get("/api/admin/agencies", requireAuth, requireAdmin(), h(async (_req, res) => {
  const agencies = (await pool.query(`SELECT * FROM agencies ORDER BY id`)).rows.map(mapAgency);
  const users = (await pool.query(
    `SELECT agency_id, COUNT(*)::int AS staff_count,
            COUNT(*) FILTER (WHERE role='agency_owner')::int AS owner_count
       FROM app_users WHERE agency_id IS NOT NULL GROUP BY agency_id`
  )).rows;
  const byAgency = new Map(users.map((u) => [u.agency_id, u]));
  res.json({
    agencies: agencies.map((a) => ({
      ...a,
      staffCount: byAgency.get(a.id)?.staff_count || 0,
      ownerCount: byAgency.get(a.id)?.owner_count || 0,
    })),
  });
}));

// Admin: list platform staff (super_admin + ops_staff).
app.get("/api/admin/staff", requireAuth, requireAdmin(), h(async (_req, res) => {
  const r = await pool.query(
    `SELECT id, email, full_name, role, status, created_at
       FROM app_users WHERE agency_id IS NULL ORDER BY created_at ASC`
  );
  res.json({ staff: r.rows.map(mapStaff) });
}));

const newOpsStaffSchema = z.object({
  email: z.string().email("A valid email is required."),
  fullName: z.string().trim().min(1, "Name is required."),
  role: z.enum(["ops_staff", "super_admin"]).default("ops_staff"),
});

// Admin: create a platform staff member (super_admin only).
app.post("/api/admin/staff", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const input = newOpsStaffSchema.parse(req.body || {});
  const created = await provisionUser({ email: input.email, fullName: input.fullName, role: input.role, agencyId: null });
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [created.id])).rows[0];
  await logAudit(req, { action: "staff.create", entity: "user", entityId: created.id, detail: { email: input.email, role: input.role, platform: true } });
  sendEmail(inviteEmail({ to: input.email, fullName: input.fullName, agencyName: "Sawa Operations", tempPassword: created.tempPassword, role: input.role })).catch(() => {});
  res.status(201).json({ staff: mapStaff(row), tempPassword: created.tempPassword, emailMode });
}));

// Admin: change a platform staff member's status/role (super_admin only).
app.patch("/api/admin/staff/:id", requireAuth, requireAdmin(), h(async (req, res) => {
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot change your own account.");
  const target = (await pool.query(`SELECT * FROM app_users WHERE id=$1`, [req.params.id])).rows[0];
  if (!target || target.agency_id !== null) throw new AppError(404, "Staff member not found.");
  const role = req.body?.role, status = req.body?.status;
  if (role && !["ops_staff", "super_admin"].includes(role)) throw new AppError(422, "Invalid role.");
  if (status && !["active", "disabled"].includes(status)) throw new AppError(422, "Invalid status.");
  await pool.query(`UPDATE app_users SET role=COALESCE($1,role), status=COALESCE($2,status) WHERE id=$3`, [role || null, status || null, target.id]);
  if (status === "disabled" && supabaseAdmin) await supabaseAdmin.auth.admin.updateUserById(target.id, { ban_duration: "876000h" }).catch(() => {});
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  res.json({ staff: mapStaff(row) });
}));

const newAgencySchema = z.object({
  name: z.string().trim().min(1, "Agency name is required."),
  contactName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  ownerEmail: z.string().email("A valid owner email is required."),
  ownerName: z.string().trim().min(1, "Owner name is required."),
});

app.post("/api/admin/agencies", requireAuth, requireAdmin(), writeLimiter, h(async (req, res) => {
  const input = newAgencySchema.parse(req.body || {});

  // Create the agency record first (its own short id), then its owner login.
  const agencyId = await withTransaction(async (c) => {
    const idRow = await c.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(id,'\\D','','g'),''))::int,0)+1 AS n FROM agencies WHERE id LIKE 'ag_%'`);
    const id = `ag_${idRow.rows[0].n}`;
    await c.query(
      `INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ($1,$2,$3,$4,'active')`,
      [id, input.name, input.contactName || input.ownerName, input.phone || null]
    );
    return id;
  });

  let owner;
  try {
    owner = await provisionUser({
      email: input.ownerEmail,
      fullName: input.ownerName,
      role: "agency_owner",
      agencyId,
    });
  } catch (e) {
    // Undo the agency if owner provisioning failed, so we don't leave an ownerless agency.
    await pool.query(`DELETE FROM agencies WHERE id=$1`, [agencyId]).catch(() => {});
    throw e;
  }

  const agencyRow = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [agencyId])).rows[0];
  await logAudit(req, { action: "agency.create", entity: "agency", entityId: agencyId, detail: { name: input.name, ownerEmail: input.ownerEmail } });
  sendEmail(inviteEmail({ to: input.ownerEmail, fullName: input.ownerName, agencyName: input.name, tempPassword: owner.tempPassword, role: "agency_owner" })).catch(() => {});
  res.status(201).json({ agency: mapAgency(agencyRow), ownerEmail: input.ownerEmail, tempPassword: owner.tempPassword, emailMode });
}));

// Admin: recent audit trail (who did what, when).
app.get("/api/admin/audit", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const r = await pool.query(
    `SELECT actor_email, actor_role, action, entity, entity_id, detail, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ entries: r.rows });
}));

// Admin: dashboard overview stats (platform staff).
app.get("/api/admin/stats", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  const [deps, pledges, products, agencies] = await Promise.all([
    pool.query(`SELECT id, status, date, start_date, type, route, min_seats, max_seats FROM departures`),
    pool.query(`SELECT departure_id, seats, booking_total, deposit_due, source, created_at FROM pledges`),
    pool.query(`SELECT id, type, active, status FROM tour_products`),
    pool.query(`SELECT id FROM agencies WHERE status='active'`),
  ]);
  const pendingListings = products.rows.filter((p) => p.status === "pending").length;

  const seatsByDep = new Map();
  let totalSeats = 0, totalRevenue = 0, totalDeposits = 0, bookingsCount = pledges.rows.length;
  const now = new Date();
  const weekAhead = new Date(now); weekAhead.setDate(now.getDate() + 7);
  let bookingsThisWeek = 0;
  for (const p of pledges.rows) {
    seatsByDep.set(p.departure_id, (seatsByDep.get(p.departure_id) || 0) + Number(p.seats));
    totalSeats += Number(p.seats);
    totalRevenue += Number(p.booking_total || 0);
    totalDeposits += Number(p.deposit_due || 0);
    if (p.created_at && new Date(p.created_at) >= new Date(now.getTime() - 7 * 864e5)) bookingsThisWeek++;
  }

  let readyToConfirm = 0, confirmed = 0, open = 0, atRisk = 0;
  for (const d of deps.rows) {
    const seats = seatsByDep.get(d.id) || 0;
    const min = Math.max(1, d.min_seats || 4);
    if (d.status === "supplier_confirmed") confirmed++;
    else if (seats >= min) readyToConfirm++;
    else {
      open++;
      const start = new Date(d.start_date || d.date);
      const daysOut = (start - now) / 864e5;
      if (daysOut >= 0 && daysOut <= 14 && seats < min) atRisk++;
    }
  }

  res.json({
    totals: {
      departures: deps.rows.length,
      dayTours: products.rows.filter((p) => p.type === "day_tour").length,
      packages: products.rows.filter((p) => p.type === "package").length,
      activeProducts: products.rows.filter((p) => p.active !== false).length,
      agencies: agencies.rows.length,
      bookings: bookingsCount,
      bookingsThisWeek,
      seatsPooled: totalSeats,
      revenue: totalRevenue,
      depositsDue: totalDeposits,
    },
    pendingListings,
    departureStatus: { open, readyToConfirm, confirmed, atRisk },
  });
}));

// Admin: all bookings across the platform (platform staff).
app.get("/api/admin/bookings", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const r = await pool.query(
    `SELECT p.id, p.departure_id, p.agency, p.agency_id, p.seats, p.customers, p.customer_email,
            p.customer_phone, p.status, p.price_per_person, p.deposit_percent,
            p.booking_total, p.deposit_due, p.balance_due, p.balance_due_date, p.source,
            p.booking_code, p.rooming_type, p.accommodation_tier_name, p.created_at,
            d.route, d.date, d.start_date, d.end_date, d.type, d.city, d.time, d.status AS departure_status
       FROM pledges p JOIN departures d ON d.id = p.departure_id
      ORDER BY p.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ bookings: r.rows.map((b) => ({
    id: b.id, departureId: b.departure_id, route: b.route, type: b.type, city: b.city, time: b.time,
    date: b.start_date || b.date, endDate: b.end_date, departureStatus: b.departure_status,
    agency: b.agency, agencyId: b.agency_id, seats: Number(b.seats), customers: b.customers,
    customerEmail: b.customer_email, customerPhone: b.customer_phone, status: b.status || "confirmed",
    pricePerPerson: b.price_per_person != null ? Number(b.price_per_person) : null,
    depositPercent: b.deposit_percent != null ? Number(b.deposit_percent) : null,
    roomingType: b.rooming_type, accommodationTierName: b.accommodation_tier_name,
    bookingTotal: b.booking_total != null ? Number(b.booking_total) : null,
    depositDue: b.deposit_due != null ? Number(b.deposit_due) : null,
    balanceDue: b.balance_due != null ? Number(b.balance_due) : null,
    balanceDueDate: b.balance_due_date, source: b.source, bookingCode: b.booking_code,
    createdAt: b.created_at instanceof Date ? b.created_at.toISOString() : b.created_at,
  })) });
}));

// Admin: change a booking's status (pending/confirmed/paid/cancelled).
app.patch("/api/admin/bookings/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const status = req.body?.status;
  if (!["pending", "confirmed", "paid", "cancelled"].includes(status)) throw new AppError(422, "Invalid status.");
  // Run inside a transaction and recompute the departure's status so that
  // cancelling (or reinstating) a booking frees or reclaims its seats.
  await withTransaction(async (c) => {
    const r = await c.query(`UPDATE pledges SET status=$1 WHERE id=$2 RETURNING departure_id`, [status, req.params.id]);
    if (!r.rows.length) throw new AppError(404, "Booking not found.");
    await refreshStatus(c, r.rows[0].departure_id);
  });
  await logAudit(req, { action: "booking.status", entity: "pledge", entityId: req.params.id, detail: { status } });
  res.json({ ok: true, status });
}));

// Admin: archive / unarchive a tour product (platform staff).
app.patch("/api/admin/tour-products/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== "boolean") throw new AppError(422, "active (boolean) is required.");
  const r = await pool.query(`UPDATE tour_products SET active=$1 WHERE id=$2 RETURNING id`, [active, req.params.id]);
  if (!r.rows.length) throw new AppError(404, "Tour product not found.");
  await logAudit(req, { action: active ? "product.activate" : "product.archive", entity: "tour_product", entityId: req.params.id });
  res.json({ ok: true, active });
}));

// Admin: cancel a departure (platform staff).
app.post("/api/admin/departures/:id/cancel", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    await c.query(`UPDATE departures SET status='cancelled' WHERE id=$1`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure.cancel", entity: "departure", entityId: departure.id, detail: { route: departure.route } });
  const dateLabel = departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date;
  const recips = await pool.query(`SELECT DISTINCT customer_email FROM pledges WHERE departure_id=$1 AND customer_email IS NOT NULL`, [departure.id]);
  for (const row of recips.rows) sendEmail(cancellationEmail({ to: row.customer_email, route: departure.route, dateLabel })).catch(() => {});
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Upload a tour image. Open to platform staff AND agency users, since agencies
// upload photos for their own tour listings via the shared product editor.
// Accepts JSON { filename, dataUrl } where dataUrl is a base64 data URI and
// returns the public URL.
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
app.post("/api/admin/uploads", requireAuth, requireRole("super_admin", "ops_staff", "agency_owner", "agency_agent"), uploadLimiter, express.json({ limit: "8mb" }), h(async (req, res) => {
  if (!supabaseAdmin) throw new AppError(500, "Storage is not configured.");
  const { filename, dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== "string") throw new AppError(422, "No image provided.");
  const m = dataUrl.match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/);
  if (!m) throw new AppError(422, "Unsupported image format. Use PNG, JPG, WEBP, or GIF.");
  const contentType = m[1];
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const buffer = Buffer.from(m[3], "base64");
  if (buffer.length > 6 * 1024 * 1024) throw new AppError(422, "Image is larger than 6MB.");

  const safe = String(filename || "image").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const key = `tours/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}.${ext}`;
  const { error } = await supabaseAdmin.storage.from("tour-images").upload(key, buffer, { contentType, upsert: false });
  if (error) throw new AppError(500, "Upload failed: " + error.message);
  const { data } = supabaseAdmin.storage.from("tour-images").getPublicUrl(key);
  await logAudit(req, { action: "image.upload", entity: "tour_image", entityId: key });
  res.status(201).json({ url: data.publicUrl, key });
}));

// Unknown /api/* path -> JSON 404.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// ============================ AI-readability files ============================
app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt()));
app.get("/llms.txt", (_req, res) => res.type("text/plain").send(llmsTxt()));
app.get("/llms-full.txt", (_req, res) => res.type("text/plain").send(llmsFullTxt()));
app.get("/sitemap.xml", h(async (_req, res) => res.type("application/xml").send(await sitemapXml())));

// ============================ MARKETING SITE (editorial) ============================
// Static editorial pages live in /site (index, departures, trust, operators,
// verify, widget, about, contact, faq). Served at the root so their relative
// links (index.html, departures.html, assets/…) resolve as-authored. Tour CTAs
// point at tour.html / pricing.html which don't exist as static pages — redirect
// those to the live React booking app so real departures keep working.
const siteDir = join(__dirname, "..", "site");
if (existsSync(siteDir)) {
  // Canonicalize to clean, extensionless, SEO-friendly URLs: any /page.html
  // permanently redirects to /page. `index` -> /, and the two designed links
  // that have no page of their own map to real pages.
  const htmlAlias = { index: "/", tour: "/departures", pricing: "/operators" };
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const m = req.path.match(/^\/([a-z0-9-]+)\.html$/i);
    if (!m) return next();
    const name = m[1].toLowerCase();
    return res.redirect(301, htmlAlias[name] || `/${name}`);
  });
  app.get("/", (_req, res) => res.sendFile(join(siteDir, "index.html")));
  // extensions:["html"] serves /operators from operators.html, etc.
  app.use(express.static(siteDir, { extensions: ["html"] }));
}

// ============================ LEGACY TOUR URL → SEO SLUG (301) ============================
// Old ugly URLs (/tour/<db-id>) permanently redirect to the clean slug URL so any
// existing links / search-engine index entries pass their value to the new URL.
// Clean slug URLs (no tour_/pkg_ prefix) fall through to the SPA untouched.
app.use(h(async (req, res, next) => {
  if (req.method !== "GET") return next();
  const m = req.path.match(/^\/(tour|package)\/([^/]+)\/?$/);
  if (!m) return next();
  const seg = decodeURIComponent(m[2]);
  if (!/^(tour|pkg)_/.test(seg)) return next(); // already a clean slug
  const r = await pool.query("SELECT id, title, city, type FROM tour_products WHERE id=$1 AND active IS NOT FALSE LIMIT 1", [seg]);
  if (!r.rows.length) return next();
  const kind = r.rows[0].type === "package" ? "package" : "tour";
  return res.redirect(301, `/${kind}/${tourSlug(r.rows[0])}`);
}));

// ============================ STATIC SPA (production) ============================
// Serve the built frontend from /dist. For HTML routes, inject a fully-formed
// <head> (title, meta, OpenGraph, JSON-LD) server-side so crawlers and AI
// engines read complete pages; the SPA still hydrates the body normally.
if (existsSync(distDir)) {
  const template = readFileSync(join(distDir, "index.html"), "utf8");
  const renderPage = async (req, res) => {
    try {
      const { title, head } = await buildHead(req.path);
      const html = template
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${title.replace(/</g, "&lt;")}</title>`)
        .replace("</head>", `${head}\n</head>`);
      res.type("html").send(html);
    } catch (e) {
      console.error("[seo] head injection failed for", req.path, "-", e.message);
      res.sendFile(join(distDir, "index.html"));
    }
  };
  // Root must be handled before static (static would otherwise serve raw index.html).
  app.get("/", renderPage);
  app.use(express.static(distDir, { index: false }));
  app.get("/*all", renderPage);      // all other client routes
}

// ============================ ERRORS ============================
app.use((err, _req, res, _next) => {
  if (err?.issues?.length) {
    return res.status(422).json({ error: err.issues[0]?.message || "Invalid request." });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // Never surface raw internal error text (e.g. Postgres messages) to clients.
  // 4xx errors are our own AppError/AuthError with safe, user-facing messages.
  const message = status >= 500 ? "Server error." : (err.message || "Request failed.");
  res.status(status).json({ error: message });
});

// Railway provides PORT; fall back to API_PORT for local dev.
const port = Number(process.env.PORT || process.env.API_PORT || 8787);
app.listen(port, "0.0.0.0", () => console.log(`Sawa listening on :${port}`));
