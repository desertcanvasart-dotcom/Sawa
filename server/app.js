import "dotenv/config";
import express from "express";
import { z } from "zod";
import { pool, withTransaction, withDepartureWrites } from "./db/index.js";
import { pendingGoAheads, alertPayload } from "./goahead-alert.js";
import { refreshStatus } from "./departure-status.js";
import { cleanRefCode } from "../shared/ref-code.js";
import { mapAgency, mapCity, mapProduct, mapDeparture, mapPledge } from "./db/mappers.js";
import {
  enrichDeparture,
  computePledgePricing,
  seatsTotal,
  goAheadSeatsFor,
  defaultDepositFor,
  bookingClosed,
  departureStarted,
  departureScopeSql,
  validatePriceTiers,
  capacityError,
  MAX_GROUP_SIZE,
  MIN_GROUP_SIZE,
  DEFAULT_GO_AHEAD,
  bookingLookupView,
  statusFor,
  departureActionBuckets,
} from "./domain.js";
import { attachUser, requireAuth, requireRole, isPlatform, isAgency, AuthError } from "./auth.js";
import { supabaseAdmin } from "./supabase.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logAudit } from "./audit.js";
import {
  sendEmail, sendEmailInBackground, emailMode,
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
  inlineScriptJson, sliceBootstrapForRoute, clearSeoCaches, catalogueRoutes,
} from "./seo.js";
import { emitDepartureSync, unavailableDates, syncDivergences } from "./autoura-sync.js";
import { effectReport, recordFailure } from "./effect-log.js";
import { watchdogReport, lastWatchRunAt } from "./watchdog.js";
// fireAndForget is not imported here on purpose: the only fire-and-forget in
// this file is email, and its wrapper lives in email.js next to the contract it
// depends on. A second place to write that expression is a second place for it
// to be written differently.
import { rethrowIfProgrammerError, surfaceProgrammerError } from "./errors.js";
import { tourSlug, tourPath } from "./slug.js";
import { blogSlug } from "../shared/blog-slug.js";
import { cancelDepartureAndPledges, reportNotifications, CANCEL_REASONS } from "./departure-cancel.js";

import { BRAND } from "./brand.js";
import { startJobScheduler, jobSchedulerEnabled, cancelJobDryRun, goAheadNotifyDryRun } from "./jobs/scheduler.js";
import { TOUR_TIMEZONE } from "./tz.js";
import { cleanHtml, cleanItinerary } from "./sanitize.js";
import { canonicalRedirect } from "./canonical.js";
import { injectStaticSchema } from "./static-seo.js";
import { cacheState, staleWhileRevalidate, PAGE_TTL_MS, PAGE_STALE_TTL_MS } from "./page-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
// Assigned only when /dist exists — there is nothing to keep warm without the
// built SPA. Started after the listener, alongside the job scheduler.
let startPageWarmer = null;

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

function parse(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(422, result.error.issues[0]?.message || "Invalid request.");
  }
  return result.data;
}

// ============================ ROUTES ============================

// X2 — the RESOLVED mode of every environment-gated behaviour.
//
// Eight variables change what this app does, at boot, with no code change, no
// migration and no record. One of them — RESEND_API_KEY — flipped the system
// from logging emails to delivering them on 6 Aug 2026, and docs/STATUS.md went
// on saying "log-mode" for three days because nothing observes the environment.
//
// This makes the running configuration observable, so a check can assert it
// instead of a document asserting it. Modes only, never values: no key
// material, no partial keys, and nothing that reveals more than the resolved
// state. "email: live" says mail is being delivered; it does not say by whom,
// from what address, or with what key.
//
// Deliberately unauthenticated, matching the healthcheck Railway already polls.
// The tradeoff is real — mode-only output is still reconnaissance, and it tells
// an attacker whether the rate limiter is keyed per visitor. It is published
// because the alternative demonstrated itself: the state nobody could see was
// the state that drifted. If that tradeoff is unwanted, gate `modes` behind
// requireAuth and have the smoke check authenticate; the shape does not change.
function resolvedModes() {
  const trustProxyRaw = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === "production" ? "1" : "false");
  return {
    email: process.env.RESEND_API_KEY ? "live" : "log",
    scheduler: jobSchedulerEnabled() ? "on" : "off",
    // Whether the scheduled cancel job would actually cancel and email, or only
    // log what it would do. The distinction matters more than "scheduler: on":
    // that says the job runs, this says whether it can reach a traveller.
    cancelJob: jobSchedulerEnabled() ? (cancelJobDryRun() ? "dry-run" : "live") : "off",
    // The booking confirmation promises this email in writing, so "is it
    // actually sending" is a question about a kept promise, not a switch.
    goAheadNotify: jobSchedulerEnabled() ? (goAheadNotifyDryRun() ? "dry-run" : "live") : "off",
    autoura: process.env.AUTOURA_SYNC_URL && process.env.AUTOURA_SYNC_SECRET ? "on" : "off",
    // TT2 — how many departure syncs exhausted their retries since boot. A
    // non-zero count means the external system disagrees with Sawa about that
    // many dates, and nothing is scheduled to correct it. "on" alone says the
    // mirror is configured; this says whether it is keeping up.
    autouraDiverged: syncDivergences().count,
    // ZZ2 — every line above answers "is this switched on". `autoura: on` was
    // true for the whole life of a mirror that had never transmitted, and it
    // was read as evidence that it had. This answers "has it ever worked":
    // lastSuccess, lastFailure, counts, and neverWorked — configured, tried,
    // and never once succeeded, which is the state that was invisible.
    effects: effectReport(),
    trustProxy: trustProxyRaw !== "false" && trustProxyRaw !== "0" ? "on" : "off",
    canonicalHost: process.env.CANONICAL_HOST ? "on" : "off",
    tourTimezone: TOUR_TIMEZONE,
    nodeEnv: process.env.NODE_ENV || "unset",
  };
}

