import "dotenv/config";
import express from "express";
import { z } from "zod";
import { pool } from "./db/index.js";
import { refreshStatus } from "./departure-status.js";
import { publicOperator, operatorForDeparture, directOperatorId } from "./domain.js";
import { cspHeader, cspHeaderName, describeViolation, firstSighting } from "./csp.js";
import { phoneVerificationEnabled } from "./phone-verify.js";
import { mapAgency, mapCity, mapProduct, mapDeparture } from "./db/mappers.js";
import { enrichDeparture, departureStarted, departureScopeSql } from "./domain.js";
import { attachUser, requireAuth, requireRole, isPlatform, isAgency } from "./auth.js";
import { requestTiming } from "./request-timing.js";
import { supabaseAdmin, clearAuthCache } from "./supabase.js";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { logAudit } from "./audit.js";
import { registerCatalogueRoutes } from "./catalogue-routes.js";
import { registerOperatorRoutes } from "./operator-routes.js";
import { registerFinanceRoutes } from "./finance-routes.js";
import { onTravellerRateChange } from "./fx.js";
import { assertRateCardBookable } from "./rates.js";
import { catalogueContextFor, assertBookingComplete } from "./booking-details.js";
import { recordTermsVersion } from "./terms-versions.js";
import { requestPayment, departureFor, seatsHeldForWaitlist } from "./pay-at-goahead.js";
import { registerPayAtGoAheadRoutes } from "./pay-at-goahead-routes.js";
import { SAFETY_NONE } from "../shared/settlement-rules.js";
import { heldCodeTaken } from "./booking-confirmation.js";
import { verifyTurnstile, turnstileSiteKey } from "./turnstile.js";
import { catalogueV2Enabled } from "./features.js";
import { publicCatalogue, overlayBootstrap, clearPublicCatalogue } from "./catalogue-public.js";
import {
  sendEmail,
  sendEmailInBackground,
  opsRecipient,
  reviewRequestEmail,
  opsNewReviewEmail,
} from "./email.js";
import { registerReviewRoutes } from "./reviews.js";
import { registerContactRoutes } from "./contact-form.js";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHead,
  buildBody,
  dataScript,
  sliceBootstrapForRoute,
  clearSeoCaches,
  catalogueRoutes,
} from "./seo.js";
import { syncDivergences } from "./autoura-sync.js";
import { effectReport, recordFailure } from "./effect-log.js";
import { watchdogReport, lastWatchRunAt } from "./watchdog.js";
// fireAndForget is not imported here on purpose: the only fire-and-forget in
// this file is email, and its wrapper lives in email.js next to the contract it
// depends on. A second place to write that expression is a second place for it
// to be written differently.
import { rethrowIfProgrammerError, surfaceProgrammerError } from "./errors.js";
import { provideRouteContext } from "./route-context.js";
import { imageVariants } from "./image-variants.js";
import { normalizeWebsite } from "../shared/partner-page.js";

import { DIRECT_BOOKINGS_OPERATOR } from "./brand.js";
import { loadOperatorInputs, withDepositTimes } from "./operator-lookup.js";
import { startJobScheduler, jobSchedulerEnabled, cancelJobDryRun, goAheadNotifyDryRun, goAheadAlertDryRun } from "./jobs/scheduler.js";
import { TOUR_TIMEZONE } from "./tz.js";
import { canonicalRedirect } from "./canonical.js";
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
// S06 — the Content Security Policy (server/csp.js), report-only until
// CSP_ENFORCE=true. Pages only: API responses are JSON and are never rendered
// as a document. Set after the /embed rule above, so an ENFORCED policy
// carries the embed's frame-ancestors * rather than dropping it.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) {
    res.setHeader(cspHeaderName(), cspHeader(req.path));
    res.setHeader("Reporting-Endpoints", 'csp="/api/csp-report"');
  }
  next();
});

// Where browsers send what the policy would block. Logged once per distinct
// violation per process (see firstSighting) — that log is how the policy is
// tuned before it is enforced. Always 204: a report is never an error the
// browser can do anything about.
app.post("/api/csp-report",
  express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "64kb" }),
  (req, res) => {
    for (const v of describeViolation(req.body)) {
      if (firstSighting(v)) console.warn(`[csp] ${v.directive} blocked ${v.blocked} on ${v.page}`);
    }
    res.status(204).end();
  });

