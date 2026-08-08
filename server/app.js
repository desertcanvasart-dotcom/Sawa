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
  departureStarted,
  validatePriceTiers,
  capacityError,
  MAX_GROUP_SIZE,
  MIN_GROUP_SIZE,
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
  departureRequestReceivedEmail, departureRequestApprovedEmail, departureRequestDeclinedEmail,
  operatorApplicationEmail, operatorApplicationReceiptEmail, operatorApplicationText,
} from "./email.js";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHead, buildBody, robotsTxt, sitemapXml, llmsTxt, llmsFullTxt,
  inlineScriptJson, sliceBootstrapForRoute, clearSeoCaches,
} from "./seo.js";
import { emitDepartureSync, unavailableDates } from "./autoura-sync.js";
import { tourSlug } from "./slug.js";
import { BRAND } from "./brand.js";
import { startJobScheduler } from "./jobs/scheduler.js";
import { cleanHtml, cleanItinerary } from "./sanitize.js";
import { canonicalRedirect } from "./canonical.js";
import { injectStaticSchema } from "./static-seo.js";
import { cacheState, PAGE_TTL_MS, PAGE_STALE_TTL_MS } from "./page-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");

const app = express();
app.disable("x-powered-by");
// Railway (like any managed host) terminates TLS at a proxy, so req.ip is the
// proxy's own address unless Express is told how many hops to trust. Without
// this every visitor lands in the SAME rate-limit bucket and a handful of users
// 429s the whole site. TRUST_PROXY tunes the hop count for other hosting
// setups ("false"/"0" disables it); local dev has no proxy, so nothing is
// trusted there and a spoofed X-Forwarded-For can't shift anyone's bucket.
const trustProxy = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === "production" ? "1" : "false");
if (trustProxy !== "false" && trustProxy !== "0") {
  app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}
// www.<domain> and the apex both resolve to this app, so collapse them onto one
// canonical host before anything else runs — see server/canonical.js. No-op
// until CANONICAL_HOST is set.
app.use((req, res, next) => {
  const target = canonicalRedirect(req.headers.host, req.originalUrl);
  return target ? res.redirect(301, target) : next();
});
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
      // status must survive redaction: a cancelled pledge has released its
      // seats, and without this the viewer counts it as still occupying them.
      status: p.status,
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
  // The product carries any per-listing confirm-deadline override; without it
  // enrichDeparture falls back to the type default, which is right but ignores
  // what the operator set.
  const productRow = dep.rows[0].tour_product_id
    ? await client.query(`SELECT * FROM tour_products WHERE id = $1`, [dep.rows[0].tour_product_id])
    : null;
  const product = productRow?.rows?.length ? mapProduct(productRow.rows[0]) : null;
  return enrichDeparture(mapDeparture(dep.rows[0], pledges.rows), product);
}

async function loadProduct(client, id) {
  const r = await client.query(`SELECT * FROM tour_products WHERE id = $1`, [id]);
  return r.rows.length ? mapProduct(r.rows[0]) : null;
}

// A booking code is the ONLY credential on the public booking lookup, so it
// needs real entropy: 8 symbols from a 31-character alphabet (~8.5e11
// combinations) drawn with crypto randomInt, not Math.random. Ambiguous glyphs
// (0/O, 1/I/L) are left out because travellers read these codes back to us.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function publicBookingCode() {
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `SAWA-${out}`;
}

// The unique index on UPPER(booking_code) is the real guarantee; this loop just
// keeps a (vanishingly rare) collision from reaching the traveller as a failed
// booking. Runs on the transaction's client so it sees uncommitted siblings.
async function uniqueBookingCode(c) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = publicBookingCode();
    const hit = await c.query(`SELECT 1 FROM pledges WHERE UPPER(booking_code) = $1`, [code]);
    if (!hit.rowCount) return code;
  }
  throw new AppError(500, "Could not allocate a booking code.");
}