// Liveness only, and deliberately nothing else. This is what Railway polls,
// so it is unauthenticated — and an unauthenticated caller has no business
// learning whether the rate limiter is keyed per visitor, whether an external
// mirror is running, or whether email is live. Each of those is useful to
// someone probing the system and to nobody else.
app.get("/api/health", h(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

// The resolved configuration, behind auth. The drift argument for publishing
// this needs VISIBILITY, not PUBLIC visibility: the smoke check reads it with
// credentials, and every property of that argument survives while the
// reconnaissance value does not.
app.get("/api/modes", requireAuth, h(async (_req, res) => {
  // TTT2.1 — the watcher's own heartbeat, beside the effects it reports on.
  // /api/modes already answers "has this ever worked" rather than "is this
  // switched on"; a monitor that has stopped running belongs in the same place,
  // because its silence is otherwise indistinguishable from a clean site.
  let watchdog;
  try {
    watchdog = watchdogReport(await lastWatchRunAt(pool));
  } catch (e) {
    rethrowIfProgrammerError(e);
    // Not "stale: false". Unable to say is a third state and must not collapse
    // into the good one — the same argument as no-auth-provider on revokeLogin.
    watchdog = { lastRun: null, ageHours: null, stale: null, unavailable: e.message };
  }
  res.json({ modes: { ...resolvedModes(), watchdog } });
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
// Past PUBLIC_BOOTSTRAP_TTL the payload stops being served as fresh, but it is
// still a perfectly good payload — and it is the single most expensive thing a
// cold render does (measured on the live site at 1774ms of a 3769ms render of a
// tour page). A hard TTL meant a site this quiet rebuilt it on the request path
// almost every time: 30 seconds without a visitor was enough to throw it away.
// So it now follows the same rule the rendered pages do — stale is served
// immediately and refreshed behind the request.
//
// Serving stale is safe on exactly the terms it is for the page cache: any
// write calls invalidatePublicBootstrap(), which empties the entry outright and
// reads as a miss. The stale window only ever covers a period where nothing
// changed.
const PUBLIC_BOOTSTRAP_STALE_TTL = 10 * 60_000;
const publicBootstrap = staleWhileRevalidate({
  ttl: PUBLIC_BOOTSTRAP_TTL,
  staleTtl: PUBLIC_BOOTSTRAP_STALE_TTL,
  build: () => buildBootstrap(undefined),
  onError: (e) => console.error("[bootstrap] background refresh failed —", e.message),
});
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
  publicBootstrap.invalidate();
  publicBlogCache = { at: 0, payload: null };
  for (const clear of cacheClearers) clear();
}

// The anonymous payload, memoised. Extracted so the server-rendered HTML can
// embed exactly the same object the SPA would otherwise fetch (see renderPage):
// one builder means the inlined data and the API can never disagree, which is
// the whole point — a visitor must not watch the numbers change after load.
function publicBootstrapPayload() {
  return publicBootstrap.get();
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

  // The two filters below used to run only in JS, after every departure and
  // every pledge the business had ever recorded had already been read out of
  // Postgres and mapped. The rows were then thrown away. Today both tables are
  // empty so it costs nothing; a year in, the public catalogue would have been
  // paying to load and discard a year of history on every rebuild.
  //
  // These mirror the JS filters below exactly — same two rules, same two
  // audiences — so nothing that reaches the payload changes. The JS filters
  // stay where they are: they remain the authority on what is included, and
  // this only stops the database sending rows that could never have survived
  // them. The rule itself lives in domain.js, beside departureStarted().
  const departureScope = departureScopeSql({ canSeeAll: !!canSeeAll, signedIn: !!user });

  // Pledges are only ever read here to attach to a departure in the same
  // payload, so any pledge outside that set is loaded and dropped. Scoped with
  // a subquery rather than by feeding the ids back in, so this still runs
  // alongside the departures query instead of waiting a round trip for it.
  const [agencies, cities, products, departures, pledges] = await Promise.all([
    pool.query("SELECT * FROM agencies ORDER BY id"),
    pool.query("SELECT * FROM cities ORDER BY id"),
    pool.query(productsSql),
    pool.query(`SELECT * FROM departures WHERE ${departureScope} ORDER BY id`),
    pool.query(
      `SELECT * FROM pledges
        WHERE departure_id IN (SELECT id FROM departures WHERE ${departureScope})
        ORDER BY created_at ASC, id ASC`
    ),
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
  await logAudit(req, {
    action: "departure.create", entity: "departure", entityId: String(departure.id),
    detail: { route, date: body.date, agencyId: req.user.agencyId, source: "agency" },
  });
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
    sendEmailInBackground(bookingConfirmationEmail({
      to: travelerEmail, customerName: travelerName, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      seats: travelerSeats, depositDue: result.pricing.depositDue, balanceDue: result.pricing.balanceDue,
      balanceDueDate: result.pricing.balanceDueDate, bookingCode: result.bookingCode,
      product: departure,
    }));
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
  // DIR-1 — the agency route audits `listing.submit`; this one writes a listing
  // straight to `approved` and audited nothing. The path with LESS review had
  // less record.
  await logAudit(req, {
    action: "listing.create", entity: "tour_product", entityId: product.id,
    detail: { title: product.title, status: "approved", platform: true },
  });
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
    sendEmailInBackground(listingApprovedEmail({ to: contact.email, fullName: contact.full_name, title: product.title }));
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
    sendEmailInBackground(listingRejectedEmail({ to: contact.email, fullName: contact.full_name, title: product.title, reason }));
  }
  res.json({ product, notified: !!contact?.email });
}));

// Admin updates pricing; cascades to that product's departures (platform staff only).
app.post("/api/admin/tour-products/:id/pricing", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  const result = await withDepartureWrites(async (c, touch) => {
    const product = await loadProduct(c, req.params.id);
    if (!product) throw new AppError(404, "Tour product not found.");
    const publishedRate = Number(body.publishedRate || product.publishedRate);
    const breakPrice = Number(body.breakPrice || product.breakPrice);
    if (!(publishedRate > 0) || !(breakPrice > 0)) throw new AppError(422, "Prices must be positive numbers.");
    if (breakPrice > publishedRate) throw new AppError(422, "Break price cannot be higher than the GoAhead price.");

    await c.query(`UPDATE tour_products SET published_rate=$1, break_price=$2 WHERE id=$3`, [publishedRate, breakPrice, product.id]);
    // TT1 — this reprices EVERY departure of the product, and the mirror's
    // payload carries priceFrom. It has never told Autoura about a price change.
    const repriced = await c.query(
      `UPDATE departures SET published_rate=$1, break_price=$2 WHERE tour_product_id=$3 RETURNING id`,
      [publishedRate, breakPrice, product.id]
    );
    for (const row of repriced.rows) touch(row.id);
    const updated = await loadProduct(c, product.id);
    const deps = await c.query(`SELECT id FROM departures WHERE tour_product_id=$1 ORDER BY id`, [product.id]);
    const departures = [];
    for (const row of deps.rows) departures.push(await loadDeparture(c, row.id));
    return {
      product: updated, departures, repriced: repriced.rows.length,
      was: { publishedRate: product.publishedRate, breakPrice: product.breakPrice },
    };
  });
  // DIR-1 — a price change, across every date of the product at once, with no
  // record of who made it or what it was before. The highest-value audit row in
  // this file after the access changes.
  await logAudit(req, {
    action: "product.pricing", entity: "tour_product", entityId: req.params.id,
    detail: {
      from: result.was,
      to: { publishedRate: result.product.publishedRate, breakPrice: result.product.breakPrice },
      departuresRepriced: result.repriced,
    },
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
  // MM1 — `status <> 'cancelled'` is the whole point of this line.
  //
  // Without it, a traveller who had cancelled their own booking was still on
  // the list, and was emailed about a date they were no longer on. Same defect
  // class as the booking page telling a cancelled traveller to meet the guide:
  // a message addressed to a named individual, stating something untrue about
  // their booking, which they may act on.
  //
  // The job's own recipient list (jobs/cancel-unconfirmed.js) already filtered
  // correctly. These two — the older code — did not.
  const recips = await pool.query(
    `SELECT DISTINCT customer_email FROM pledges
      WHERE departure_id=$1 AND customer_email IS NOT NULL AND status <> 'cancelled'`,
    [departure.id]
  );
  for (const row of recips.rows) {
    sendEmailInBackground(goAheadEmail({ to: row.customer_email, route: departure.route, dateLabel }));
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
    sendEmailInBackground(bookingConfirmationEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      depositDue: result.booking.depositDue, balanceDue: result.booking.balanceDue,
      balanceDueDate: result.booking.balanceDueDate, bookingCode: result.booking.bookingCode,
      product: d,
    }));
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
  // DIR-1 — a traveller removing their own seat is a status change that moves
  // a departure toward or away from its minimum. Unauthenticated, so logAudit
  // records the actor as "public"; the pledge id is the only handle there is.
  await logAudit(req, {
    action: "booking.cancel", entity: "pledge", entityId: req.params.pledgeId,
    detail: { departureId: departure.id, source: "public" },
  });
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
  sendEmailInBackground(operatorApplicationEmail({ to: BRAND.email, ...payload }));
  sendEmailInBackground(operatorApplicationReceiptEmail({ to: input.email, ...payload }));
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
            tp.title AS product_title, tp.id AS product_id, tp.type AS product_type, tp.city AS product_city
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

  // LL3.1 / LL3.2 — the whole answer comes from domain.js, so it can be tested
  // without a database. The date's own status is the first thing asked there.
  const view = bookingLookupView({
    departureStatus: b.dep_status,
    pledgeStatus: b.pledge_status,
    seatsBooked,
    goAhead,
  });

  const fmt = (s) => {
    if (!s) return "";
    const d = s instanceof Date ? s : new Date(`${s}T12:00:00`);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  };
  // A day tour has a start_date and no end_date, and this read
  // `start ? start + " – " + end : date`, so it rendered "Sat, Aug 29, 2026 – "
  // with a dangling dash for every single-day booking. Found while checking the
  // states above; it is the same response object, so it is corrected here.
  const startLabel = fmt(b.start_date) || fmt(b.date);
  const endLabel = fmt(b.end_date);
  const dateLabel = endLabel && endLabel !== startLabel ? `${startLabel} – ${endLabel}` : startLabel;

  // Where "other dates on this route" actually goes. The cancellation email
  // offers the whole board, which is the weakest version of the offer: someone
  // who wanted the pyramids at dawn is handed everything Sawa sells.
  const routePath = b.product_id
    ? tourPath({ id: b.product_id, title: b.product_title, type: b.product_type, city: b.product_city })
    : null;

  res.json({ booking: {
    code: b.booking_code,
    tourTitle: b.product_title || b.route,
    city: b.city || "",
    dateLabel,
    seats: Number(b.seats),
    seatsBooked,
    goAhead,
    routePath,
    ...view,
  } });
}));

// Public: a traveller releases their own seat, using the code from their email.
//
// WHY A SECOND CANCEL ROUTE, AND WHY THIS ONE IS THE ADVERTISED ONE
//
// `DELETE /api/public/departures/:id/bookings/:pledgeId` already existed, and
// nothing durable ever pointed at it. Its handle lived in a React `useState`,
// so the cancel button vanished on the first page refresh: in practice a
// traveller could cancel in the tab they booked in, for as long as they left it
// open, and never again. The confirmation email carried no link at all.
//
// That route cannot become the link, for two reasons:
//
//   1. The pledge id is `pl_<departureId>_<time36><6 hex>` — 24 bits of
//      randomness behind a guessable timestamp. Acceptable for a handle nobody
//      is given; thin for an unauthenticated destructive action about to be
//      mailed to every customer. The booking code is 8 characters from a
//      31-character alphabet, ~8.5e11 combinations, and is ALREADY the key for
//      the lookup route above and already in the traveller's inbox.
//   2. It DELETEs the row, so the code stops resolving and the lookup page
//      answers "no booking found" to someone who just cancelled. Marking the
//      pledge `cancelled` lands in `booking_cancelled`, a state domain.js
//      already computes and already has copy for: "This booking was cancelled.
//      Nothing was charged for it."
//
// Cancelled rather than deleted also keeps the seat release honest: every seat
// count in the system reads `status <> 'cancelled'`, so the seat is genuinely
// returned to the departure while the record survives for ops and audit.
//
// Idempotent by design. A traveller who clicks the link twice, or whose mail
// client prefetches it, gets the same 200 and the same state rather than a 404
// telling them something went wrong.
app.post("/api/public/bookings/:code/cancel", writeLimiter, h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");

  const result = await withTransaction(async (c) => {
    // The pledge and its departure are read under the departure's lock, because
    // whether this cancel is allowed depends on a seat count that another
    // booking may be changing in the same instant.
    const found = await c.query(
      `SELECT p.id, p.status AS pledge_status, p.departure_id
         FROM pledges p WHERE UPPER(p.booking_code) = UPPER($1) LIMIT 1`,
      [code]
    );
    if (!found.rows.length) throw new AppError(404, "Booking not found.");
    const pledge = found.rows[0];

    const dep = await loadDeparture(c, pledge.departure_id, { forUpdate: true });
    if (!dep) throw new AppError(404, "Booking not found.");

    const view = bookingLookupView({
      departureStatus: dep.status,
      pledgeStatus: pledge.pledge_status,
      seatsBooked: seatsTotal(dep.pledges),
      goAhead: goAheadSeatsFor(dep),
    });

    // Already cancelled, either by the traveller or with the whole date. Report
    // it as done rather than as an error — see the idempotency note above.
    if (view.state === "booking_cancelled" || view.state === "date_cancelled") {
      return { alreadyDone: true, departureId: dep.id };
    }
    if (!view.canCancel) {
      // Terms §13.2, and the wording matters: the default schedule is SAWA'S,
      // not the operator's. An Operating Partner's own schedule applies "only
      // if it was clearly disclosed before reservation". Saying "the operator's
      // policy" hands off a term Sawa sets, to a traveller who is already
      // unhappy and is about to go looking for it.
      throw new AppError(409,
        "This date has reached GoAhead, so our cancellation schedule applies — see section 13 of the Terms. "
        + "Email hello@sawa.tours with your booking code and we'll take it from there.");
    }

    await c.query(`UPDATE pledges SET status='cancelled' WHERE id=$1`, [pledge.id]);
    // The seat is released, so the departure may fall back below its minimum —
    // the same recomputation the pledge-id route does.
    await refreshStatus(c, dep.id);
    return { alreadyDone: false, pledgeId: pledge.id, departureId: dep.id };
  });

  if (!result.alreadyDone) {
    emitDepartureSync(result.departureId);
    // Unauthenticated, so the actor is "public" — the booking code is the only
    // thing that proved anything, and it is deliberately NOT logged in full.
    await logAudit(req, {
      action: "booking.cancel", entity: "pledge", entityId: result.pledgeId,
      detail: { departureId: result.departureId, source: "public", via: "booking_code" },
    });
  }
  res.json({ cancelled: true });
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
  sendEmailInBackground(departureRequestReceivedEmail({
    to: input.customerEmail, customerName: input.customerName, route: d.route,
    dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date,
    seats: input.seats, bookingCode: result.booking.bookingCode,
  }));
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
    sendEmailInBackground(departureRequestApprovedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      bookingCode: seed.bookingCode,
    }));
  }
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// DIR-20.3 — the payment-link queue.
//
// The email is the prompt; THIS is the record. An unread email is
// indistinguishable from no departure needing a link, and here that costs
// revenue directly — so the portal must be able to ask the question directly
// rather than trusting an inbox.
//
// Derived from audit_log, which 024 made append-only: a departure cannot be
// removed from this queue by anything except an alert actually being recorded
// against it.
app.get("/api/admin/goahead-queue", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const due = await pendingGoAheads();
  const items = [];
  for (const departure of due) {
    const pledges = (await pool.query(`SELECT * FROM pledges WHERE departure_id = $1`, [departure.id])).rows;
    const agency = (await pool.query(
      `SELECT a.* FROM agencies a JOIN tour_products p ON p.agency_id = a.id WHERE p.id = $1`,
      [departure.tour_product_id])).rows[0] || null;
    items.push({ ...alertPayload({ departure, pledges, agency, portalBase: process.env.APP_URL || "" }),
      confirmedAt: departure.confirmed_at });
  }
  res.json({ waiting: items.length, items });
}));