// Where each API request's time goes: a Server-Timing header, and a log line
// for a slow one (server/request-timing.js).
app.use(requestTiming());
// The JSON body parser is registered further down, after the rate limiter and
// attachUser — see "Body parsing" below.

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
// Uploads (tour images, cost receipts): generous, but not unlimited.
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
const generalLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
// At most 5 booking attempts an hour from one address (a booking or a date
// request, made or refused), with a message a real traveler can act on.
// BOOKING_RATE_LIMIT_PER_HOUR overrides it; the test suite's servers
// (NODE_ENV=test) default to a high ceiling so suites that book many times
// keep working, and the tests of this limit set it.
const BOOKING_ATTEMPTS_PER_HOUR = Number(process.env.BOOKING_RATE_LIMIT_PER_HOUR) || (process.env.NODE_ENV === "test" ? 1000 : 5);
const bookingAttemptLimiter = rateLimit({
  windowMs: 3_600_000, max: BOOKING_ATTEMPTS_PER_HOUR, standardHeaders: true, legacyHeaders: false,
  message: { error: "You've made several booking attempts in the last hour. Please wait a little and try again, or email hello@sawa.tours and we'll book it for you." },
});

// Cloudflare Turnstile on the public booking forms, checked here. Skipped
// with a warning when TURNSTILE_SECRET_KEY isn't set (server/turnstile.js).
async function requireTurnstile(req) {
  const r = await verifyTurnstile({ token: req.body?.turnstileToken, ip: req.ip });
  if (!r.ok) throw new AppError(403, "We couldn't check that this booking came from a person. Please reload the page and try again.");
}
app.use("/api/", generalLimiter);

// Attach req.user from the Supabase JWT (if present) on every request.
app.use(attachUser);

// --- Body parsing: after the limiter, and sized by who is asking ---
// Review of 12 Nov 2026: this parser used to run first, at 12mb, on every
// route. An anonymous client could make the server buffer and parse 12mb of
// JSON on any endpoint, and that work was done before the limiter had counted
// the request. Now the limiter refuses first, and only a caller who could be
// uploading gets the large limit: a signed-in user (tour images, receipts and
// operator documents are base64 data URLs, ~9mb raw) and the one public upload,
// a review photo behind its emailed token. Everyone else sends forms; 1mb is
// generous for those.
const uploadJson = express.json({ limit: "12mb" });
const formJson = express.json({ limit: "1mb" });
const PUBLIC_UPLOAD_PATH = /^\/api\/public\/reviews\/[^/]+\/uploads\/?$/;
const jsonParserFor = (req) => (req.user || PUBLIC_UPLOAD_PATH.test(req.path) ? uploadJson : formJson);
app.use((req, res, next) => jsonParserFor(req)(req, res, next));

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
// The request's query string, "?" included, or "" — for redirects that move
// the path and must not drop what the link carried.
const queryOf = (req) => { const i = req.originalUrl.indexOf("?"); return i === -1 ? "" : req.originalUrl.slice(i); };
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Tenant-aware pledge visibility ----------------------------------------
// Platform staff see everything. An agency sees full detail only on its own
// pledges; other agencies' customer/financial details are redacted. Anonymous
// visitors see no pledge details (only seat counts, which come from the
// aggregate the frontend computes). This keeps customer data isolated.
function viewPledges(pledges, user) {
  if (isPlatform(user)) return pledges;
  // S02/S03 — an anonymous visitor gets what the public pages count and nothing
  // else. The pledge id was the whole credential of the old public cancel
  // route; the agency id and timestamp were never theirs to see either.
  if (!user) return pledges.map((p) => ({ seats: p.seats, status: p.status }));
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

// S03 — fields that are Sawa's business, not the viewer's. The public catalogue
// used to carry them all: internal cost, staff notes on every date, and the
// review trail (why a listing was rejected, and when). Hiding them in the page
// did nothing; they were in the JSON and in the HTML the server inlines.
const STAFF_ONLY_PRODUCT_FIELDS = ["baseCost", "submittedAt", "reviewedAt", "rejectionReason"];
const STAFF_ONLY_DEPARTURE_FIELDS = ["baseCost", "operatorAgencyOverride", "mergedIntoId"];
// Ops notes on a date reach signed-in agencies (their tour preview falls back
// to them) but never an anonymous visitor.
const SIGNED_IN_DEPARTURE_FIELDS = ["notes"];

const omit = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

export function presentProduct(product, user) {
  if (isPlatform(user)) return product;
  // An operator sees its own listing's review trail — that is how it learns why
  // a listing was sent back.
  if (user && isAgency(user) && product.agencyId && product.agencyId === user.agencyId) return product;
  return omit(product, STAFF_ONLY_PRODUCT_FIELDS);
}

export function presentDeparture(enriched, user) {
  const keys = isPlatform(user) ? [] : user ? STAFF_ONLY_DEPARTURE_FIELDS
    : [...STAFF_ONLY_DEPARTURE_FIELDS, ...SIGNED_IN_DEPARTURE_FIELDS];
  return { ...omit(enriched, keys), pledges: viewPledges(enriched.pledges, user) };
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
    // A booking held for email confirmation (058) keeps its code when made.
    if (!hit.rowCount && !(await heldCodeTaken(c, code))) return code;
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
  // S04 — required here, not just in the form: a scripted post skipped it, and
  // a seat nobody can be reached about still counts toward GoAhead.
  customerEmail: z.string().trim().email("A valid email is required."),
  customerPhone: z.string().trim().max(40).optional(),
  // The token from POST /api/public/phone-verifications/check (S04).
  phoneToken: z.string().trim().max(400).optional(),
  seats: z.coerce.number().int().min(1),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
  refCode: z.string().trim().max(60).optional(),
  // The page the partner's widget sits on (070). Checked against the website
  // the partner registered before it is kept or linked to — partner.js.
  pageUrl: z.string().trim().max(600).optional(),
  // Group bookings (catalogue_v2): the "Join my group" link the booking came
  // through. Ignored with the flag off.
  partyToken: z.string().trim().max(80).optional(),
  // Cloudflare Turnstile's token from the form (checked on the server).
  turnstileToken: z.string().trim().max(2048).optional(),
  // Reservation integrity (catalogue_v2): what the browser reports about
  // itself, hashed with the user agent and never stored raw.
  deviceHint: z.string().trim().max(400).optional(),
});