// Pledge ids are the primary key, and Date.now() alone collides when two
// bookings land in the same millisecond — which the departure row-lock makes
// likelier, not rarer, since it queues them back-to-back. A collision would
// surface to the traveller as a generic 500 and lose the booking.
function newPledgeId(departureId = "new") {
  return `pl_${departureId}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
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

// Operator verification application (site/verify.html). Every field is bounded:
// this endpoint is open to the internet and the values land in an email and an
// ops table, so an unbounded `about` is a free megabyte per request.
const operatorApplicationSchema = z.object({
  company: z.string().trim().min(1, "Company name is required.").max(160),
  contactName: z.string().trim().min(1, "Contact name is required.").max(160),
  city: z.string().trim().min(1, "City is required.").max(120),
  email: z.string().trim().email("A valid email is required.").max(200),
  phone: z.string().trim().max(60).optional().or(z.literal("")),
  licence: z.string().trim().min(1, "Tourism licence number is required.").max(120),
  regions: z.string().trim().max(160).optional().or(z.literal("")),
  about: z.string().trim().max(4000).optional().or(z.literal("")),
  // The consent tick is required in the form's own markup; it is re-checked
  // here so a scripted post can't create an application nobody agreed to.
  consent: z.literal(true, { message: "Please confirm the licence and insurance declaration." }),
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
  minSeats: z.coerce.number().int().min(MIN_GROUP_SIZE, {
    message: `Minimum group size is ${MIN_GROUP_SIZE} travellers — what the booking conditions promise a departure confirms at.`,
  }).max(MAX_GROUP_SIZE).optional(),
  maxSeats: z.coerce.number().int().positive().max(MAX_GROUP_SIZE, {
    message: `Maximum group size is ${MAX_GROUP_SIZE} travellers — the limit stated in the booking conditions.`,
  }).optional(),
  baseCost: z.coerce.number().min(0).max(1_000_000).optional(),
  publishedRate: z.coerce.number().positive().max(1_000_000).optional(),
  breakPrice: z.coerce.number().min(0).max(1_000_000).optional(),
}).refine((v) => !(v.minSeats && v.maxSeats) || v.maxSeats >= v.minSeats, {
  message: "Max seats cannot be less than min seats.",
});

// Traveler-initiated departure request (Phase A of the traveler-initiated
// departures addendum). Email is required — approval/decline needs a channel.
const publicDepartureRequestSchema = z.object({
  tourProductId: z.string().trim().min(1, "Tour is required."),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid date (YYYY-MM-DD) is required."),
  customerName: z.string().trim().min(1, "Traveller name is required."),
  customerEmail: z.string().trim().email("A valid email is required."),
  customerPhone: z.string().trim().optional(),
  seats: z.coerce.number().int().min(1).max(20),
  note: z.string().trim().max(500).optional(),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
  // Join-first rule: near-matches must be explicitly rejected client-side
  // before a create is allowed through.
  ignoreMatches: z.coerce.boolean().optional(),
});

// Eligibility fences for traveler-picked dates (addendum defaults).
const REQUEST_MIN_LEAD_DAYS = 3;
const REQUEST_MAX_HORIZON_DAYS = 90;
const NEAR_MATCH_WINDOW_DAYS = 3;

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
// The published-post list is read on every /blog view and never varies per
// visitor, so cache it the same way. Both are dropped on any successful write.
const PUBLIC_BLOG_TTL = 60_000;
let publicBlogCache = { at: 0, payload: null };
// The server-rendered page cache and llms-full.txt snapshot also go stale on a
// write (they embed seat counts and prices), but they're defined further down —
// the SPA one only exists when /dist is present. So they register a clearer here
// instead, and every cache drops together.
const cacheClearers = [];
// The tour lookup and slug index in seo.js embed product rows, so a catalogue
// write has to drop them with everything else.
cacheClearers.push(() => clearSeoCaches());
function invalidatePublicBootstrap() {
  publicBootstrapCache = { at: 0, payload: null };
  publicBlogCache = { at: 0, payload: null };
  for (const clear of cacheClearers) clear();
}

// The anonymous payload, memoised. Extracted so the server-rendered HTML can
// embed exactly the same object the SPA would otherwise fetch (see renderPage):
// one builder means the inlined data and the API can never disagree, which is
// the whole point — a visitor must not watch the numbers change after load.
async function publicBootstrapPayload() {
  if (publicBootstrapCache.payload && Date.now() - publicBootstrapCache.at < PUBLIC_BOOTSTRAP_TTL) {
    return publicBootstrapCache.payload;
  }
  const payload = await buildBootstrap(undefined);
  publicBootstrapCache = { at: Date.now(), payload };
  return payload;
}

// `user` undefined means the anonymous view. Kept as one function so the
// redaction rules below are applied identically to every caller.
async function buildBootstrap(user) {
  // Platform staff see every product (incl. pending/rejected/archived) so they can
  // manage them. Everyone else — the public site and agencies browsing to book —
  // only sees live, approved listings. An agency's own pending/rejected listings
  // are served separately via GET /api/agency/tour-products.
  const canSeeAll = user && (user.role === "super_admin" || user.role === "ops_staff");
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

  // Mapped once and shared: the payload lists them, and each departure needs
  // its own to resolve the confirm deadline.
  const mappedProducts = products.rows.map(mapProduct);
  const productsById = new Map(mappedProducts.map((p) => [p.id, p]));

  return {
    // Only platform staff get the agency directory; agencies/public don't need it.
    agencies: isPlatform(user) ? agencies.rows.map(mapAgency) : [],
    cities: cities.rows.map(mapCity),
    tourProducts: mappedProducts,
    // pending_review = traveler-requested, awaiting ops approval. Only
    // platform staff see them; the public board and agencies must not.
    //
    // Departures whose start has passed are dropped from the anonymous payload
    // — that is the public catalogue and the server-rendered HTML, where an
    // expired date rendered as a joinable card. Signed-in agencies and staff
    // keep the full list: their dashboards count past departures as history.
    departures: departures.rows
      .filter((d) => canSeeAll || d.status !== "pending_review")
      .map((d) => mapDeparture(d, byDep.get(d.id) || []))
      .filter((d) => user || !departureStarted(d))
      // productsById so each departure's confirm deadline honours any override
      // on its listing rather than only the type default.
      .map((d) => presentDeparture(enrichDeparture(d, productsById.get(d.tourProductId) || null), user)),
  };
}

// Bootstrap — open to all; pledge detail redacted per viewer.
app.get("/api/bootstrap", h(async (req, res) => {
  // Still no-store: the response varies by viewer (an agency sees its own
  // pledge detail), so it must never land in a shared cache. The anonymous
  // copy is memoised server-side instead, and now also inlined into the HTML.
  res.set("Cache-Control", "no-store");
  if (!req.user) return res.json(await publicBootstrapPayload());
  res.json(await buildBootstrap(req.user));
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
      [newPledgeId(id), id, agency.id, agency.name, body.customers || "Lead request", req.user.id]
    );
    return loadDeparture(c, id);
  });

  emitDepartureSync(departure.id);
  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));

// Admin publishes a departure from a product (platform staff only).
app.post("/api/admin/departures", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  // A departure is instantiated by its first committed traveller — that is the
  // core of the model, and it applies to ops too. Admin date creation exists
  // for bookings that arrive by phone or WhatsApp, so it records that booking;
  // it must not mint empty inventory that sits on the itinerary pages as
  // fiction. (Decided 2026-08-08; the traveler-initiated addendum says the
  // same for the public flow.)
  const t = body.firstTraveler || {};
  const travelerName = String(t.name || "").trim();
  const travelerEmail = String(t.email || "").trim();
  const travelerPhone = String(t.phone || "").trim();
  const travelerSeats = Number(t.seats || 1);
  if (!travelerName) {
    throw new AppError(422, "A date is created by its first booking — record the traveller's name.");
  }
  if (!travelerEmail && !travelerPhone) {
    throw new AppError(422, "Record how to reach the first traveller — an email or a phone number.");
  }
  if (!Number.isInteger(travelerSeats) || travelerSeats < 1) {
    throw new AppError(422, "Seats must be a whole number of at least 1.");
  }
  const result = await withTransaction(async (c) => {
    const product = await loadProduct(c, body.tourProductId);
    if (!product) throw new AppError(404, "Tour product not found.");

    // This endpoint lets a departure override the listing's capacity, so the
    // contract limit has to be checked here too — not only on the listing.
    const depMinSeats = Number(body.minSeats || product.minSeats);
    const depMaxSeats = Number(body.maxSeats || product.maxSeats);
    const capacityProblem = capacityError(depMinSeats, depMaxSeats);
    if (capacityProblem) throw new AppError(422, capacityProblem);
    if (travelerSeats > depMaxSeats) {
      throw new AppError(422, `This date holds at most ${depMaxSeats} travellers.`);
    }

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
        depMinSeats, depMaxSeats,
        Number(body.baseCost || product.baseCost || 0), Number(body.publishedRate || product.publishedRate),
        Number(body.breakPrice || product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality, body.cutoff || "Open until 18:00", product.description,
        Number(product.depositPercent || defaultDepositFor(product)),
      ]
    );

    // The first booking, in the same transaction: the date and its traveller
    // exist together or not at all.
    const fresh = await loadDeparture(c, id);
    const pricing = computePledgePricing(fresh, product, {
      seats: travelerSeats, roomingType: t.roomingType, accommodationTier: t.accommodationTier,
    });
    const bookingCode = await uniqueBookingCode(c);
    await insertPledge(c, id, {
      id: newPledgeId(id),
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: travelerSeats,
      customers: travelerName,
      customerEmail: travelerEmail || null,
      customerPhone: travelerPhone || null,
      source: "admin",
      bookingCode,
      createdByUserId: req.user.id,
      ...pricing,
    });
    return { departure: await loadDeparture(c, id), bookingCode, pricing };
  });
  const departure = result.departure;
  emitDepartureSync(departure.id);
  await logAudit(req, {
    action: "departure.create_with_booking", entity: "departure", entityId: String(departure.id),
    detail: { tourProductId: body.tourProductId, date: departure.startDate || departure.date, seats: travelerSeats, source: "admin" },
  });
  if (travelerEmail) {
    sendEmail(bookingConfirmationEmail({
      to: travelerEmail, customerName: travelerName, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      seats: travelerSeats, depositDue: result.pricing.depositDue, balanceDue: result.pricing.balanceDue,
      balanceDueDate: result.pricing.balanceDueDate, bookingCode: result.bookingCode,
    })).catch(() => {});
  }
  res.status(201).json({ departure: presentDeparture(departure, req.user), bookingCode: result.bookingCode });
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
  // Operating weekdays (0=Sun … 6=Sat): dedupe, bound, and treat "all 7" as
  // unrestricted (null) so the traveler picker stays a free calendar.
  const opDays = Array.isArray(body.operatingDays)
    ? [...new Set(body.operatingDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : null;
  const operatingDays = opDays && opDays.length > 0 && opDays.length < 7 ? JSON.stringify(opDays) : null;

  // The contract limit, checked before anything is written. The DB carries the
  // same rule as a constraint; this exists to say why in words an operator can
  // act on rather than surfacing a constraint violation.
  const capacityProblem = capacityError(
    Number(body.minSeats || 4),
    Number(body.maxSeats || MAX_GROUP_SIZE)
  );
  if (capacityProblem) throw new AppError(422, capacityProblem);

  // Optional per-headcount pricing. Rejected loudly rather than silently
  // dropped: a table the operator believes is saved but isn't would quietly
  // sell every seat at the interpolated price instead.
  const tierCheck = validatePriceTiers(body.priceTiers, {
    minSeats: Number(body.minSeats || 4),
    maxSeats: Number(body.maxSeats || 12),
  });
  if (tierCheck.error) throw new AppError(422, tierCheck.error);
  const priceTiers = tierCheck.tiers ? JSON.stringify(tierCheck.tiers) : null;
  await c.query(
    `INSERT INTO tour_products
      (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
       min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
       description, included, not_included, itinerary, accommodation_tiers,
       overview_html, policies_html, what_to_bring, meeting_point, pickup_note, booking_cutoff_hours, images,
       meeting_points, status, agency_id, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason, operating_days, price_tiers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
     ON CONFLICT (id) DO UPDATE SET
       operating_days=EXCLUDED.operating_days, price_tiers=EXCLUDED.price_tiers,
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
      body.vehicle || (type === "package" ? "Private van + flights" : "Van, 12 seats"),
      Number(body.minSeats || 4), Number(body.maxSeats || 12),
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
      review.reviewedBy || null, reviewedAt, null, operatingDays, priceTiers,
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
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Agency pledge — identity (agency) comes from the token, never the body.
app.post("/api/departures/:id/pledges", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const input = parse(pledgeSchema, req.body);
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been cancelled.");
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
    if (seatsTotal(dep.pledges) + input.seats > dep.maxSeats) {
      throw new AppError(409, "This pledge exceeds capacity.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const agency = (await c.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
    const pricing = computePledgePricing(dep, product, input);

    await insertPledge(c, dep.id, {
      id: newPledgeId(dep.id),
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
  emitDepartureSync(departure.id);
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
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
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
    const pledgeId = newPledgeId(dep.id);
    const booking = {
      id: pledgeId,
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      source: "public",
      bookingCode: await uniqueBookingCode(c),
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
  emitDepartureSync(result.departure.id);
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
  emitDepartureSync(departure.id);
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
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Public: an operator applies to be verified and list (site/verify.html).
//
// Open like the public booking route, behind the same stricter write limiter.
// The row is written first and the two emails are sent afterwards, deliberately
// in that order: an application must survive an email outage, and email delivery
// runs in "log" mode until RESEND_API_KEY is set. The applicant gets a reference
// back so a lost email is still traceable.
app.post("/api/operator-applications", writeLimiter, h(async (req, res) => {
  const input = parse(operatorApplicationSchema, req.body);
  const reference = `OP-${randomBytes(3).toString("hex").toUpperCase()}`;
  await pool.query(
    `INSERT INTO operator_applications
       (reference, company, contact_name, city, email, phone, licence, regions, about)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [reference, input.company, input.contactName, input.city, input.email,
     input.phone || null, input.licence, input.regions || null, input.about || null]
  );
  await logAudit(req, {
    action: "operator_application.create", entity: "operator_application", entityId: reference,
    detail: { company: input.company, city: input.city },
  });
  const payload = { ...input, reference };
  sendEmail(operatorApplicationEmail({ to: BRAND.email, ...payload })).catch(() => {});
  sendEmail(operatorApplicationReceiptEmail({ to: input.email, ...payload })).catch(() => {});
  res.status(201).json({ reference, copy: operatorApplicationText(input) });
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
// Dates travelers must not start a departure on (operator blackouts, via the
// Autoura capacity feed). Public and cache-friendly: dates only, no reasons.
// Public: one product in full, for a page that arrived holding the sliced copy.
//
// sliceBootstrapForRoute strips itinerary, inclusions and the rest from every
// product except the route's own, so a client-side click from the catalogue to
// a tour renders DetailPending skeletons and swaps in the real content when the
// background refresh lands — a visible second version of the page. This lets
// that page fetch just the part it is missing instead of waiting on the whole
// 135KB catalogue.
//
// Served from the same memoised anonymous payload the page was built from, so
// it costs no query, cannot disagree with the inlined copy, and carries the
// same redaction. Never buildBootstrap(req.user) here — see renderPage.
app.get("/api/public/tour-products/:id", h(async (req, res) => {
  const payload = await publicBootstrapPayload();
  const product = (payload.tourProducts || []).find((p) => String(p.id) === String(req.params.id));
  if (!product) throw new AppError(404, "Tour not found.");
  // Matches the inlined payload's own freshness: detail fields are edited by
  // operators, not by bookings, so this does not carry live seat counts.
  res.set("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  res.json({ product });
}));

app.get("/api/public/unavailable-dates", h(async (_req, res) => {
  const blocked = await unavailableDates();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ dates: [...blocked].sort() });
}));

// ---- Traveler-initiated departure requests (addendum Phase A) --------------
// A traveler picks tour + date + contact; the departure lands as
// `pending_review` with the traveler's seed pledge attached. Admin approves it
// into `open` (or declines -> cancelled). No payment is taken in Phase A.
app.post("/api/public/departure-requests", writeLimiter, h(async (req, res) => {
  const input = parse(publicDepartureRequestSchema, req.body);

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const picked = new Date(`${input.date}T12:00:00`);
  if (isNaN(picked)) throw new AppError(422, "A valid date is required.");
  const daysOut = Math.round((picked - today) / 86400000);
  if (daysOut < REQUEST_MIN_LEAD_DAYS) {
    throw new AppError(422, `Requested dates need at least ${REQUEST_MIN_LEAD_DAYS} days of lead time.`);
  }
  if (daysOut > REQUEST_MAX_HORIZON_DAYS) {
    throw new AppError(422, `Requested dates can be at most ${REQUEST_MAX_HORIZON_DAYS} days out.`);
  }

  // Operator blackouts (Autoura capacity feed): the weekly pattern may allow
  // this weekday, but not THIS date if the operation is dark. Checked before
  // the transaction — it may involve an HTTP fetch (cached 10 min).
  const blocked = await unavailableDates();
  if (blocked.has(input.date)) {
    throw new AppError(422, "That day isn't available operationally — please pick another date.");
  }

  const result = await withTransaction(async (c) => {
    const product = await loadProduct(c, input.tourProductId);
    if (!product || product.active === false || product.status !== "approved") {
      throw new AppError(404, "Tour not found.");
    }

    // Operating days: a Nile cruise that sails Mondays must not accept a
    // Tuesday request, whatever the client sent.
    const opDays = Array.isArray(product.operatingDays) ? product.operatingDays : [];
    if (opDays.length > 0) {
      const dow = new Date(`${input.date}T12:00:00Z`).getUTCDay();
      if (!opDays.includes(dow)) {
        const DAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
        const list = opDays.map((d) => DAY[d]);
        const label = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
        throw new AppError(422, `${product.title} departs only on ${label} — pick one of those days.`);
      }
    }

    // Join-first rule: surface open departures for the same tour within the
    // match window. The client must explicitly reject them (ignoreMatches)
    // before a new departure is created — fragmenting demand kills pooling.
    if (!input.ignoreMatches) {
      const win = await c.query(
        `SELECT id FROM departures
         WHERE tour_product_id = $1 AND status = 'open'
           AND COALESCE(start_date, date) BETWEEN ($2::date - $3::int) AND ($2::date + $3::int)
         ORDER BY COALESCE(start_date, date) ASC`,
        [product.id, input.date, NEAR_MATCH_WINDOW_DAYS]
      );
      const matches = [];
      for (const row of win.rows) {
        const d = await loadDeparture(c, row.id);
        if (d && seatsTotal(d.pledges) < d.maxSeats) matches.push(presentDeparture(d, req.user));
      }
      if (matches.length > 0) {
        return { nearMatches: matches };
      }
    }

    const isPkg = product.type === "package";
    let endDate = null;
    if (isPkg && product.nights) {
      const e = new Date(`${input.date}T12:00:00`);
      e.setDate(e.getDate() + Number(product.nights));
      endDate = e.toISOString().slice(0, 10);
    }
    const id = (await c.query("SELECT nextval('departures_id_seq') AS id")).rows[0].id;
    await c.query(
      `INSERT INTO departures
        (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
         city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
         quality, cutoff, status, notes, deposit_percent, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending_review',$21,$22,'traveler')`,
      [
        id, product.type, product.id, product.title, input.date,
        isPkg ? input.date : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, product.defaultTime,
        product.city, product.guide, product.vehicle,
        Number(product.minSeats), Number(product.maxSeats),
        Number(product.baseCost || 0), Number(product.publishedRate),
        Number(product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality, "Open until 18:00",
        input.note ? `Traveller request: ${input.note}` : "Traveller-requested date awaiting review.",
        Number(product.depositPercent || defaultDepositFor(product)),
      ]
    );

    const dep = await loadDeparture(c, id);
    const pricing = computePledgePricing(dep, product, input);
    const pledgeId = newPledgeId(id);
    await insertPledge(c, id, {
      id: pledgeId,
      agencyId: "direct_customer",
      agency: "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone || null,
      source: "public_request",
      bookingCode: await uniqueBookingCode(c),
      refCode: null,
      ...pricing,
    });
    const departure = await loadDeparture(c, id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]) };
  });

  if (result.nearMatches) {
    // Not an error for the traveler — the UI offers these to join instead.
    return res.status(409).json({
      error: "Open departures already exist near this date.",
      code: "near_matches",
      nearMatches: result.nearMatches,
    });
  }

  await logAudit(req, {
    action: "departure_request.create", entity: "departure", entityId: String(result.departure.id),
    detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "public" },
  });
  const d = result.departure;
  sendEmail(departureRequestReceivedEmail({
    to: input.customerEmail, customerName: input.customerName, route: d.route,
    dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date,
    seats: input.seats, bookingCode: result.booking.bookingCode,
  })).catch(() => {});
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// Admin approves a traveler-requested departure into the open pool.
app.post("/api/admin/departure-requests/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    await c.query(`UPDATE departures SET status='open' WHERE id=$1`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.approve", entity: "departure", entityId: String(departure.id) });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  if (seed?.customerEmail) {
    sendEmail(departureRequestApprovedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      bookingCode: seed.bookingCode,
    })).catch(() => {});
  }
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Admin declines a traveler-requested departure (with an optional reason).
app.post("/api/admin/departure-requests/:id/decline", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    await c.query(`UPDATE departures SET status='cancelled' WHERE id=$1`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.decline", entity: "departure", entityId: String(departure.id), detail: { reason: reason || null } });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  if (seed?.customerEmail) {
    sendEmail(departureRequestDeclinedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      reason: reason || undefined,
    })).catch(() => {});
  }
  res.json({ departure: presentDeparture(departure, req.user) });
}));

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
  if (publicBlogCache.payload && Date.now() - publicBlogCache.at < PUBLIC_BLOG_TTL) {
    return res.json(publicBlogCache.payload);
  }
  const r = await pool.query("SELECT * FROM blog_posts WHERE status='published' ORDER BY published_at DESC NULLS LAST, updated_at DESC");
  const payload = { posts: r.rows.map(mapPost) };
  publicBlogCache = { at: Date.now(), payload };
  res.json(payload);
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
  // pending_review must not auto-advance from pledge counts — only an admin
  // approval moves it to 'open' (traveler-initiated departures, Phase A).
  if (["pending_review", "supplier_confirmed", "closed", "cancelled"].includes(row.status)) return;
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
    // status is needed to exclude cancelled bookings — without it these totals
    // counted cancelled seats as booked and cancelled bookings as revenue, and
    // seatsByDep (below) mis-drove readyToConfirm / atRisk. The Bookings tab
    // already excluded them, so Overview and Bookings disagreed on the same
    // figures. Same rule as domain.js seatsTotal().
    pool.query(`SELECT departure_id, seats, booking_total, deposit_due, source, created_at, status FROM pledges`),
    pool.query(`SELECT id, type, active, status FROM tour_products`),
    pool.query(`SELECT id FROM agencies WHERE status='active'`),
  ]);
  const pendingListings = products.rows.filter((p) => p.status === "pending").length;

  const livePledges = pledges.rows.filter((p) => p.status !== "cancelled");
  const seatsByDep = new Map();
  let totalSeats = 0, totalRevenue = 0, totalDeposits = 0;
  const bookingsCount = livePledges.length;
  const cancelledCount = pledges.rows.length - bookingsCount;
  const now = new Date();
  const weekAhead = new Date(now); weekAhead.setDate(now.getDate() + 7);
  let bookingsThisWeek = 0;
  for (const p of livePledges) {
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
      cancelledBookings: cancelledCount,
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
  // Return the true row count alongside the page. The dashboard was computing
  // its "Booking value" / "Seats booked" KPIs from whatever this returned and
  // labelling them as platform totals, so past the limit the headline figures
  // silently became "the most recent N" — and appeared to fall as older
  // bookings dropped out of the window.
  const totalRows = await pool.query(`SELECT COUNT(*)::int AS n FROM pledges`);
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
  res.json({ total: totalRows.rows[0].n, limit, bookings: r.rows.map((b) => ({
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
  emitDepartureSync(departure.id);
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
  // Canonicalize to clean, extensionless, SEO-friendly URLs: any /page.html
  // permanently redirects to /page. `index` -> /, and the two designed links
  // that have no page of their own map to real pages.
  // `trust` was renamed to `goahead-promise`; keep the old URL working.
  const htmlAlias = { index: "/", tour: "/itineraries", pricing: "/operators", trust: "/goahead-promise" };
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const m = req.path.match(/^\/([a-z0-9-]+)\.html$/i);
    if (!m) return next();
    const name = m[1].toLowerCase();
    return res.redirect(301, htmlAlias[name] || `/${name}`);
  });
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
        hit = { mtimeMs, html: injectStaticSchema(readFileSync(abs, "utf8"), req.path) };
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
  const target = `/${kind}/${tourSlug(r.rows[0])}`;
  // Never 301 a URL to itself. tourSlug can no longer return an id-shaped slug,
  // but a 301 loop is cached by the browser and survives the server-side fix —
  // so the cheap guard stays regardless of what the slug logic does later.
  if (target === req.path) return next();
  return res.redirect(301, target);
}));

// ============================ STATIC SPA (production) ============================
// Serve the built frontend from /dist. For HTML routes, inject a fully-formed
// <head> (title, meta, OpenGraph, JSON-LD) server-side so crawlers and AI
// engines read complete pages; the SPA still hydrates the body normally.
if (existsSync(distDir)) {
  const template = readFileSync(join(distDir, "index.html"), "utf8");
  // Rendered pages are cached briefly: crawlers (which never share browser
  // cache) hit tour/blog routes in bursts, and each render costs DB queries.
  const pageCache = new Map(); // path -> { at, status, html }
  const PAGE_TTL = PAGE_TTL_MS;
  // Past PAGE_TTL an entry stops being served as fresh, but it is still a
  // perfectly good page. Measured from the live site, a render that misses both
  // this cache and the CDN costs about four seconds against Postgres, and a
  // phone shows the PREVIOUS page for every one of them — the "another version,
  // then the permanent version" this exists to fix. So a stale entry is served
  // immediately and refreshed behind the request. Nothing is served stale that
  // a write has invalidated: cacheClearers empties the map outright.
  const PAGE_STALE_TTL = PAGE_STALE_TTL_MS;
  const inFlight = new Map(); // path -> Promise, so a burst rebuilds once
  cacheClearers.push(() => pageCache.clear());
  // Routes whose UI is driven by the public catalogue. The portal and the embed
  // widget either need viewer-scoped data or none at all, so they don't get the
  // payload — it would be dead weight on every dashboard load.
  const needsCatalogue = (p) => !/^\/(admin|agency|portal|embed)(\/|$)/.test(p);

  // Builds one path and stores it. Concurrent callers for the same path share
  // the one build: without this, a cold entry under any traffic at all lets
  // every request start its own four-second render.
  const buildPage = (path) => {
    const running = inFlight.get(path);
    if (running) return running;
    const job = renderToCache(path).finally(() => inFlight.delete(path));
    inFlight.set(path, job);
    return job;
  };

  const renderToCache = async (path) => {
      const t0 = Date.now();
      const { title, head, notFound } = await buildHead(path);
      // GEO: crawlers don't execute JS, so inject the route's real content
      // inside #root. React's createRoot().render() replaces it on mount.
      const tHead = Date.now();
      const body = notFound ? "" : await buildBody(path);
      const tBody = Date.now();
      // The SPA used to mount, discard the server-rendered body, and only THEN
      // fetch /api/bootstrap — so every visitor sat on a loading screen waiting
      // for data this process already had in hand. Inlining it means the first
      // render has the catalogue and there is no round-trip at all.
      //
      // INVARIANT: this must always be the ANONYMOUS payload. The page it lands
      // in is served to everyone and is shared-cacheable, so a viewer-scoped
      // build would leak one visitor's data to the next. publicBootstrapPayload
      // passes no user, so viewPledges() redacts customer and financial detail
      // and the agency directory comes back empty. Never swap in
      // buildBootstrap(req.user) here — the API is the place for that.
      // Sliced to the route: the cached full payload is built once and shared,
      // then narrowed per path. Slicing here rather than in the builder keeps
      // one cache entry for every route instead of one per URL.
      const full = !notFound && needsCatalogue(path)
        ? await publicBootstrapPayload().catch(() => null)
        : null;
      const tPayload = Date.now();
      const bootstrap = full ? sliceBootstrapForRoute(full, path) : null;
      const bootstrapTag = bootstrap
        ? `<script>window.__SAWA_BOOTSTRAP__=${inlineScriptJson(bootstrap)}</script>`
        : "";
      const html = template
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${title.replace(/</g, "&lt;")}</title>`)
        .replace("</head>", () => `${head}\n</head>`)
        .replace('<div id="root"></div>', () => `<div id="root">${body}</div>${bootstrapTag}`);
      // The page now carries live seat counts in its inlined payload, so it is
      // only cacheable in a shared cache for as long as those stay believable.
      // stale-while-revalidate lets the CDN serve instantly and refresh behind
      // the request, which is what makes a cold, uncached visit fast. Any
      // catalogue write clears pageCache through cacheClearers, so an edge copy
      // is the only thing that can lag, and only by s-maxage.
      // Pages without a payload (portal, embed) must never be shared-cached.
      const cacheControl = notFound
        ? "no-store"
        : bootstrap
          ? "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
          : "no-store";
      // Unknown routes still render the SPA's 404 screen, but with a real 404
      // status so crawlers and monitoring don't treat them as live pages.
      if (pageCache.size > 500) pageCache.clear();
      // Which of the three phases is slow is not guessable from the outside —
      // all a visitor sees is one long wait — so an uncached render says so.
      const timing = { head: tHead - t0, body: tBody - tHead, payload: tPayload - tBody, total: Date.now() - t0 };
      if (timing.total > 750) {
        console.warn(`[seo] slow render ${path} — ${timing.total}ms (head ${timing.head}, body ${timing.body}, payload ${timing.payload})`);
      }
      const entry = { at: Date.now(), status: notFound ? 404 : 200, html, cacheControl, timing };
      pageCache.set(path, entry);
      return entry;
  };

  const send = (res, entry, state) => {
    res.set("Cache-Control", entry.cacheControl);
    // Readable in devtools and by any monitor, so the four seconds is
    // attributable rather than folded into one opaque TTFB.
    res.set("Server-Timing", [
      `cache;desc=${state}`,
      `head;dur=${entry.timing.head}`,
      `body;dur=${entry.timing.body}`,
      `payload;dur=${entry.timing.payload}`,
    ].join(", "));
    return res.status(entry.status).type("html").send(entry.html);
  };

  const renderPage = async (req, res) => {
    try {
      const path = req.path;
      const hit = pageCache.get(path);
      const state = cacheState(hit, Date.now(), PAGE_TTL, PAGE_STALE_TTL);

      if (state === "fresh") return send(res, hit, "fresh");
      if (state === "stale") {
        // Serve now, rebuild behind. A rejected refresh must not become an
        // unhandled rejection — the stale copy has already gone out.
        buildPage(path).catch((e) => console.error("[seo] background refresh failed for", path, "-", e.message));
        return send(res, hit, "stale");
      }
      return send(res, await buildPage(path), "miss");
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
app.listen(port, "0.0.0.0", () => {
  console.log(`Sawa listening on :${port}`);
  // Started after the listener so a failure here can never stop the site from
  // coming up, and so the healthcheck passes before any job touches the DB.
  startJobScheduler();
  // The first visitor after a deploy would otherwise pay for the catalogue
  // query on the request path — the one case the page cache cannot cover,
  // because it starts empty. Warming it costs one query at boot; failing to
  // warm it is not an error, only a slower first page.
  publicBootstrapPayload()
    .then((p) => console.log(`[boot] catalogue warm — ${(p?.tourProducts || []).length} products`))
    .catch((e) => console.warn("[boot] catalogue warm-up skipped —", e.message));
});