// Admin declines a traveler-requested departure (with an optional reason).
app.post("/api/admin/departure-requests/:id/decline", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 300);
  const departure = await withDepartureWrites(async (c, touch) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    await c.query(`UPDATE departures SET status='cancelled' WHERE id=$1`, [dep.id]);
    // TT1 — a declined request moves from pending_review, which is withheld, to
    // cancelled, which is mirrored. Without this the partner never learns the
    // date is off, and nothing else ever corrects it.
    touch(dep.id);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.decline", entity: "departure", entityId: String(departure.id), detail: { reason: reason || null } });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  if (seed?.customerEmail) {
    sendEmailInBackground(departureRequestDeclinedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      reason: reason || undefined,
    }));
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
  const id = b.id || `blog_${blogSlug(title).slice(0, 32)}_${Math.random().toString(36).slice(2, 8)}`;
  const slug = blogSlug(b.slug || title);
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
       customer_phone, ref_code, paid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      p.id, departureId, p.agencyId ?? null, p.agency ?? null, p.seats, p.customers ?? null,
      p.pricePerPerson ?? null, p.bookingTotal ?? null, p.depositPercent ?? null,
      p.depositDue ?? null, p.balanceDue ?? null, p.balanceDueDate ?? null,
      p.source ?? null, p.bookingCode ?? null, p.roomingType ?? null,
      p.accommodationTier ?? null, p.accommodationTierName ?? null, p.createdByUserId ?? null,
      p.customerEmail ?? null, p.customerPhone ?? null, p.refCode ?? null, p.paid === true,
    ]
  );
  await refreshStatus(c, departureId);
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
    //
    // AAA1.4 — and if the ROLLBACK fails, an auth user exists that no app_users
    // row will ever match. That person can sign in and the application cannot
    // say who they are. Discarding that failure left the orphan with no record
    // of its existence anywhere.
    //
    // `e` is still what propagates: the original cause is the useful one, and a
    // rollback's own error must not replace it. So this records rather than
    // rethrows — which is a console.error, a counter, and a line in /api/modes,
    // not silence.
    await supabaseAdmin.auth.admin.deleteUser(data.user.id).catch((err) => {
      recordFailure("authRollback", `orphaned auth user ${data.user.id}: ${err.message}`);
    });
    throw e;
  }
  return { id: data.user.id, tempPassword: password };
}