// Model phase 2 — what the operator's manifest needs, all optional. Read only
// with catalogue_v2 on; with it off these keys are ignored as before.
const manifestFieldsSchema = z.object({
  pickupPoint: z.string().trim().max(200).optional().or(z.literal("")),
  nationality: z.string().trim().max(80).optional().or(z.literal("")),
  safetyNeeds: z.string().trim().max(1000).optional().or(z.literal("")),
  travelerNames: z.array(z.string().trim().max(120)).max(12).optional(),
  safetyNone: z.boolean().optional(),
});
function manifestFields(body) {
  if (!catalogueV2Enabled()) return null;
  const f = parse(manifestFieldsSchema, {
    pickupPoint: body?.pickupPoint, nationality: body?.nationality,
    safetyNeeds: body?.safetyNeeds, travelerNames: body?.travelerNames, safetyNone: body?.safetyNone,
  });
  return {
    pickupPoint: f.pickupPoint || null,
    nationality: f.nationality || null,
    // Phase 3: "None" is the explicit answer when there are no safety needs.
    safetyNeeds: f.safetyNone === true ? SAFETY_NONE : (f.safetyNeeds || null),
    travelerNames: (f.travelerNames || []).filter(Boolean),
  };
}

// Model phase 3 — under catalogue_v2, a booking on a catalog departure must
// carry every field the operator's manifest needs (decided 27 Sep 2026).
// Returns the catalog context (or null for a legacy departure).
async function requireCompleteBooking(c, departureId, manifest, seats, phone) {
  if (!manifest) return null;
  const ctx = await catalogueContextFor(c, departureId);
  if (!ctx) return null;
  assertBookingComplete({ ...manifest, phone }, seats, { needsNationality: ctx.needsNationality });
  // 066: no rate card (or no price on it), or no site-wide exchange rate: not bookable.
  await assertRateCardBookable(c, ctx.departureId);
  return ctx;
}

// Model phase 4: seats held for waitlist offers are not for general sale.
// Nothing is held with the flag off, or before migration 051.
async function heldForWaitlist(c, legacyDepartureId, exceptSeats = 0) {
  if (!catalogueV2Enabled()) return 0;
  try {
    return Math.max(0, (await seatsHeldForWaitlist(c, legacyDepartureId)) - exceptSeats);
  } catch (e) {
    if (e?.code !== "42P01") throw e;
    return 0;
  }
}

// A booking made after GoAhead is asked to pay at once (section 9.1, step 7).
async function payNowIfGoingAhead(c, pledgeId, catalogueDepartureId) {
  const departure = await departureFor(c, { id: catalogueDepartureId });
  if (departure?.status === "go_ahead") await requestPayment(c, { pledgeId, departure });
}

// Operator verification application (site/verify.html). Every field is bounded:
// this endpoint is open to the internet and the values land in an email and an
// ops table, so an unbounded `about` is a free megabyte per request.
const operatorApplicationSchema = z.object({
  company: z.string().trim().min(1, "Company name is required.").max(160),
  contactName: z.string().trim().min(1, "Contact name is required.").max(160),
  city: z.string().trim().min(1, "City is required.").max(120),
  email: z.string().trim().email("A valid email is required.").max(200),
  phone: z.string().trim().max(60).optional().or(z.literal("")),
  licence: z.string().trim().min(1, "Tourism license number is required.").max(120),
  regions: z.string().trim().max(160).optional().or(z.literal("")),
  about: z.string().trim().max(4000).optional().or(z.literal("")),
  // The consent tick is required in the form's own markup; it is re-checked
  // here so a scripted post can't create an application nobody agreed to.
  consent: z.literal(true, { message: "Please confirm the license and insurance declaration." }),
});

// Agency-created pooling request. Numeric fields are bounded so a malformed or
// hostile body can't create a departure with negative seats or absurd pricing.
// Traveler-initiated departure request (Phase A of the traveler-initiated
// departures addendum). Email is required — approval/decline needs a channel.
// An operator asking for a new date for their customer. Same shape as the
// traveller's, with the operator's auto-reference in place of a name and the
// customer's contact required, as it is for an operator booking.
const agencyDepartureRequestSchema = z.object({
  tourProductId: z.string().trim().min(1, "Tour is required."),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid date (YYYY-MM-DD) is required."),
  customers: z.string().trim().max(120).optional(),
  customerEmail: z.string().trim().email("A valid customer email is required."),
  customerPhone: z.string().trim().min(6, "A customer phone number is required."),
  seats: z.coerce.number().int().min(1).max(20),
  note: z.string().trim().max(500).optional(),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
  ignoreMatches: z.coerce.boolean().optional(),
});

const publicDepartureRequestSchema = z.object({
  tourProductId: z.string().trim().min(1, "Tour is required."),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "A valid date (YYYY-MM-DD) is required."),
  customerName: z.string().trim().min(1, "Traveler name is required."),
  customerEmail: z.string().trim().email("A valid email is required."),
  customerPhone: z.string().trim().max(40).optional(),
  phoneToken: z.string().trim().max(400).optional(),
  seats: z.coerce.number().int().min(1).max(20),
  note: z.string().trim().max(500).optional(),
  roomingType: z.enum(["single", "double", "triple"]).optional(),
  accommodationTier: z.string().optional(),
  // Join-first rule: near-matches must be explicitly rejected client-side
  // before a create is allowed through.
  ignoreMatches: z.coerce.boolean().optional(),
  // The partner whose widget the request came from, as on a booking.
  refCode: z.string().trim().max(60).optional(),
  pageUrl: z.string().trim().max(600).optional(),
});

// Eligibility fences for traveler-picked dates. The addendum specified these
// "per tour product" with these as DEFAULTS; only the defaults were built. They
// live in shared/request-window.js now, because the calendar and the admin form
// need the same pair and both are in the browser bundle.
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
    // The ops payment-link prompt. Reported for the same reason `cancelJob` is:
    // the queue is DERIVED, so a job that has never sent looks identical to one
    // with nothing to send — from the outside, and from the logs. This line was
    // missing while its sibling below was not, and the gap cost a day of "was
    // that ever switched on?" with no way to answer it.
    goAheadAlert: jobSchedulerEnabled() ? (goAheadAlertDryRun() ? "dry-run" : "live") : "off",
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
//
// The one exception is the deployed commit: which code is live is public in
// the repository anyway, and it answers "is the fix deployed?" without a
// dashboard login. Railway sets RAILWAY_GIT_COMMIT_SHA on a deploy from
// GitHub; a CLI upload (`railway up`) has no commit, so it reads "unknown".
app.get("/api/health", h(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA || "unknown" });
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

// Settings: a signed-in user corrects the name shown on their account and in
// the team list. Email and role are not theirs to change here: the email is
// the login, and roles are set by the agency owner or Sawa.
const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your name.").max(120),
});
app.patch("/api/me", requireAuth, writeLimiter, h(async (req, res) => {
  const { fullName } = parse(profileSchema, req.body);
  const before = req.user.fullName || null;
  await pool.query(`UPDATE app_users SET full_name = $1 WHERE id = $2`, [fullName, req.user.id]);
  await logAudit(req, {
    action: "profile.update", entity: "user", entityId: req.user.id,
    detail: { from: { fullName: before }, to: { fullName } },
  });
  res.json({ user: { ...req.user, fullName } });
}));