// AAA1.4 — disabling an account is two writes, and only one of them was
// allowed to fail out loud.
//
// `UPDATE app_users SET status='disabled'` and the Supabase ban are a pair. The
// ban's failure used to be discarded, so every admin screen would read
// `disabled` while the account could still sign in — a failure printing exactly
// what success prints, on the one path where that is a security question rather
// than an inconvenience.
//
// Returns what actually happened, and the caller reports it AND audits it.
//
// DIR-1.2 — this takes a direction now, because the door only opened one way.
//
// `status` accepts 'active' on both staff PATCH routes, so re-enabling somebody
// is an offered operation. Nothing lifted the ban, so that write succeeded,
// returned 200, showed `active` in every admin screen, and the person still
// could not sign in. A failure printing exactly what success prints — the same
// shape as the revoke gap, with the polarity reversed.
async function setLoginAccess(userId, allowed) {
  // Not "revoked"/"restored": in log mode there is no auth provider and so no
  // login to change. That is a third state, and collapsing it into either of
  // the other two is how "on" came to mean "working".
  if (!supabaseAdmin) return "no-auth-provider";
  try {
    await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: allowed ? "none" : "876000h" });
    return allowed ? "restored" : "revoked";
  } catch (e) {
    rethrowIfProgrammerError(e);
    recordFailure(
      "loginAccess",
      allowed
        ? `${userId} is active in app_users but still cannot sign in: ${e.message}`
        : `${userId} is disabled in app_users but can still sign in: ${e.message}`
    );
    return "failed";
  }
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
  sendEmailInBackground(inviteEmail({ to: input.email, fullName: input.fullName, agencyName, tempPassword: created.tempPassword, role: input.role }));
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

  // DIR-1.1 — this route SET status='disabled' AND NEVER TOUCHED THE LOGIN.
  //
  // The sweep found it; nobody was looking here. `DELETE .../staff/:id` revokes,
  // and the admin PATCH revokes, but an agency owner disabling a team member
  // through this route left their Supabase session working indefinitely, while
  // every screen in the product read `disabled`. That is the BBB1 defect in a
  // path BBB1 never named.
  const login = status && status !== target.status ? await setLoginAccess(target.id, status === "active") : undefined;

  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  // DIR-1 — actor, target, and OUTCOME. `login` is the part the audit trail
  // could not previously have answered: whether the access change took effect.
  await logAudit(req, {
    action: "staff.update", entity: "user", entityId: target.id,
    detail: {
      agencyId: req.user.agencyId,
      from: { role: target.role, status: target.status },
      to: { role: row.role, status: row.status },
      login: login ?? "unchanged",
    },
  });
  res.json({ staff: mapStaff(row), ...(login ? { login } : {}) });
}));