// Settings: the agency owner keeps the agency's contact person and phone up to
// date. The company name, licence and ETAA numbers are part of the verified
// operator record and change only through Sawa, so they are not accepted here.
const agencyProfileSchema = z.object({
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  // 070: the agency's own website. The widget's email links may return to
  // pages on it, and to nowhere else (shared/partner-page.js). "" clears it.
  website: z.string().trim().max(200).optional(),
});
app.patch("/api/agency/profile", requireAuth, requireRole("agency_owner"), writeLimiter, h(async (req, res) => {
  if (!req.user.agencyId) throw new AppError(403, "This account is not linked to an agency.");
  const input = parse(agencyProfileSchema, req.body);
  const before = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
  if (!before) throw new AppError(404, "Agency not found.");
  const contactName = input.contactName === undefined ? before.contact_name : (input.contactName || null);
  const phone = input.phone === undefined ? before.phone : (input.phone || null);
  let row = (await pool.query(
    `UPDATE agencies SET contact_name = $1, phone = $2 WHERE id = $3 RETURNING *`,
    [contactName, phone, req.user.agencyId])).rows[0];
  const detail = { from: { contactName: before.contact_name, phone: before.phone }, to: { contactName, phone } };
  if (input.website !== undefined && (input.website || null) !== (before.website || null)) {
    const website = input.website ? normalizeWebsite(input.website) : null;
    if (input.website && !website) throw new AppError(422, "Enter your website's address, like https://www.youragency.com. It must be a public https site.");
    // The column arrives with migration 070, applied by hand.
    if (!("website" in before)) throw new AppError(409, "Saving a website isn't switched on yet. Sawa needs to apply an update first (migration 070).");
    row = (await pool.query(`UPDATE agencies SET website = $1 WHERE id = $2 RETURNING *`, [website, req.user.agencyId])).rows[0];
    detail.from.website = before.website || null;
    detail.to.website = website;
  }
  await logAudit(req, { action: "agency.profile.update", entity: "agency", entityId: req.user.agencyId, detail });
  res.json({ agency: mapAgency(row) });
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
// Blog visibility is evaluated against the database clock on each request.
// The server-rendered page cache and llms-full.txt snapshot also go stale on a
// write (they embed seat counts and prices), but they're defined further down —
// the SPA one only exists when /dist is present. So they register a clearer here
// instead, and every cache drops together.
const cacheClearers = [];
// The tour lookup and slug index in seo.js embed product rows, so a catalogue
// write has to drop them with everything else.
cacheClearers.push(() => clearSeoCaches());
// 064 — a traveler-rate change by the daily job moves every EUR price.
onTravellerRateChange(() => invalidatePublicBootstrap());
function invalidatePublicBootstrap() {
  clearPublicCatalogue();
  publicBootstrap.invalidate();
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
  // Staff also learn whether a listing came from an agency's own login (the
  // Listing requests queue), which an operating company alone doesn't say.
  const productsSql = canSeeAll
    ? `SELECT p.*, EXISTS (SELECT 1 FROM app_users u WHERE u.id::text = p.submitted_by AND u.agency_id IS NOT NULL) AS submitted_by_agency
         FROM tour_products p ORDER BY p.id`
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
  const [agencies, cities, products, departures, pledges, operatorInputs] = await Promise.all([
    pool.query("SELECT * FROM agencies ORDER BY id"),
    pool.query("SELECT * FROM cities ORDER BY id"),
    pool.query(productsSql),
    pool.query(`SELECT * FROM departures WHERE ${departureScope} ORDER BY id`),
    pool.query(
      `SELECT * FROM pledges
        WHERE departure_id IN (SELECT id FROM departures WHERE ${departureScope})
        ORDER BY created_at ASC, id ASC`
    ),
    // U01 — widget codes' agencies and deposit times, for the operator rule.
    loadOperatorInputs(pool),
  ]);

  const byDep = new Map();
  for (const p of pledges.rows) {
    if (!byDep.has(p.departure_id)) byDep.set(p.departure_id, []);
    byDep.get(p.departure_id).push(p);
  }

  // Mapped once and shared: the payload lists them, and each departure needs
  // its own to resolve the confirm deadline.
  // U01 — the direct-bookings operator, and each listing's default operator
  // (the agency that listed it, else the direct-bookings operator).
  const directAgencyId = directOperatorId(agencies.rows, DIRECT_BOOKINGS_OPERATOR);
  const mappedProducts = products.rows.map(mapProduct)
    .map((p) => ({ ...p, operatorAgencyId: p.agencyId || directAgencyId || null }));
  const productsById = new Map(mappedProducts.map((p) => [p.id, p]));

  const payload = {
    // Only platform staff get the agency directory; agencies/public don't need it.
    agencies: isPlatform(user) ? agencies.rows.map(mapAgency) : [],
    // The operator behind each listing, whitelisted by publicOperator(). The
    // full agency rows above stay staff-only; this is the three fields a
    // traveller may see, and the licence number is not among them — /verify
    // promises operators it is never shared outside Sawa.
    operatorsByProduct: Object.fromEntries(
      agencies.rows.map(mapAgency)
        .map((a) => [a.id, publicOperator(a)])
        .filter(([, op]) => op)
    ),
    // S04 — tells the booking form whether to ask for a phone code.
    phoneVerification: phoneVerificationEnabled(),
    // Cloudflare Turnstile's public site key, or null (no check shown).
    turnstileSiteKey: turnstileSiteKey(),
    cities: cities.rows.map(mapCity),
    tourProducts: mappedProducts.map((p) => presentProduct(p, user)),
    // pending_review = traveler-requested, awaiting ops approval. Only
    // platform staff see them; the public board and agencies must not.
    //
    // Departures whose start has passed are dropped from the anonymous payload
    // — that is the public catalogue and the server-rendered HTML, where an
    // expired date rendered as a joinable card. Signed-in agencies and staff
    // keep the full list: their dashboards count past departures as history.
    departures: departures.rows
      .filter((d) => canSeeAll || d.status !== "pending_review")
      // 055: a merged date is gone from the site; its links redirect to the kept one.
      .filter((d) => canSeeAll || d.merged_into_id == null)
      .map((d) => mapDeparture(d, byDep.get(d.id) || []))
      .filter((d) => user || !departureStarted(d))
      // productsById so each departure's confirm deadline honours any override
      // on its listing rather than only the type default.
      .map((d) => {
        const product = productsById.get(d.tourProductId) || null;
        const enriched = enrichDeparture(d, product);
        // Worked out here, from the full pledge list, before presentDeparture
        // strips it for the viewer.
        enriched.operatorAgencyId = operatorForDeparture(
          { ...enriched, pledges: withDepositTimes(enriched.pledges, operatorInputs.depositPaidAt) }, {
            listingAgencyId: product?.agencyId || null, directAgencyId,
            referralAgencies: operatorInputs.referralAgencies,
            lockAtMs: Date.parse(enriched.bookingClosesAt || ""),
          });
        return presentDeparture(enriched, user);
      }),
  };
  // catalogue_v2 (model phase 1): travellers and agencies see the catalogue:
  // its products, its dates, no operator names. Staff keep the full payload.
  // With the flag off, or before migration 047, this returns the payload as is.
  if (catalogueV2Enabled() && !canSeeAll) {
    const cat = await publicCatalogue();
    if (cat) return overlayBootstrap(payload, cat, user);
  }
  return payload;
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

// Where ops emails send staff. Used by the tour, booking and date-request routes.
const portalLink = () => (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, "")}/portal` : "");

// Departures and tour products: publishing a date, saving and reviewing a tour, pricing and confirming a departure: server/routes/departures-products.js.
provideRouteContext({
  app, h, AppError, loadProduct, loadDeparture, uniqueBookingCode, insertPledge, newPledgeId, presentDeparture,
  portalLink,
});
const {
  upsertTourProduct,
} = await import("./routes/departures-products.js");
export { upsertTourProduct };

// Making a booking: an agency's pledge, phone verification, group requests, the public booking and cancelling one: server/routes/bookings.js.
provideRouteContext({
  app, h, parse, pledgeSchema, manifestFields, loadDeparture, AppError, heldForWaitlist, loadProduct,
  requireCompleteBooking, newPledgeId, insertPledge, uniqueBookingCode, payNowIfGoingAhead, presentDeparture,
  portalLink, writeLimiter, requireTurnstile, bookingAttemptLimiter, publicBookingSchema,
});
const {
  forPartner, notifyOps, placePublicBooking, verifiedPhoneFor,
} = await import("./routes/bookings.js");

// Making a date request: the one function every way of asking for a new date goes through, and its announcement: server/routes/date-request-create.js.
provideRouteContext({
  AppError, uniqueBookingCode, loadProduct, loadDeparture, newPledgeId, insertPledge, presentDeparture,
  NEAR_MATCH_WINDOW_DAYS, forPartner, notifyOps,
});
const {
  createDateRequest, announceDateRequest,
} = await import("./routes/date-request-create.js");

// A traveller's own booking: looking it up, confirming it, the group link, the waitlist and cancelling, plus the public tour and date reads: server/routes/public-bookings.js.
provideRouteContext({
  app, writeLimiter, h, parse, operatorApplicationSchema, AppError, placePublicBooking, createDateRequest,
  announceDateRequest, forPartner, loadDeparture, loadProduct, manifestFields, heldForWaitlist,
  requireCompleteBooking, newPledgeId, insertPledge, uniqueBookingCode, publicBootstrapPayload,
});
await import("./routes/public-bookings.js");

// Date requests, referral codes and the agency widget: asking for a date that is not on sale, and who sent the traveller: server/routes/date-requests.js.
provideRouteContext({
  app, writeLimiter, bookingAttemptLimiter, h, requireTurnstile, parse, publicDepartureRequestSchema,
  verifiedPhoneFor, createDateRequest, forPartner, announceDateRequest, presentDeparture,
  agencyDepartureRequestSchema, AppError, notifyOps, loadDeparture,
});
await import("./routes/date-requests.js");

// Destinations and blog posts: what the content desk writes and the public site reads: server/routes/content.js.
provideRouteContext({
  app, h, AppError,
});
await import("./routes/content.js");

// ---- shared write helpers ----
async function insertPledge(c, departureId, p) {
  await c.query(
    `INSERT INTO pledges
      (id, departure_id, agency_id, agency, seats, customers, price_per_person, booking_total,
       deposit_percent, deposit_due, balance_due, balance_due_date, source, booking_code,
       rooming_type, accommodation_tier, accommodation_tier_name, created_by_user_id, customer_email,
       customer_phone, ref_code, paid, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      p.id, departureId, p.agencyId ?? null, p.agency ?? null, p.seats, p.customers ?? null,
      p.pricePerPerson ?? null, p.bookingTotal ?? null, p.depositPercent ?? null,
      p.depositDue ?? null, p.balanceDue ?? null, p.balanceDueDate ?? null,
      p.source ?? null, p.bookingCode ?? null, p.roomingType ?? null,
      p.accommodationTier ?? null, p.accommodationTierName ?? null, p.createdByUserId ?? null,
      p.customerEmail ?? null, p.customerPhone ?? null, p.refCode ?? null, p.paid === true,
      p.status ?? "confirmed",
    ]
  );
  if (p.manifest) {
    // Only with catalogue_v2 on (see manifestFields); columns from migration 049.
    await c.query(
      `UPDATE pledges SET pickup_point = $2, nationality = $3, safety_needs = $4,
              traveller_names = CASE WHEN jsonb_array_length($5::jsonb) > 0 THEN $5::jsonb ELSE traveller_names END
        WHERE id = $1`,
      [p.id, p.manifest.pickupPoint, p.manifest.nationality, p.manifest.safetyNeeds, JSON.stringify(p.manifest.travelerNames)]);
  }
  // Migration 052: the Terms version the booking accepted. A catalog booking
  // under the flag records the catalog version instead (fixBookingTerms).
  await recordTermsVersion(c, { pledgeId: p.id, scope: "legacy" });
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
async function provisionUser({ email, fullName, role, agencyId, operatorId }) {
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
    // operator_id exists only once migration 049 is applied; it is named only
    // for an operator login, so every other login is inserted exactly as before.
    await pool.query(
      operatorId != null
        ? `INSERT INTO app_users (id, email, full_name, role, agency_id, operator_id, status)
           VALUES ($1,$2,$3,$4,NULL,$5,'active')`
        : `INSERT INTO app_users (id, email, full_name, role, agency_id, status)
           VALUES ($1,$2,$3,$4,$5,'active')`,
      operatorId != null
        ? [data.user.id, normalizedEmail, fullName || null, role, operatorId]
        : [data.user.id, normalizedEmail, fullName || null, role, agencyId]
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
  // Remembered sign-in checks (server/supabase.js) are dropped, so a revoked
  // login doesn't ride on one.
  if (!allowed) clearAuthCache();
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

// Agencies and staff: an agency owner's own team, and the admin's agencies, their owners and the platform staff: server/routes/agencies-staff.js.
provideRouteContext({
  app, h, writeLimiter, newStaffSchema, provisionUser, AppError, setLoginAccess, requireAdmin, parse,
});
await import("./routes/agencies-staff.js");

// The admin desk: the audit trail, the dashboard numbers, every booking on the platform, and linking bookings into a party: server/routes/admin-desk.js.
provideRouteContext({
  app, h, AppError, loadDeparture, parse,
});
await import("./routes/admin-desk.js");

// A departure's dates as a customer reads them. Used by the payment and the
// settlement routes (server/routes/), so it stays here and is handed to both.
function depDateLabel(d) {
  const f = (s) => (s ? new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${String(s).slice(0, 10)}T12:00:00Z`)) : "");
  const start = f(d.startDate || d.date);
  const end = f(d.endDate);
  return end && end !== start ? `${start} – ${end}` : start;
}

// Payment links (043): the ops queue, sending a link, marking it paid, voiding and refunding, and an agency's own view: server/routes/payments.js.
provideRouteContext({
  AppError, loadDeparture, loadProduct, app, h, depDateLabel, parse,
});
await import("./routes/payments.js");

// Settlements and the Wednesday payouts (044): the finance desk's runs, costs, adjustments, receipts and payouts: server/routes/settlements.js.
provideRouteContext({
  AppError, depDateLabel, app, h, uploadLimiter, parse, writeLimiter,
});
await import("./routes/settlements.js");

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
// Merging duplicate dates (055): two departures of one tour on one day become one: server/routes/merge-dates.js.
provideRouteContext({
  app, h, AppError, parse, loadDeparture, presentDeparture, uploadLimiter,
});
await import("./routes/merge-dates.js");

// ============================ CATALOGUE (model phase 1) ============================
// Admin routes for the catalogue and departure calendar. The public side is
// behind the catalogue_v2 flag (see catalogue-public.js); with it off nothing
// here reaches a traveller. Registered before the /api 404 below.
registerCatalogueRoutes(app, { requireAuth, requireRole, h, logAudit, invalidatePublic: () => invalidatePublicBootstrap() });
registerOperatorRoutes(app, { requireAuth, requireRole, h, logAudit, provisionUser, supabaseAdmin, sendEmail, invalidatePublic: () => invalidatePublicBootstrap() });
registerFinanceRoutes(app, { requireAuth, requireRole, h, logAudit, sendEmail, opsRecipient, writeLimiter });
registerPayAtGoAheadRoutes(app, { requireAuth, requireRole, h, logAudit, sendEmail, writeLimiter });
registerReviewRoutes(app, {
  requireAuth, requireRole, h, logAudit, writeLimiter, uploadLimiter, supabaseAdmin,
  sendEmail, sendEmailInBackground, reviewRequestEmail, opsNewReviewEmail, opsRecipient, portalLink,
});

// The /contact form (13 Nov 2026). Its own limiter: a person sends one or two
// messages, so 5 in 15 minutes from one address is plenty and keeps the team
// inbox from being flooded. CONTACT_RATE_LIMIT overrides; tests default high.
const contactLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: Number(process.env.CONTACT_RATE_LIMIT) || (process.env.NODE_ENV === "test" ? 1000 : 5),
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "You've sent several messages in the last few minutes. Please wait a little, or message us on WhatsApp (+20 109 284 7613).", whatsapp: "https://wa.me/201092847613" },
});
registerContactRoutes(app, { sendEmail, limiter: contactLimiter });

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Photos under /images in WebP and smaller widths, for the same URLs; anything
// it doesn't handle falls through to the static files below, unchanged.
// Same order of roots as the static handlers: site/ first, then the build.
app.use("/images", imageVariants({
  roots: [join(__dirname, "..", "site", "images"), join(distDir, "images"), join(__dirname, "..", "public", "images")],
}));

// The public site outside the app: robots, llms and sitemap files, the editorial pages, and old tour URLs: server/routes/site.js.
provideRouteContext({
  app, h, cacheClearers, queryOf, __dirname,
});
await import("./routes/site.js");

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
        ? dataScript("sawa-bootstrap", bootstrap)
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
      const cacheControl = notFound || /^\/blog(?:\/|$)/.test(path)
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
      if (/^\/blog(?:\/|$)/.test(path)) return send(res, await renderToCache(path), "miss");
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
        console.warn("[warm] could not list catalog routes —", e.message);
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
    console.log(`[warm] keeping the catalog and ${HOT_PATHS.join(", ")} warm every ${Math.round(everyMs / 1000)}s`);
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
  if (status >= 500 && !err.expose) console.error(err);
  // Never surface raw internal error text (e.g. Postgres messages) to clients.
  // 4xx errors are our own AppError/AuthError with safe, user-facing messages;
  // a 5xx is shown only when it was written to be (`expose`), like the
  // "payments aren't switched on yet" answer.
  const message = status >= 500 && !err.expose ? "Server error." : (err.message || "Request failed.");
  res.status(status).json({ error: message });
});

// Railway provides PORT; fall back to API_PORT for local dev.
const port = Number(process.env.PORT || process.env.API_PORT || 8787);
// Importable without binding the port: the execution tests need this module's
// functions, not a server. Everything boot does beyond serving (page warmer,
// catalogue warm-up) starts inside this callback, so skipping listen skips it.
if (!process.env.APP_NO_LISTEN) app.listen(port, "0.0.0.0", () => {
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
      console.log(`[boot] catalog warm — ${(p?.tourProducts || []).length} products`);
      // Only once the payload is in hand: the hot-path renders each need it,
      // and starting them first would have every one of them build its own.
      startPageWarmer?.();
    })
    .catch((e) => {
      // CCC2.2 — surfaced. This runs after app.listen(): the server is already
      // accepting requests, and a failed catalogue warm-up means slower first
      // responses, not wrong ones.
      if (!surfaceProgrammerError("pageWarm", e)) {
        console.warn("[boot] catalog warm-up skipped —", e.message);
      }
    });
});