app.delete("/api/agency/staff/:id", requireAuth, requireRole("agency_owner"), h(async (req, res) => {
  const target = await loadAgencyStaff(req.params.id, req.user.agencyId);
  if (req.params.id === req.user.id) throw new AppError(409, "You cannot remove your own account.");
  // Deactivate (keeps history + bookings intact) and revoke the login.
  await pool.query(`UPDATE app_users SET status='disabled' WHERE id=$1`, [target.id]);
  const login = await setLoginAccess(target.id, false);
  await logAudit(req, {
    action: "staff.disable", entity: "user", entityId: target.id,
    detail: { agencyId: req.user.agencyId, email: target.email, role: target.role, login },
  });
  res.json({ ok: true, login });
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
  sendEmailInBackground(inviteEmail({ to: input.email, fullName: input.fullName, agencyName: "Sawa Operations", tempPassword: created.tempPassword, role: input.role }));
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
  // DIR-1.2 — 'active' was a one-way door here too: it wrote the row and left
  // the ban in place, so re-enabling a platform admin silently did nothing.
  const login = status && status !== target.status ? await setLoginAccess(target.id, status === "active") : undefined;
  const row = (await pool.query(`SELECT id,email,full_name,role,status,created_at FROM app_users WHERE id=$1`, [target.id])).rows[0];
  await logAudit(req, {
    action: "staff.update", entity: "user", entityId: target.id,
    detail: {
      platform: true,
      from: { role: target.role, status: target.status },
      to: { role: row.role, status: row.status },
      login: login ?? "unchanged",
    },
  });
  res.json({ staff: mapStaff(row), ...(login ? { login } : {}) });
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
    //
    // AAA1.4 — same argument as the auth rollback above: record the failed undo
    // and still throw the original cause. An ownerless agency row nobody knows
    // about is the thing worth a line in the log.
    await pool.query(`DELETE FROM agencies WHERE id=$1`, [agencyId]).catch((err) => {
      recordFailure("agencyRollback", `ownerless agency ${agencyId}: ${err.message}`);
    });
    throw e;
  }

  const agencyRow = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [agencyId])).rows[0];
  await logAudit(req, { action: "agency.create", entity: "agency", entityId: agencyId, detail: { name: input.name, ownerEmail: input.ownerEmail } });
  sendEmailInBackground(inviteEmail({ to: input.ownerEmail, fullName: input.ownerName, agencyName: input.name, tempPassword: owner.tempPassword, role: "agency_owner" }));
  res.status(201).json({ agency: mapAgency(agencyRow), ownerEmail: input.ownerEmail, tempPassword: owner.tempPassword, emailMode });
}));

// Admin: delete an agency — its own logins go with it; history blocks it.
//
// Two different kinds of dependent, treated differently on purpose:
//
// - **Team logins.** app_users.agency_id is ON DELETE CASCADE (002), so a bare
//   DELETE would erase the profiles while the Supabase logins kept working — a
//   ghost login, the exact BBB1 shape. And there is no admin route for another
//   agency's staff, so "remove them first" was a dead end from this dashboard.
//   The delete therefore revokes each login itself (same ban as staff.disable)
//   BEFORE the row goes; if any revocation fails, nothing is deleted.
//
// - **History** — tour products, bookings, and any referral code with a
//   booking attributed to it. Those carry agency_id (or ref_code) with no FK;
//   deleting would leave dangling ids nothing can resolve. Still refused.
//   Delete is "undo a mistaken creation", not a shredder for records.
//
// - **Scaffolding** — the referral code every agency gets at creation. With
//   zero bookings attributed it is furniture, not history (blocking on it made
//   every agency undeletable, discovered on second use), so an unused code is
//   deleted with its agency and listed in the audit detail. One booking
//   carrying the code moves it to the history column above.
app.delete("/api/admin/agencies/:id", requireAuth, requireAdmin(), h(async (req, res) => {
  const id = req.params.id;
  const agency = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [id])).rows[0];
  if (!agency) throw new AppError(404, "Agency not found.");

  const [products, pledges, usedRefs] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int n FROM tour_products WHERE agency_id=$1`, [id]),
    pool.query(`SELECT COUNT(*)::int n FROM pledges WHERE agency_id=$1`, [id]),
    pool.query(
      `SELECT COUNT(*)::int n FROM referrals r
        WHERE r.agency_id=$1 AND EXISTS (SELECT 1 FROM pledges p WHERE p.ref_code = r.code)`,
      [id]
    ),
  ]);
  const blockers = [
    products.rows[0].n && `${products.rows[0].n} tour product(s) linked to it`,
    pledges.rows[0].n && `${pledges.rows[0].n} booking(s) recorded under it`,
    usedRefs.rows[0].n && `${usedRefs.rows[0].n} referral code(s) with bookings attributed`,
  ].filter(Boolean);
  if (blockers.length) {
    throw new AppError(409, `Cannot delete "${agency.name}": ${blockers.join("; ")}.`);
  }

  // Revoke every login before anything is deleted. "failed" aborts the whole
  // delete: a cascade that outruns a failed ban is exactly the ghost this
  // route exists to prevent. "no-auth-provider" (log mode) has no login to
  // outlive anything and proceeds.
  const staff = (await pool.query(`SELECT id, email, role FROM app_users WHERE agency_id=$1`, [id])).rows;
  const revoked = [];
  for (const member of staff) {
    const login = await setLoginAccess(member.id, false);
    if (login === "failed") {
      throw new AppError(502, `Could not revoke the login for ${member.email}; "${agency.name}" was not deleted. Retry once the auth provider responds.`);
    }
    revoked.push({ email: member.email, role: member.role, login });
  }

  // The unused codes and the agency row go in one transaction — a delete that
  // removed the codes and then failed on the agency would leave scaffolding
  // gone from under a row that still exists.
  const codesDeleted = await withTransaction(async (c) => {
    const codes = (await c.query(
      `DELETE FROM referrals r
        WHERE r.agency_id=$1 AND NOT EXISTS (SELECT 1 FROM pledges p WHERE p.ref_code = r.code)
        RETURNING r.code`,
      [id]
    )).rows.map((r) => r.code);
    await c.query(`DELETE FROM agencies WHERE id=$1`, [id]);
    return codes;
  });
  await logAudit(req, {
    action: "agency.delete", entity: "agency", entityId: id,
    detail: {
      name: agency.name, status: agency.status, relationship: agency.relationship ?? null,
      loginsRevoked: revoked, referralCodesDeleted: codesDeleted,
    },
  });
  res.json({ ok: true, loginsRevoked: revoked.length, referralCodesDeleted: codesDeleted.length });
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

  // PP3 — the bucketing lives in domain.js so it can be tested; see the note
  // there for what it used to count.
  const { open, readyToConfirm, confirmed, atRisk } =
    departureActionBuckets(deps.rows, (id) => seatsByDep.get(id) || 0, now.getTime());

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
  await withDepartureWrites(async (c, touch) => {
    const r = await c.query(`UPDATE pledges SET status=$1 WHERE id=$2 RETURNING departure_id`, [status, req.params.id]);
    if (!r.rows.length) throw new AppError(404, "Booking not found.");
    await refreshStatus(c, r.rows[0].departure_id);
    // TT1 — both seatsTaken and the departure's own status can move here.
    touch(r.rows[0].departure_id);
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
  // PP5 / PP2.2 — the same helper the job uses. The date and its pledges change
  // together, and the recipient list is read BEFORE either.
  //
  // This route is where the PP2 failure would actually have bitten: it read
  // recipients AFTER the transaction, filtered on `status <> 'cancelled'`. Add
  // the pledge transition without moving that read and the list is empty every
  // time — nobody is told, and there is no scheduler log to notice it in.
  const { departure, recipients, pledgesCancelled } = await withDepartureWrites(async (c, touch) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    const result = await cancelDepartureAndPledges(c, dep.id);
    // TT1 — through the same boundary as the job, so the mirror learns about a
    // cancellation whichever path performed it.
    touch(dep.id);
    return { departure: await loadDeparture(c, dep.id), ...result };
  });
  await logAudit(req, {
    action: "departure.cancel", entity: "departure", entityId: departure.id,
    detail: {
      route: departure.route,
      cancelledReason: CANCEL_REASONS.DATE_CANCELLED,
      pledgesCancelled,
      notifying: recipients.length,
    },
  });
  const dateLabel = departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date;

  // PP2.1 — a human did this and will not read a cron log, so the shortfall has
  // to be visible where they are. It is reported in the response as well as
  // logged: "cancelled, nobody notified" must never look like "cancelled".
  let reached = 0;
  for (const to of recipients) {
    // AAA2 — this handler substitutes a value and says why, which the ban on
    // empty handlers permits. It is still wrong for one class: a broken
    // template would be counted as a traveller not reached, and PP2.1's
    // "cancelled, nobody notified" would send an operator chasing a mail
    // outage that is not happening.
    const sent = await sendEmail(cancellationEmail({ to, route: departure.route, dateLabel }))
      .catch((e) => { rethrowIfProgrammerError(e); return { ok: false }; });
    if (sent?.ok) reached += 1;
  }
  const notificationsClean = reportNotifications({
    intended: recipients.length, sent: reached,
    context: `departure ${departure.id} cancelled`,
  });

  res.json({
    departure: presentDeparture(departure, req.user),
    pledgesCancelled,
    notified: reached,
    notificationsIntended: recipients.length,
    // The caller is told plainly rather than left to compare two numbers.
    notificationWarning: notificationsClean ? null
      : `${recipients.length - reached} traveller(s) on this departure were not reached. They have not been told it is cancelled.`,
  });
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

  // The routes worth never letting go cold. Everything else is rebuilt on
  // demand; these are the two the public site actually lands on.
  const HOT_PATHS = ["/itineraries", "/blog"];

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
      // The three phases are independent — buildHead and buildBody each resolve
      // the route themselves, and the payload is the same anonymous object on
      // every page — but they used to run strictly one after another, so a cold
      // render paid the sum of all three. Measured on the live site, a cold tour
      // page was head 1809ms + body 186ms + payload 1774ms = 3769ms; started
      // together it costs the slowest one instead.
      //
      // They start before notFound is known, and that costs nothing: buildBody
      // returns "" for a route it doesn't recognise without touching the
      // database, and the payload is memoised and shared with every other page,
      // so the worst a 404 can do is warm a cache the next real request wanted.
      // Both results are discarded below if the route turns out not to exist.
      let tHead = t0, tBody = t0, tPayload = t0;
      const headJob = buildHead(path).then((r) => { tHead = Date.now(); return r; });
      // GEO: crawlers don't execute JS, so inject the route's real content
      // inside #root. React's createRoot().render() replaces it on mount.
      // A body that fails is not worth losing the page over — the head, the
      // schema and the inlined payload are all still good.
      const bodyJob = buildBody(path)
        .then((r) => { tBody = Date.now(); return r; })
        .catch((e) => { console.error("[seo] body render failed for", path, "-", e.message); return ""; });
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
      const payloadJob = needsCatalogue(path)
        ? publicBootstrapPayload().then((r) => { tPayload = Date.now(); return r; }).catch(() => null)
        : Promise.resolve(null);

      const [{ title, head, notFound }, renderedBody, builtPayload] =
        await Promise.all([headJob, bodyJob, payloadJob]);
      const body = notFound ? "" : renderedBody;
      const full = notFound ? null : builtPayload;
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
      // Each is now measured from the start of the render rather than from the
      // end of the phase before it: they overlap, so these are "finished at",
      // and the total is the slowest rather than the sum. A phase that never
      // ran (the payload, on a portal route) reads as 0.
      const since = (t) => (t === t0 ? 0 : t - t0);
      const timing = { head: since(tHead), body: since(tBody), payload: since(tPayload), total: Date.now() - t0 };
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
  // Every cache in this process is short-lived by design, and this site is
  // quiet. Those two facts together were the whole problem: PAGE_STALE_TTL is
  // five minutes, the payload's stale window is ten, and a marketing site can
  // easily go longer than that between visitors. So the caches were nearly
  // always empty when someone finally arrived, and the person who arrived paid
  // for filling them — a measured 3.8 seconds on the live site, over and over,
  // for what is a fourteen-product catalogue that barely changes.
  //
  // Keeping the hot paths warm moves that cost off the request path entirely.
  // It is a handful of queries a minute against a catalogue this size, and it
  // is the difference between "the first visitor after a quiet spell waits four
  // seconds" and "nobody waits".
  //
  // A tick that overlaps a rebuild is harmless: buildPage dedupes by path.
  startPageWarmer = () => {
    // PAGE_WARM_INTERVAL_MS=0 turns it off — the pages still render on demand,
    // they just go cold between visitors again.
    const everyMs = Number(process.env.PAGE_WARM_INTERVAL_MS ?? 45_000);
    if (!(everyMs > 0)) {
      console.log("[warm] page warmer off (PAGE_WARM_INTERVAL_MS=0)");
      return () => {};
    }
    // The catalogue is small and curated, so every product page is warmed too —
    // a cold tour page was measured at 1.15s on the live site, and it is the
    // page a visitor lands on from search. The cap is a backstop against a
    // catalogue that grows past what a background sweep should be doing; it
    // says so out loud rather than quietly warming a prefix, because a silent
    // truncation here reads as "every page is fast" when it is not.
    const limit = Number(process.env.PAGE_WARM_LIMIT || 60);
    let announcedCap = false;

    const routes = async () => {
      const detail = await catalogueRoutes().catch((e) => {
        console.warn("[warm] could not list catalogue routes —", e.message);
        return [];
      });
      const all = [...HOT_PATHS, ...detail];
      if (all.length > limit && !announcedCap) {
        announcedCap = true;
        console.warn(`[warm] ${all.length} routes exceeds PAGE_WARM_LIMIT=${limit}; warming the first ${limit}, the rest render on demand`);
      }
      return all.slice(0, limit);
    };

    // A sweep runs the pages ONE AT A TIME. Sixteen concurrent renders every
    // 45 seconds would each take a connection from a pool of ten and compete
    // with real visitors for it; done in sequence the sweep is invisible and
    // still finishes in a fraction of the interval.
    //
    // Already-fresh pages are skipped, so a sweep only pays for what has aged
    // out. Stale ones are rebuilt here rather than being left for a visitor to
    // trigger — a stale page is served instantly either way, but refreshing it
    // on our own time keeps the background work off the request path entirely.
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;  // a slow sweep must not stack up behind the timer
      sweeping = true;
      try {
        for (const path of await routes()) {
          if (cacheState(pageCache.get(path), Date.now(), PAGE_TTL, PAGE_STALE_TTL) === "fresh") continue;
          await buildPage(path).catch((e) => {
            // AAA2 — a page that cannot be built because the code is wrong is
            // not a slow page, and warming it again in 45 seconds will not help.
            //
            // CCC2.2 — but it is surfaced, not fatal. This is a CACHE WARM on a
            // timer. Rethrowing here made a broken template in one page kill the
            // web server for every page, to protect an optimisation. Nothing
            // awaits this, so a throw would have become an unhandled rejection
            // with no handler anywhere above it.
            if (!surfaceProgrammerError("pageWarm", e)) {
              console.warn("[warm] failed for", path, "-", e.message);
            }
          });
        }
      } finally {
        sweeping = false;
      }
    };

    const run = () => {
      sweep().catch((e) => {
        // CCC2.2 — same reasoning. Nothing awaits a setInterval callback.
        if (!surfaceProgrammerError("pageWarm", e)) {
          console.warn("[warm] sweep failed —", e.message);
        }
      });
    };
    run();
    const timer = setInterval(run, everyMs);
    // unref so the timer never holds the process open during a shutdown.
    timer.unref();
    console.log(`[warm] keeping the catalogue and ${HOT_PATHS.join(", ")} warm every ${Math.round(everyMs / 1000)}s`);
    return () => clearInterval(timer);
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
    .then((p) => {
      console.log(`[boot] catalogue warm — ${(p?.tourProducts || []).length} products`);
      // Only once the payload is in hand: the hot-path renders each need it,
      // and starting them first would have every one of them build its own.
      startPageWarmer?.();
    })
    .catch((e) => {
      // CCC2.2 — surfaced. This runs after app.listen(): the server is already
      // accepting requests, and a failed catalogue warm-up means slower first
      // responses, not wrong ones.
      if (!surfaceProgrammerError("pageWarm", e)) {
        console.warn("[boot] catalogue warm-up skipped —", e.message);
      }
    });
});
