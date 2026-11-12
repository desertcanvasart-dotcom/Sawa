import { mergedBlogSlugs } from "./blog-publication.js";
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { pool, withTransaction, withDepartureWrites } from "./db/index.js";
import { pendingGoAheads, alertPayload } from "./goahead-alert.js";
import { refreshStatus } from "./departure-status.js";
import { publicOperator, operatorSelectable, operatorForDeparture, directOperatorId } from "./domain.js";
import { cspHeader, cspHeaderName, describeViolation, firstSighting } from "./csp.js";
import {
  phoneVerificationEnabled, normalizePhone, issuePhoneToken, phoneTokenValid,
  startVerification, checkVerification,
} from "./phone-verify.js";
import { durationShapeError, cutoffUnitError, normalizeDuration } from "../shared/booking-policy.js";
import { operatingDayError } from "../shared/operating-days.js";
import { minLeadDaysFor, maxHorizonDaysFor, requestWindowError } from "../shared/request-window.js";
import { cleanRefCode } from "../shared/ref-code.js";
import { mapAgency, mapCity, mapProduct, mapDeparture, mapPledge, isoDate } from "./db/mappers.js";
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
  bookingLookupView,
} from "./domain.js";
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
import { recordAgencyBooking, releaseUnpaidAgencyBookings } from "./commissions.js";
import { fixBookingTerms } from "./cancellation-tiers.js";
import { stampBookingPrice } from "./pool-settlement.js";
import { recordTermsVersion } from "./terms-versions.js";
import { mergedTarget } from "./departure-merge.js";
import {
  requestPayment, departureFor, seatsHeldForWaitlist, bookingPayView, acceptBookingTerms, joinWaitlist, acceptSellerChangeOffer,
  waitlistOffer, claimWaitlistOffer, completeWaitlistOffer,
} from "./pay-at-goahead.js";
import { registerPayAtGoAheadRoutes } from "./pay-at-goahead-routes.js";
import { partyLinkFor, partyForBooking, partyView, partyToJoin, joinParty, partiesAvailable, JOINABLE_STATUSES } from "./booking-parties.js";
import { SAFETY_NONE } from "../shared/settlement-rules.js";
import { integrityAvailable, recordSignals, detectCluster } from "./booking-integrity.js";
import { reduceSignals } from "./booking-signals.js";
import {
  holdForConfirmation, holdBooking, dateRequestHoldAvailable, heldByToken, heldByCode, heldCodeTaken, isExpired, markConfirmed, markRefused,
  cancelHeld, resendLink, confirmBookingUrl, MAX_RESENDS,
} from "./booking-confirmation.js";
import { verifyTurnstile, turnstileSiteKey } from "./turnstile.js";
import { catalogueV2Enabled } from "./features.js";
import { loadCatalogueTourInfo } from "./catalogue-tour-pricing.js";
import { routeBooking, ensureOpenDeparture } from "./catalogue-departures.js";
import { publicCatalogue, overlayBootstrap, clearPublicCatalogue } from "./catalogue-public.js";
import {
  sendEmail,
  sendEmailInBackground,
  bookingConfirmationEmail,
  payAtGoAheadBookingEmail,
  goAheadEmail,
  confirmBookingEmail,
  listingApprovedEmail,
  listingRejectedEmail,
  departureRequestReceivedEmail,
  departureRequestApprovedEmail,
  departureRequestDeclinedEmail,
  operatorApplicationEmail,
  operatorApplicationReceiptEmail,
  operatorApplicationText,
  opsNewBookingEmail,
  opsNewListingEmail,
  opsGroupRequestEmail,
  opsRecipient,
  reviewRequestEmail,
  opsNewReviewEmail,
} from "./email.js";
import { registerReviewRoutes } from "./reviews.js";
import {
  STAGE_LABEL,
  isMissingPaymentsTable,
  paymentSummary,
  paymentsByPledge,
} from "./payments.js";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHead, buildBody, robotsTxt, sitemapXml, llmsTxt, llmsFullTxt,
  dataScript, sliceBootstrapForRoute, clearSeoCaches, catalogueRoutes,
  canonicalTourPath,
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
import { throughPartner, partnerPageFor, rememberPartnerPage, confirmLink, partnerJoinUrl } from "./partner.js";
import { provideRouteContext } from "./route-context.js";
import { normalizeWebsite } from "../shared/partner-page.js";

import { BRAND, DIRECT_BOOKINGS_OPERATOR } from "./brand.js";
import { operatorFor, loadOperatorInputs, withDepositTimes } from "./operator-lookup.js";
import { startJobScheduler, jobSchedulerEnabled, cancelJobDryRun, goAheadNotifyDryRun, goAheadAlertDryRun } from "./jobs/scheduler.js";
import { TOUR_TIMEZONE } from "./tz.js";
import { cleanHtml, cleanItinerary } from "./sanitize.js";
import { canonicalRedirect } from "./canonical.js";
import { canonicalPathRedirect } from "./path-canonical.js";
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
    throw new AppError(422, "A date is created by its first booking — record the traveler's name.");
  }
  if (!travelerEmail && !travelerPhone) {
    throw new AppError(422, "Record how to reach the first traveler — an email or a phone number.");
  }
  if (!Number.isInteger(travelerSeats) || travelerSeats < 1) {
    throw new AppError(422, "Seats must be a whole number of at least 1.");
  }
  const result = await withTransaction(async (c) => {
    const product = await loadProduct(c, body.tourProductId);
    if (!product) throw new AppError(404, "Tour product not found.");

    // Same tour, same day (27 Sep 2026): a booking that arrives by phone joins
    // the date that already exists; a second listing of one day is refused.
    const sameDay = (await c.query(
      `SELECT id, status FROM departures
        WHERE tour_product_id = $1 AND COALESCE(start_date, date) = $2::date
          AND status IN ('pending_review', 'open', 'minimum_reached', 'supplier_confirmed')
        ORDER BY id LIMIT 1`, [product.id, body.startDate || body.date])).rows[0];
    if (sameDay) {
      throw Object.assign(new AppError(409, `This tour already has a date on that day (departure ${sameDay.id}, ${sameDay.status.replace(/_/g, " ")}). Add the booking to it instead.`), { existingDepartureId: Number(sameDay.id) });
    }

    // Operating days. The traveller-request route has refused an ineligible day
    // since it was written; THIS path never checked, so a Tuesday sailing could
    // be published on a Mon/Sat cruise — and the site would advertise a date it
    // refuses to let a traveller request. Two paths, one rule, and only one of
    // them enforced it.
    //
    // It has not bitten: no restricted product has a departure today. That is
    // precisely when it is cheapest to close — all three Nile cruises run on
    // fixed weekdays, so the first cruise date published is the first chance to
    // get it wrong.
    const dayProblem = operatingDayError(product, body.date || body.startDate);
    if (dayProblem) throw new AppError(422, dayProblem);

    // This endpoint lets a departure override the listing's capacity, so the
    // contract limit has to be checked here too — not only on the listing.
    const depMinSeats = Number(body.minSeats || product.minSeats);
    const depMaxSeats = Number(body.maxSeats || product.maxSeats);
    const capacityProblem = capacityError(depMinSeats, depMaxSeats);
    if (capacityProblem) throw new AppError(422, capacityProblem);

    if (travelerSeats > depMaxSeats) {
      throw new AppError(422, `This date holds at most ${depMaxSeats} travelers.`);
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
         quality, status, notes, deposit_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,'open',$20,$21)`,
      [
        id, product.type, product.id, product.title, startDate,
        isPkg ? startDate : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, body.time || product.defaultTime,
        product.city, product.guide, product.vehicle,
        depMinSeats, depMaxSeats,
        Number(body.baseCost || product.baseCost || 0), Number(body.publishedRate || product.publishedRate),
        Number(body.breakPrice || product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality, product.description,
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
    sendEmailInBackground(operatorFor(departure.id).then((operator) => bookingConfirmationEmail({
      to: travelerEmail, customerName: travelerName, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      seats: travelerSeats, depositDue: result.pricing.depositDue, balanceDue: result.pricing.balanceDue,
      balanceDueDate: result.pricing.balanceDueDate, bookingCode: result.bookingCode,
      product: departure, operator,
    })));
  }
  res.status(201).json({ departure: presentDeparture(departure, req.user), bookingCode: result.bookingCode });
}));

// Shared upsert used by both the admin editor and the agency listing editor.
// `review` carries the approval state to write: { status, agencyId, submittedBy, reviewedBy }.
// Exported for upsert-execution.test.js, which EXECUTES it against a stub
// client — the only kind of test that catches an out-of-scope identifier.
// Two consecutive production breaks in this one function shipped under a
// green suite (#163's arity, then the #162 scope error): reading the SQL as
// text catches the first class, only execution catches the second.
export async function upsertTourProduct(c, body, review) {
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

  // The type and the duration must describe the same trip. Minya shipped as a
  // `package` reading "1 day · 15 hours" and nothing objected — so it carried a
  // package's deposit, balance date, cancellation schedule and 30-day
  // confirmation deadline for months, and the only visible symptom was an odd
  // duration string. Same shape as the capacity check above: refused in words an
  // operator can act on, before anything is written.
  //
  // This block (and the window check below) lived here from #151 until #162
  // moved it into the admin-departures route by accident — where `type` does
  // not exist, and where `blankNum` was declared while the INSERT below kept
  // using it. Every listing save threw ReferenceError from then on, and the
  // green suite never noticed because nothing executes this function.
  // upsert-execution.test.js now does.
  // Read what was typed generously ("8 hours" → "Full day · about 8 hours")
  // and store it in the house format; only what can't be read is refused.
  if (typeof body.duration === "string") body.duration = normalizeDuration(type, body.duration);
  const durationProblem = durationShapeError(type, body.duration);
  if (durationProblem) throw new AppError(422, durationProblem);

  // The request window, if this listing sets one. Mirrors the CHECK in 037 so
  // the operator is told what is wrong in words rather than meeting a
  // constraint violation.
  const windowProblem = requestWindowError(body.requestMinLeadDays, body.requestMaxHorizonDays);
  if (windowProblem) throw new AppError(422, windowProblem);
  const blankNum = (v) => (v === "" || v == null ? null : Number(v));

  // The cutoff's unit (038). The hours stay canonical; the unit is how the
  // operator said it, and "days" over a number that is not whole days is
  // refused here in words rather than by the CHECK constraint.
  const cutoffHours = Number.isFinite(Number(body.bookingCutoffHours)) ? Number(body.bookingCutoffHours) : 24;
  const cutoffUnit = body.bookingCutoffUnit === "days" ? "days"
    : body.bookingCutoffUnit === "hours" ? "hours" : null;
  const cutoffProblem = cutoffUnitError(cutoffHours, cutoffUnit);
  if (cutoffProblem) throw new AppError(422, cutoffProblem);

  // Optional per-headcount pricing. Rejected loudly rather than silently
  // dropped: a table the operator believes is saved but isn't would quietly
  // sell every seat at the interpolated price instead.
  const tierCheck = validatePriceTiers(body.priceTiers, {
    minSeats: Number(body.minSeats || 4),
    maxSeats: Number(body.maxSeats || MAX_GROUP_SIZE),
  });
  if (tierCheck.error) throw new AppError(422, tierCheck.error);
  const priceTiers = tierCheck.tiers ? JSON.stringify(tierCheck.tiers) : null;
  await c.query(
    `INSERT INTO tour_products
      (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
       min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
       description, included, not_included, itinerary, accommodation_tiers,
       overview_html, policies_html, what_to_bring, meeting_point, pickup_note, booking_cutoff_hours, images,
       meeting_points, status, agency_id, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason, operating_days, price_tiers,
       request_min_lead_days, request_max_horizon_days, booking_cutoff_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)
     ON CONFLICT (id) DO UPDATE SET
       operating_days=EXCLUDED.operating_days, price_tiers=EXCLUDED.price_tiers,
       request_min_lead_days=EXCLUDED.request_min_lead_days,
       request_max_horizon_days=EXCLUDED.request_max_horizon_days,
       booking_cutoff_unit=EXCLUDED.booking_cutoff_unit,
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
       status=EXCLUDED.status,
       -- Staff editing a listing (saved straight to approved) keep who submitted
       -- it and when: overwriting them made an agency's listing read as staff's,
       -- and a tour staff added read as the operating company's request.
       submitted_at=CASE WHEN EXCLUDED.status = 'approved' AND tour_products.submitted_by IS NOT NULL THEN tour_products.submitted_at ELSE EXCLUDED.submitted_at END,
       submitted_by=CASE WHEN EXCLUDED.status = 'approved' AND tour_products.submitted_by IS NOT NULL THEN tour_products.submitted_by ELSE EXCLUDED.submitted_by END,
       reviewed_by=EXCLUDED.reviewed_by,
       reviewed_at=EXCLUDED.reviewed_at, rejection_reason=EXCLUDED.rejection_reason,
       -- The operator. Argument order matters and used to be the other way
       -- round: existing-wins meant a product could never be REASSIGNED, and an
       -- admin had no way to attach one at all — only an agency self-submitting
       -- ever set it, from its own session.
       -- New-value-wins with a NULL fallback gives both: an edit that supplies
       -- an operator sets it, and an edit that says nothing leaves it alone.
       -- The no-wipe property the old order existed for is preserved, because
       -- EXCLUDED.agency_id is NULL on every path that does not mean to change it.
       -- Clearing is the one exception, and it is explicit ($43): an admin who
       -- picks "Not assigned" used to see the old company come straight back.
       agency_id=CASE WHEN $43::boolean THEN NULL ELSE COALESCE(EXCLUDED.agency_id, tour_products.agency_id) END`,
    [
      id, type, title, body.city || "Cairo",
      type === "package" ? JSON.stringify(body.cities || [body.city || "Cairo"]) : null,
      type === "package" ? Number(body.nights || 3) : null,
      body.duration || (type === "package" ? `${Number(body.nights || 3) + 1} days · ${body.nights || 3} nights` : "Full day · about 4 hours"),
      body.defaultTime || "08:00", body.guide || "Licensed Egyptologist",
      body.vehicle || (type === "package" ? "Private van + flights" : "Van, 12 seats"),
      Number(body.minSeats || 4), Number(body.maxSeats || MAX_GROUP_SIZE),
      Number(body.baseCost || 0), publishedRate,
      Number(body.breakPrice || Math.round(publishedRate * 0.8)), Number(body.quality || 4.7),
      Number(body.depositPercent || (type === "package" ? 20 : 10)), body.description || "",
      JSON.stringify(body.included || []), JSON.stringify(body.notIncluded || []),
      type === "package" ? JSON.stringify(cleanItinerary(body.itinerary || [])) : null,
      type === "package" ? JSON.stringify(body.accommodationTiers || []) : null,
      cleanHtml(body.overviewHtml) || null, cleanHtml(body.policiesHtml) || null,
      JSON.stringify(body.whatToBring || []), body.meetingPoint || null,
      body.pickupNote || null, cutoffHours,
      JSON.stringify(body.images || []),
      JSON.stringify(Array.isArray(body.meetingPoints) ? body.meetingPoints : []),
      review.status, review.agencyId || null, review.submittedBy || null, now,
      review.reviewedBy || null, reviewedAt, null, operatingDays, priceTiers,
      blankNum(body.requestMinLeadDays), blankNum(body.requestMaxHorizonDays), cutoffUnit,
      review.clearAgency === true,
    ]
  );
  return loadProduct(c, id);
}

// The "Edit day tour" page: whether this tour is a catalogue product (flag on)
// and, if so, its catalogue values and the published rate card's tiers.
app.get("/api/admin/tour-products/:id/catalogue", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  res.json(await loadCatalogueTourInfo(req.params.id));
}));

// Admin creates / updates a tour product (platform staff only). Admin edits are
// auto-approved — a platform admin publishing a tour needs no second sign-off.
app.post("/api/admin/tour-products", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const body = req.body || {};
  // Only an active, listed operator may be attached. Keeping the company a
  // listing already has is allowed, so an unrelated edit never fails on it.
  if (body.agencyId) {
    const cur = body.id ? (await pool.query(`SELECT agency_id FROM tour_products WHERE id=$1`, [body.id])).rows[0] : null;
    if (cur?.agency_id !== body.agencyId) {
      const a = (await pool.query(`SELECT * FROM agencies WHERE id=$1`, [body.agencyId])).rows[0];
      const o = (await pool.query(`SELECT status FROM operators WHERE agency_id=$1`, [body.agencyId])).rows[0];
      if (!operatorSelectable(a && mapAgency(a), o)) throw new AppError(422, "That company can't be the operating company: it must be an active, publicly listed operator.");
    }
  }
  const product = await withTransaction((c) =>
    upsertTourProduct(c, body, {
      status: "approved", submittedBy: req.user.id, reviewedBy: req.user.id,
      // Platform staff assigning the operating company. An agency submitting
      // its own listing still gets its own id from the session below — this
      // is the only path where the operator is a CHOICE.
      agencyId: body.agencyId || null,
      // "Not assigned": the editor sends agencyId: null. A caller that leaves
      // the key out changes nothing, as before.
      clearAgency: Object.hasOwn(body, "agencyId") && !body.agencyId,
    }));
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
  let agencyName = null;
  const product = await withTransaction(async (c) => {
    if (body.id) {
      // Locked so the owner can't change between this check and the write.
      const owner = await c.query(`SELECT agency_id FROM tour_products WHERE id=$1 FOR UPDATE`, [body.id]);
      if (!owner.rows.length) throw new AppError(404, "Listing not found.");
      // Only a listing this agency owns. A Sawa-owned listing has no agency, and
      // used to pass this check: any agency could overwrite it, take it offline
      // and become its operator (docs/security/agency-listing-takeover.md).
      if (owner.rows[0].agency_id !== req.user.agencyId) {
        throw new AppError(403, "You can only edit your own listings.");
      }
    }
    const saved = await upsertTourProduct(c, body, { status: "pending", agencyId: req.user.agencyId, submittedBy: req.user.id });
    agencyName = (await c.query(`SELECT name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0]?.name || null;
    return saved;
  });
  await logAudit(req, { action: "listing.submit", entity: "tour_product", entityId: product.id, detail: { title: product.title } });
  sendEmailInBackground(opsNewListingEmail({
    to: opsRecipient(), title: product.title, agencyName, isEdit: Boolean(body.id), portalLink: portalLink(),
  }));
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
  // Looked up once for all of them, after the response (U01).
  const operator = recips.rows.length ? operatorFor(departure.id) : null;
  for (const row of recips.rows) {
    sendEmailInBackground(throughPartner(pool, { departureId: departure.id, email: row.customer_email },
      operator.then((op) => goAheadEmail({ to: row.customer_email, route: departure.route, dateLabel, operator: op }))));
  }
  emitDepartureSync(departure.id);
  res.json({ departure: presentDeparture(departure, req.user) });
}));

// Agency pledge — identity (agency) comes from the token, never the body.
app.post("/api/departures/:id/pledges", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const input = parse(pledgeSchema, req.body);
  const manifest = manifestFields(req.body);
  let agencyName = null;
  const departure = await withTransaction(async (c) => {
    // Numbered departures (catalogue_v2): the booking goes to the lowest-numbered
    // departure of the date with room for the whole party; a further one is
    // opened if none has room.
    const target = catalogueV2Enabled() ? (await routeBooking(c, { departureId: Number(req.params.id), seats: input.seats })).departureId : Number(req.params.id);
    const dep = await loadDeparture(c, target, { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (dep.mergedIntoId) throw Object.assign(new AppError(409, "This date was joined with another listing of the same tour and day. Book on that one."), { mergedIntoId: dep.mergedIntoId });
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
    if (seatsTotal(dep.pledges) + await heldForWaitlist(c, dep.id) + input.seats > dep.maxSeats) {
      throw new AppError(409, "This pledge exceeds capacity.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const catalogueCtx = await requireCompleteBooking(c, dep.id, manifest, input.seats, input.customerPhone);
    const agency = (await c.query(`SELECT * FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
    const pricing = computePledgePricing(dep, product, input);

    agencyName = agency.name;
    const pledgeId = newPledgeId(dep.id);
    await insertPledge(c, dep.id, {
      id: pledgeId,
      agencyId: agency.id,
      agency: agency.name,
      seats: input.seats,
      customers: (input.customers || "Customer details pending").trim(),
      customerEmail: input.customerEmail || null,
      customerPhone: input.customerPhone || null,
      createdByUserId: req.user.id,
      // Phase 4: a catalog booking has a code, the payment's reference.
      bookingCode: catalogueCtx ? await uniqueBookingCode(c) : null,
      manifest,
      ...pricing,
    });
    if (catalogueCtx) {
      // Model phase 4: pay at GoAhead. The agency showed its client the
      // cancellation terms before booking (Agency Reseller Agreement 4.2), so
      // the tier version in force now is the one this booking keeps.
      await fixBookingTerms(c, { pledgeId, by: "agency" });
      // Model phase 5: the published EUR rate, and the current tier's price.
      await stampBookingPrice(c, { pledgeId });
      // Model phase 3: the commission (EUR, from the rate version in force) is
      // locked now; an agency on billing is invoiced now.
      await recordAgencyBooking(c, { pledgeId, agency, catalogueDepartureId: catalogueCtx.departureId });
      await payNowIfGoingAhead(c, pledgeId, catalogueCtx.departureId);
      await ensureOpenDeparture(c, dep.id);
    }
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "pledge.create", entity: "departure", entityId: Number(req.params.id), detail: { seats: input.seats, agencyId: req.user.agencyId } });
  notifyOps(departure, {}, { ...input, customerName: input.customers }, { isRequest: false, bookedBy: agencyName || "an operator" });
  emitDepartureSync(departure.id);
  res.status(201).json({ departure: presentDeparture(departure, req.user) });
}));

// Tell Sawa about new demand from the public site. Fire-and-forget like the
// traveller's own email: a mail outage must never fail the booking.
const portalLink = () => (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, "")}/portal` : "");

function notifyOps(departure, booking, input, { isRequest, bookedBy }) {
  const d = departure;
  sendEmailInBackground(opsNewBookingEmail({
    to: opsRecipient(), isRequest, route: d.route,
    dateLabel: d.startDate && d.endDate ? `${d.startDate} – ${d.endDate}` : (d.startDate || d.date),
    seats: input.seats, seatsNow: seatsTotal(d.pledges), minSeats: goAheadSeatsFor(d),
    customerName: input.customerName, customerEmail: input.customerEmail, customerPhone: input.customerPhone,
    bookingCode: booking.bookingCode, note: input.note, bookedBy,
    portalLink: portalLink(),
  }));
}

// Public (direct traveller) booking — intentionally open, no auth, but the
// ---- S04 — phone verification for direct travellers -------------------------
// See server/phone-verify.js. Off until Twilio is configured, and then required
// for every direct booking and date request.
const phoneStartSchema = z.object({
  phone: z.string().trim().min(6, "Enter your mobile number.").max(40),
  channel: z.enum(["sms", "whatsapp"]).optional(),
});
const phoneCheckSchema = z.object({
  phone: z.string().trim().min(6).max(40),
  code: z.string().trim().regex(/^\d{4,10}$/, "Enter the code we sent you."),
});
const PHONE_FORMAT_HELP = "Enter your mobile number with its country code, e.g. +44 7700 900123 (Egyptian numbers can start with 01).";

// The traveller's number, normalised, once its token checks out — or, while
// verification is off, whatever they typed, as before.
function verifiedPhoneFor(input) {
  if (!phoneVerificationEnabled()) return input.customerPhone || null;
  const phone = normalizePhone(input.customerPhone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  if (!phoneTokenValid(input.phoneToken, phone)) {
    throw new AppError(422, "Please confirm your phone number with the code we send you before reserving.");
  }
  return phone;
}

app.post("/api/public/phone-verifications", writeLimiter, h(async (req, res) => {
  if (!phoneVerificationEnabled()) throw new AppError(404, "Phone verification is not in use.");
  const input = parse(phoneStartSchema, req.body);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  const r = await startVerification(phone, input.channel);
  if (!r.ok) {
    // Twilio's own message can name the account or the number's carrier; it is
    // logged for ops and the traveller gets a plain sentence.
    console.warn(`[phone-verify] send failed (${r.status}): ${r.message || "no message"}`);
    throw new AppError(r.status === 400 ? 422 : 502, r.status === 400
      ? "We couldn't send a code to that number. Check it and try again."
      : "We couldn't send a code just now. Please try again in a moment.");
  }
  await logAudit(req, { action: "phone.verify_start", entity: "phone", entityId: phone.slice(0, -4) + "····", detail: { channel: input.channel || "sms" } });
  res.json({ sent: true, phone });
}));

app.post("/api/public/phone-verifications/check", writeLimiter, h(async (req, res) => {
  if (!phoneVerificationEnabled()) throw new AppError(404, "Phone verification is not in use.");
  const input = parse(phoneCheckSchema, req.body);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(422, PHONE_FORMAT_HELP);
  if (!(await checkVerification(phone, input.code))) {
    throw new AppError(422, "That code isn't right, or it has expired. Check it, or ask for a new one.");
  }
  await logAudit(req, { action: "phone.verified", entity: "phone", entityId: phone.slice(0, -4) + "····" });
  res.json({ verified: true, phone, phoneToken: issuePhoneToken(phone) });
}));

// stricter write limiter guards this and the public cancel below from abuse.
//
// A direct booking is held until the traveler confirms their email (migration
// 058): every check below runs, then the booking waits in
// booking_confirmations and the traveler gets a "Confirm my booking" link.
// The link calls placePublicBooking again with the held booking, which runs
// the same checks and makes it. Answer 202 while held, 201 once made.
// Parties larger than 8 are not bookable online (29 Sep 2026). The booking form
// stops and offers this instead: a short request that becomes an admin lead.
// No booking is made and no seat is held.
const groupRequestSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(120),
  email: z.string().trim().email("Enter a valid email.").max(200),
  groupSize: z.coerce.number().int().min(MAX_GROUP_SIZE + 1, `A group request is for more than ${MAX_GROUP_SIZE} travelers.`).max(200),
  date: z.string().trim().max(40).optional().nullable(),
  productId: z.string().trim().max(120).optional().nullable(),
  productTitle: z.string().trim().max(200).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
  website: z.string().max(200).optional(), // honeypot: real people leave it empty
});
app.post("/api/public/group-requests", writeLimiter, h(async (req, res) => {
  const input = groupRequestSchema.parse(req.body || {});
  if (input.website) return res.status(202).json({ ok: true }); // a bot: answer as if it worked
  // The same bot check as the booking forms this one sits in: every request
  // here emails the operations inbox.
  await requireTurnstile(req);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : null;
  const product = input.productId
    ? (await pool.query(`SELECT id, title FROM tour_products WHERE id=$1`, [input.productId])).rows[0]
    : null;
  const title = product?.title || input.productTitle || null;
  let stored = true;
  try {
    await pool.query(
      `INSERT INTO group_requests (name, email, group_size, wanted_date, product_id, product_title, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.name, input.email, input.groupSize, wanted, product?.id || null, title, input.note || null]);
  } catch (e) {
    // Migration 062 is applied by hand: before it, the lead still reaches the
    // operations inbox, which is where it is acted on.
    if (e?.code !== "42P01") throw e;
    stored = false;
  }
  await logAudit(req, { action: "group_request.create", entity: "group_request", entityId: null, detail: { groupSize: input.groupSize, product: title, stored } });
  sendEmailInBackground(opsGroupRequestEmail({
    to: opsRecipient(), name: input.name, email: input.email, groupSize: input.groupSize,
    date: wanted || input.date || null, product: title, note: input.note || null, portalLink: portalLink(),
  }));
  res.status(201).json({ ok: true, stored });
}));

app.get("/api/admin/group-requests", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  let rows = [];
  try {
    rows = (await pool.query(`SELECT * FROM group_requests ORDER BY (status = 'new') DESC, created_at DESC LIMIT 200`)).rows;
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }
  res.json({ requests: rows.map((r) => ({
    id: Number(r.id), name: r.name, email: r.email, groupSize: r.group_size,
    wantedDate: r.wanted_date instanceof Date ? r.wanted_date.toISOString().slice(0, 10) : r.wanted_date,
    productId: r.product_id, productTitle: r.product_title, note: r.note, status: r.status,
    createdAt: r.created_at, handledBy: r.handled_by, handledAt: r.handled_at,
  })) });
}));

app.patch("/api/admin/group-requests/:id", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const { status } = z.object({ status: z.enum(["new", "contacted", "closed"]) }).parse(req.body || {});
  const row = (await pool.query(
    `UPDATE group_requests SET status=$1, handled_by=$2, handled_at=now() WHERE id=$3 RETURNING id`,
    [status, req.user.id, Number(req.params.id)])).rows[0];
  if (!row) throw new AppError(404, "Request not found.");
  await logAudit(req, { action: "group_request.update", entity: "group_request", entityId: String(row.id), detail: { status } });
  res.json({ ok: true });
}));

app.post("/api/public/departures/:id/bookings", writeLimiter, bookingAttemptLimiter, h(async (req, res) => {
  await requireTurnstile(req);
  const out = await placePublicBooking(req, { departureId: Number(req.params.id), body: req.body });
  await logAudit(req, out.audit);
  if (out.flagAudit) await logAudit(req, out.flagAudit);
  res.status(out.status).json(out.json);
}));

// The partner whose widget a booking came through (server/partner.js): the
// line "Booked through <agency>" on the emails about it.
// `page`: the checked page on the partner's site the booking was made on, so
// "check your booking" in this email opens it there.
const forPartner = (refCode, message, { pageUrl = null, bookingCode = null } = {}) => throughPartner(pool, { refCode, pageUrl, bookingCode }, message);

async function placePublicBooking(req, { departureId, body, confirmation = null }) {
  const input = confirmation ? { ...confirmation.payload.input } : parse(publicBookingSchema, body);
  const manifest = confirmation ? confirmation.payload.manifest : manifestFields(body);
  if (!confirmation) input.customerPhone = verifiedPhoneFor(input);
  // Only a page on the partner's registered website survives this; what is
  // kept with a held booking is the checked address, never the browser's.
  if (!confirmation) input.pageUrl = (await partnerPageFor(pool, input.refCode, input.pageUrl)) || undefined;
  // Reservation integrity (catalogue_v2): the form's signals, reduced at once
  // (a hash, a /24, a country code) and kept with a held booking.
  const signals = confirmation ? (confirmation.payload.signals || null) : reduceSignals({
    ip: req.ip, phone: input.customerPhone, device: { userAgent: req.get("user-agent"), language: req.get("accept-language"), hint: input.deviceHint },
  });
  delete input.turnstileToken;
  delete input.phoneToken;
  delete input.deviceHint;
  const hold = !confirmation && await holdForConfirmation(pool);
  const result = await withTransaction(async (c) => {
    // Numbered departures (catalogue_v2): the whole party goes to the
    // lowest-numbered departure of the date that has room for it, and a further
    // departure is opened when none has. A "Join my group" party moves together.
    const routed = catalogueV2Enabled() ? await routeBooking(c, { departureId, seats: input.seats, partyToken: input.partyToken }) : null;
    const dep = await loadDeparture(c, routed ? routed.departureId : departureId, { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    // Two clicks on the same link must make one booking: the held booking is
    // locked after the date, and made only while still unconfirmed.
    if (confirmation) {
      const still = (await c.query("SELECT status FROM booking_confirmations WHERE id = $1 FOR UPDATE", [confirmation.id])).rows[0];
      if (still?.status !== "unconfirmed") throw Object.assign(new AppError(409, "This booking is already confirmed."), { alreadyConfirmed: true });
    }
    // S04 — one live booking per verified number per date. A double-click or a
    // retried request used to make two; a party books its seats in one.
    if (phoneVerificationEnabled() && dep.pledges.some((p) => p.status !== "cancelled" && p.customerPhone === input.customerPhone)) {
      throw new AppError(409, "This phone number already holds a booking on this date. Check your email for its booking code, or reply to it to change the number of seats.");
    }
    if (dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (dep.mergedIntoId) throw Object.assign(new AppError(409, "This date was joined with another listing of the same tour and day. Book on that one."), { mergedIntoId: dep.mergedIntoId });
    if (dep.status === "pending_review") throw new AppError(409, "This departure is awaiting review and not open for bookings yet.");
    // Group bookings: a booking made through a "Join my group" link joins that
    // party. The party is locked first, so two members joining at once can't
    // both take the last free seats.
    const party = catalogueV2Enabled() && input.partyToken ? await partyToJoin(c, { token: input.partyToken, departureId: dep.id }) : null;
    const free = dep.maxSeats - seatsTotal(dep.pledges) - await heldForWaitlist(c, dep.id);
    if (input.seats > free) {
      throw new AppError(409, party
        ? `Only ${Math.max(0, free)} seat${free === 1 ? " is" : "s are"} left on this date, so the group can't take ${input.seats} more.`
        : "This booking exceeds the remaining seats.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    if (bookingClosed(dep, product)) throw new AppError(409, "Bookings for this date have closed.");
    const catalogueCtx = await requireCompleteBooking(c, dep.id, manifest, input.seats, input.customerPhone);
    if (party && !catalogueCtx) throw new AppError(409, "Group links aren't available for this date.");
    if (hold) {
      // Every check passed: hold it for the traveler's confirmation. Nothing
      // is written to pledges, so it counts towards nothing yet.
      const held = await holdBooking(c, {
        departureId: dep.id, bookingCode: await uniqueBookingCode(c), email: input.customerEmail, seats: input.seats,
        payload: { input, manifest, ...(catalogueV2Enabled() ? { signals } : {}) },
      });
      return { held, departure: dep };
    }
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
      bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c),
      refCode: refCode || null,
      manifest,
      ...pricing,
    };
    await insertPledge(c, dep.id, booking);
    if (catalogueCtx) {
      // Model phase 4: pay at GoAhead. The traveler accepts the Terms here, so
      // the tier version in force now is the one this booking keeps.
      await fixBookingTerms(c, { pledgeId, by: "traveller" });
      // Model phase 5: the published EUR rate, and the current tier's price.
      await stampBookingPrice(c, { pledgeId });
      await payNowIfGoingAhead(c, pledgeId, catalogueCtx.departureId);
    }
    if (party) await joinParty(c, { partyId: party.id, pledgeId });
    if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId });
    // Reservation integrity (catalogue_v2, migration 057): a cluster of
    // single-seat reservations is flagged for staff; it never refuses anything.
    // A booking made from the email link carries the signals of the form it
    // was submitted from, reduced when it was held.
    let flag = null;
    if (catalogueCtx && catalogueV2Enabled() && await integrityAvailable(c)) {
      await recordSignals(c, { pledgeId, departureId: dep.id, seats: input.seats, signals, at: confirmation?.created_at || null });
      flag = await detectCluster(c, { pledgeId });
    }
    // The last seat of the last open departure of the date: open the next.
    if (catalogueCtx && catalogueV2Enabled()) await ensureOpenDeparture(c, dep.id);
    const departure = await loadDeparture(c, dep.id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]), payAtGoAhead: !!catalogueCtx, partyId: party?.id ?? null, flagId: flag?.id ?? null,
      routedTo: routed && routed.routed !== false ? { departureId: dep.id, no: routed.no ?? null, opened: !!routed.opened } : null };
  });
  if (result.held) {
    const d = result.departure;
    const code = result.held.row.booking_code;
    sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats, bookingCode: code,
      url: confirmLink(confirmBookingUrl(result.held.token), result.held.token, input.pageUrl),
    }), { pageUrl: input.pageUrl, bookingCode: code }));
    return { status: 202, audit: { action: "booking.hold", entity: "booking", entityId: code, detail: { departureId, seats: input.seats, source: "public" } }, json: {
      departure: presentDeparture(d, req.user), confirmationRequired: true,
      booking: { bookingCode: code, seats: input.seats, customers: input.customerName, status: "unconfirmed" },
    } };
  }
  const audit = { action: "booking.create", entity: "pledge", entityId: result.booking.id,
    detail: { departureId: result.departure.id, ...(result.routedTo && result.routedTo.departureId !== departureId ? { requestedDepartureId: departureId, departureNo: result.routedTo.no, opened: result.routedTo.opened } : {}), seats: input.seats, source: "public", ...(result.partyId ? { partyId: result.partyId } : {}),
      ...(confirmation ? { confirmedEmail: true } : {}), ...(result.flagId ? { flagId: result.flagId } : {}) } };
  await rememberPartnerPage(pool, result.booking.bookingCode, input.pageUrl);
  const partnerLinks = { pageUrl: input.pageUrl, bookingCode: result.booking.bookingCode };
  const flagAudit = result.flagId ? { action: "booking_flag.raise", entity: "booking_flag", entityId: result.flagId, detail: { pledgeId: result.booking.id } } : null;
  if (input.customerEmail && result.payAtGoAhead) {
    // Model phase 4: nothing is paid until GoAhead, then the full price; the
    // email repeats the cancellation tiers this booking was made under.
    const d = result.departure;
    sendEmailInBackground(bookingPayView(pool, { pledgeId: result.booking.id }).then((view) => payAtGoAheadBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      total: result.booking.bookingTotal, bookingCode: result.booking.bookingCode, terms: view?.terms || null,
    })).then((m) => forPartner(input.refCode, m, partnerLinks)));
  } else if (input.customerEmail) {
    const d = result.departure;
    sendEmailInBackground(operatorFor(d.id).then((operator) => bookingConfirmationEmail({
      to: input.customerEmail, customerName: input.customerName, route: d.route,
      dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date, seats: input.seats,
      depositDue: result.booking.depositDue, balanceDue: result.booking.balanceDue,
      balanceDueDate: result.booking.balanceDueDate, bookingCode: result.booking.bookingCode,
      product: d, operator,
    })).then((m) => forPartner(input.refCode, m, partnerLinks)));
  }
  notifyOps(result.departure, result.booking, input, { isRequest: false });
  // The direct traveller gets their own booking receipt back in full.
  emitDepartureSync(result.departure.id);
  return { status: 201, audit, flagAudit, json: { departure: presentDeparture(result.departure, req.user), booking: result.booking,
    ...(result.routedTo ? { departureNo: result.routedTo.no } : {}) } };
}

// Platform staff remove a pledge outright. Agencies no longer come through
// here: this erases the row and stops only at supplier_confirmed, so an agency
// could walk a seat out of a GoAhead date for free. They use
// POST /api/agency/bookings/:pledgeId/cancel, which follows the Terms.
app.delete("/api/departures/:id/pledges/:pledgeId", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
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

// Agency cancels one of its own bookings (or withdraws a date request) from the
// portal's "My bookings".
//
// The DELETE route above predates this and is not what the portal offers: it
// erases the row, so the booking vanishes from the agency's own list and from
// ops' records, and it lets a seat walk out of a date that has reached GoAhead
// for free. This follows the traveller's cancel link instead
// (POST /api/public/bookings/:code/cancel): the pledge is marked `cancelled`, the
// seat is released, and the Terms' boundary is the same — before GoAhead or
// while the date is still under review, free and self-serve; after it, §13.2's
// schedule applies and that goes through Sawa.
//
// Idempotent, like the traveller's route: a double click answers 200.
app.post("/api/agency/bookings/:pledgeId/cancel", requireAuth, requireRole("agency_owner", "agency_agent"), writeLimiter, h(async (req, res) => {
  const pledgeId = String(req.params.pledgeId || "").trim();
  if (!pledgeId) throw new AppError(422, "Booking id required.");

  const result = await withTransaction(async (c) => {
    const found = await c.query(
      `SELECT id, status, departure_id, agency_id FROM pledges WHERE id = $1`,
      [pledgeId]
    );
    // Another agency's booking answers exactly like a missing one — its
    // existence is not this agency's business.
    if (!found.rows.length || found.rows[0].agency_id !== req.user.agencyId) {
      throw new AppError(404, "Booking not found.");
    }
    const pledge = found.rows[0];

    const dep = await loadDeparture(c, pledge.departure_id, { forUpdate: true });
    if (!dep) throw new AppError(404, "Booking not found.");

    const view = bookingLookupView({
      departureStatus: dep.status,
      pledgeStatus: pledge.status,
      seatsBooked: seatsTotal(dep.pledges),
      goAhead: goAheadSeatsFor(dep),
    });
    if (view.state === "booking_cancelled" || view.state === "date_cancelled") {
      return { alreadyDone: true, departureId: dep.id };
    }
    if (!view.canCancel) {
      throw new AppError(409,
        "This date has reached GoAhead, so Sawa's cancellation schedule applies — see section 13 of the Terms. "
        + "Email hello@sawa.tours with the booking and we'll take it from there.");
    }

    await c.query(`UPDATE pledges SET status='cancelled' WHERE id=$1`, [pledge.id]);
    // Model phase 3: a traveler's own cancellation (before GoAhead: no fee).
    if (catalogueV2Enabled()) {
      await c.query(`UPDATE pledges SET cancelled_at = now(), cancelled_reason = 'traveler' WHERE id = $1`, [pledge.id]);
      // Canceled before GoAhead, so before any payment: nothing is owed for it.
      await releaseUnpaidAgencyBookings(c, { pledgeIds: [pledge.id] });
    }
    await refreshStatus(c, dep.id);
    return { alreadyDone: false, departureId: dep.id };
  });

  if (!result.alreadyDone) {
    emitDepartureSync(result.departureId);
    await logAudit(req, {
      action: "booking.cancel", entity: "pledge", entityId: pledgeId,
      detail: { departureId: result.departureId, source: "agency" },
    });
  }
  res.json({ cancelled: true });
}));

// S02 — `DELETE /api/public/departures/:id/bookings/:pledgeId` is gone. It took
// no credential but the pledge id, and the anonymous catalogue published every
// pledge id, so any visitor could cancel any traveller's booking; it also
// erased the row and ignored the GoAhead boundary. A traveller cancels with
// their booking code: POST /api/public/bookings/:code/cancel below.

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
    `SELECT p.id AS pledge_id, p.booking_code, p.seats, p.status AS pledge_status,
            p.booking_total, p.deposit_due, p.balance_due, p.balance_due_date,
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
  if (!r.rows.length) {
    const held = await heldByCode(pool, code);
    if (!held) throw new AppError(404, "Booking not found.");
    return res.json({ booking: await heldBookingView(held) });
  }
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

  // 043 — where payment stands, and the open link if there is one: the same
  // link the traveller was emailed, reached with the same booking code.
  let payment = null;
  try {
    const rows = (await paymentsByPledge(pool, [b.pledge_id])).get(b.pledge_id) || [];
    const s = paymentSummary({
      pledge: {
        status: b.pledge_status, bookingTotal: b.booking_total != null ? Number(b.booking_total) : 0,
        depositDue: b.deposit_due != null ? Number(b.deposit_due) : 0, balanceDueDate: isoDate(b.balance_due_date),
      },
      payments: rows, goAhead: ["minimum_reached", "supplier_confirmed"].includes(b.dep_status),
    });
    payment = {
      stage: s.stage, label: STAGE_LABEL[s.stage], paid: s.paid, outstanding: s.outstanding, total: s.total,
      open: s.open ? { kind: s.open.kind, amount: s.open.amount, dueAt: s.open.dueAt, linkUrl: s.open.linkUrl, overdue: s.open.overdue } : null,
    };
  } catch (e) {
    if (!isMissingPaymentsTable(e)) throw e;
  }

  // Model phase 4: a pay-at-GoAhead booking shows its full-price request and
  // the cancellation terms it was made under (an agency's traveler accepts
  // that same version here).
  let payAtGoAhead = null;
  if (catalogueV2Enabled()) {
    try {
      payAtGoAhead = await bookingPayView(pool, { pledgeId: b.pledge_id });
    } catch (e) {
      if (e?.code !== "42P01" && e?.code !== "42703") throw e;
    }
  }

  // Group bookings: the booking's "Join my group" link, once it has one, and
  // whether it can start one.
  let group = null;
  if (catalogueV2Enabled() && payAtGoAhead && b.pledge_status !== "cancelled") {
    const party = await partyForBooking(pool, b.pledge_id);
    // Shared from a partner's page, the link brings friends to that page.
    if (party?.url) party.url = await partnerJoinUrl(pool, b.booking_code, party.url);
    group = party || (JOINABLE_STATUSES.includes(b.dep_status) && await partiesAvailable(pool) ? { url: null } : null);
  }

  // "Nothing was charged" isn't true of a pay-at-GoAhead booking canceled
  // after it paid, and a released seat has its own reason.
  const payReq = payAtGoAhead?.request;
  if (view.state === "booking_cancelled" && payReq?.state === "paid") {
    view.note = "This booking was canceled. Any refund due under your cancellation terms is made to the card you paid with.";
  } else if (view.state === "booking_cancelled" && payReq?.state === "released") {
    view.note = "This seat was released because payment wasn't received by the deadline. Nothing was charged.";
  }

  res.json({ booking: {
    code: b.booking_code,
    tourTitle: b.product_title || b.route,
    payment: payAtGoAhead ? null : payment,
    payAtGoAhead,
    group,
    city: b.city || "",
    dateLabel,
    seats: Number(b.seats),
    seatsBooked,
    goAhead,
    routePath,
    ...view,
  } });
}));

// A booking held for email confirmation (058), as the booking page shows it.
// It isn't a booking yet, so it shows no seat count and no payment.
const HELD_VIEW = {
  unconfirmed: { statusLabel: "Waiting for your confirmation", statusTone: "pending",
    note: "Check your email to confirm your booking. It's made when you click the link, and lapses if it isn't confirmed within 24 hours." },
  expired: { statusLabel: "Not confirmed", statusTone: "cancelled",
    note: "This booking wasn't confirmed within 24 hours, so it lapsed. Nothing was charged. You can book again while places remain." },
  cancelled: { statusLabel: "Canceled", statusTone: "cancelled", note: "This booking was canceled before it was confirmed. Nothing was charged." },
  refused: { statusLabel: "Not booked", statusTone: "cancelled", note: "We couldn't make this booking when it was confirmed. Nothing was charged." },
};
async function heldBookingView(held, now = Date.now()) {
  const state = isExpired(held, now) ? "expired" : held.status;
  const d = held.departure_id != null ? (await pool.query(
    `SELECT d.route, d.date, d.start_date, d.city, tp.title FROM departures d LEFT JOIN tour_products tp ON tp.id = d.tour_product_id WHERE d.id = $1`,
    [held.departure_id])).rows[0] || {}
    // A date request for a new day (060): the tour and the day asked for.
    : { ...((await pool.query("SELECT title, city FROM tour_products WHERE id = $1", [held.tour_product_id])).rows[0] || {}), date: held.request_date };
  const day = d.start_date || d.date;
  const dateLabel = day ? new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${isoDate(day)}T12:00:00Z`)) : "";
  const v = HELD_VIEW[state] || HELD_VIEW.unconfirmed;
  return {
    code: held.booking_code, tourTitle: d.title || d.route || "", city: d.city || "", dateLabel, seats: Number(held.seats),
    state: `held_${state}`, ...v, ...(state === "refused" && held.refused_reason ? { note: `${v.note} ${held.refused_reason}` } : {}),
    confirmed: false, showProgress: false, canCancel: state === "unconfirmed",
    confirmation: { state, resendsLeft: state === "unconfirmed" ? Math.max(0, MAX_RESENDS - Number(held.resends)) : 0 },
  };
}

// The "Confirm my booking" link (058). A POST, made by the page behind the
// link, so a mail client that prefetches links can't confirm for anyone. The
// booking is made now, through the same checks as the booking form.
app.post("/api/public/booking-confirmations/:token", writeLimiter, h(async (req, res) => {
  const held = await heldByToken(pool, String(req.params.token || ""));
  if (!held) throw new AppError(404, "This link isn't valid. If you asked for a new email, use the link in the newest one.");
  if (held.status === "confirmed") return res.json({ state: "already", code: held.booking_code });
  if (held.status !== "unconfirmed" || isExpired(held)) return res.json({ state: isExpired(held) ? "expired" : held.status, code: held.booking_code });
  if (held.kind === "date_request") return confirmHeldDateRequest(req, res, held);
  let out;
  try {
    out = await placePublicBooking(req, { departureId: Number(held.departure_id), confirmation: held });
  } catch (e) {
    if (e?.alreadyConfirmed) return res.json({ state: "already", code: held.booking_code });
    if (!(e?.status >= 400 && e.status < 500)) throw e;
    // The date changed while the booking waited (full, closed, canceled).
    await markRefused(pool, { id: held.id, reason: e.message });
    await logAudit(req, { action: "booking.hold_refused", entity: "booking", entityId: held.booking_code, detail: { reason: e.message } });
    return res.status(409).json({ state: "refused", code: held.booking_code, error: `We couldn't make this booking: ${e.message} Nothing was charged.` });
  }
  await logAudit(req, out.audit);
  if (out.flagAudit) await logAudit(req, out.flagAudit);
  await logAudit(req, { action: "booking.email_confirmed", entity: "pledge", entityId: out.json.booking.id, detail: { bookingCode: held.booking_code } });
  res.json({ state: "confirmed", code: held.booking_code });
}));

// A held date request (060), confirmed: made now through createDateRequest's
// checks. A group that formed on that day meanwhile is not joined silently:
// the traveler is sent to book on it.
async function confirmHeldDateRequest(req, res, held) {
  const input = { ...(held.payload?.input || {}), ignoreMatches: true };
  const refuse = async (reason) => {
    await markRefused(pool, { id: held.id, reason });
    await logAudit(req, { action: "departure_request.hold_refused", entity: "booking", entityId: held.booking_code, detail: { reason } });
    return res.status(409).json({ state: "refused", code: held.booking_code, error: `We couldn't make this request: ${reason} Nothing was charged.` });
  };
  let result;
  try {
    result = await createDateRequest(input, req, {}, { confirmation: held });
  } catch (e) {
    if (e?.alreadyConfirmed) return res.json({ state: "already", code: held.booking_code });
    if (!(e?.status >= 400 && e.status < 500)) throw e;
    return refuse(e.message);
  }
  if (result.exactDay) return refuse("A group formed on that day while your request waited. Book a place on it from the tour page.");
  await announceDateRequest(req, input, result, { confirmedEmail: true });
  await logAudit(req, { action: "booking.email_confirmed", entity: "pledge", entityId: result.booking.id, detail: { bookingCode: held.booking_code, dateRequest: true } });
  res.json({ state: "confirmed", code: held.booking_code });
}

// Send the confirmation email again: a new link, at most 3 times.
app.post("/api/public/bookings/:code/resend-confirmation", writeLimiter, h(async (req, res) => {
  const code = String(req.params.code || "").trim();
  const r = await resendLink(pool, { code });
  if (r.error === 404) throw new AppError(404, "Booking not found.");
  if (r.error === 409) throw new AppError(409, "This booking isn't waiting for confirmation any more.");
  if (r.error === 429) throw new AppError(429, `The confirmation email has already been sent again ${MAX_RESENDS} times. Email hello@sawa.tours and we'll confirm it for you.`);
  const d = r.row.departure_id != null
    ? (await pool.query("SELECT route, date, start_date, end_date FROM departures WHERE id = $1", [r.row.departure_id])).rows[0] || {}
    : { route: (await pool.query("SELECT title FROM tour_products WHERE id = $1", [r.row.tour_product_id])).rows[0]?.title, date: r.row.request_date };
  const input = r.row.payload?.input || {};
  sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
    to: r.row.email, customerName: input.customerName, route: d.route,
    dateLabel: d.start_date ? `${isoDate(d.start_date)} – ${isoDate(d.end_date)}` : isoDate(d.date), seats: Number(r.row.seats),
    bookingCode: r.row.booking_code, url: confirmLink(confirmBookingUrl(r.token), r.token, input.pageUrl), dateRequest: r.row.kind === "date_request",
  }), { pageUrl: input.pageUrl, bookingCode: r.row.booking_code }));
  await logAudit(req, { action: "booking.hold_resend", entity: "booking", entityId: r.row.booking_code, detail: { resends: r.row.resends } });
  res.json({ sent: true, resendsLeft: Math.max(0, MAX_RESENDS - r.row.resends) });
}));

// Model phase 4: the traveler of an agency booking accepts the cancellation
// terms the agency booked under (never the current ones). The version id is
// the one the booking page showed; any other is refused.
app.post("/api/public/bookings/:code/accept-terms", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const result = await acceptBookingTerms(pool, { code, versionId: req.body?.versionId });
  await logAudit(req, { action: "booking.accept_terms", entity: "booking", entityId: code.toUpperCase(), detail: { tierVersionId: result.versionId } });
  res.json(result);
}));

// Group bookings: the booking's "Join my group" link. The first request starts
// the party with this booking as its lead; later ones return the same link.
app.post("/api/public/bookings/:code/party", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const link = await partyLinkFor(pool, { code });
  await logAudit(req, { action: link.created ? "party.create" : "party.link_view", entity: "party", entityId: link.partyId, detail: { bookingCode: code.toUpperCase() } });
  res.json({ group: { url: await partnerJoinUrl(pool, code, link.url), seatsLeft: link.seatsLeft } });
}));

// What a "Join my group" link shows: the date, the lead's first name and the
// seats left. Booking goes through the ordinary booking route with the token.
app.get("/api/public/parties/:token", h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const v = await partyView(pool, { token: String(req.params.token || "") });
  const dep = await loadDeparture(pool, v.departureId);
  const product = dep?.tourProductId ? await loadProduct(pool, dep.tourProductId) : null;
  const closed = !dep || !JOINABLE_STATUSES.includes(dep.status) || bookingClosed(dep, product);
  res.json({
    group: { leadFirstName: v.leadFirstName, seats: v.groupSeats },
    departure: dep ? {
      id: dep.id, title: product?.title || dep.route, city: dep.city || "", date: dep.startDate || dep.date, endDate: dep.endDate || null,
      path: product ? tourPath(product) : null,
    } : null,
    seatsLeft: closed ? 0 : v.seatsLeft,
    bookable: !closed && v.seatsLeft > 0,
  });
}));

// The seller changed after the traveler paid (the first operator failed and
// Sawa reassigned): for 48 hours the traveler may cancel with a full refund.
// The booking code is the credential, as for the terms above.
app.post("/api/public/bookings/:code/seller-change/cancel", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const code = String(req.params.code || "").trim();
  if (!code) throw new AppError(422, "Booking code required.");
  const result = await acceptSellerChangeOffer(pool, { code, by: "traveler", send: sendEmail });
  await logAudit(req, { action: "booking.seller_change_cancel", entity: "booking", entityId: code.toUpperCase(),
    detail: { offerId: result.offerId, refundEur: result.refund, paidEur: result.paid } });
  res.json({ canceled: true, refundEur: result.refund, refund: result.refundRecord });
}));

// Model phase 4: the waitlist for a full departure, and the offer a waiting
// traveler gets when a seat is released.
const waitlistSchema = z.object({
  name: z.string().trim().min(1, "Your name is required.").max(160),
  email: z.string().trim().email("A valid email is required.").max(200),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  seats: z.coerce.number().int().min(1).max(MAX_GROUP_SIZE),
});
app.post("/api/public/departures/:id/waitlist", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const input = parse(waitlistSchema, req.body);
  const entry = await joinWaitlist(pool, {
    legacyDepartureId: Number(req.params.id), name: input.name, email: input.email, phone: input.phone || null, seats: input.seats,
  });
  await logAudit(req, { action: "waitlist.join", entity: "departure", entityId: Number(req.params.id), detail: { seats: input.seats, position: entry.position } });
  res.status(201).json({ waitlist: { position: entry.position, seats: entry.seats } });
}));

app.get("/api/public/waitlist/:token", h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  res.json(await waitlistOffer(pool, { token: String(req.params.token || "") }));
}));

// The waiting traveler books the held seats. The departure is going ahead, so
// the booking is asked to pay at once; a seat freed by a paid cancellation is
// resold, and that traveler's retained fee is returned.
app.post("/api/public/waitlist/:token/book", writeLimiter, h(async (req, res) => {
  if (!catalogueV2Enabled()) throw new AppError(404, "Not found.");
  const manifest = manifestFields(req.body);
  const result = await withTransaction(async (c) => {
    const { entry, departure: cat } = await claimWaitlistOffer(c, { token: String(req.params.token || "") });
    const dep = await loadDeparture(c, cat.legacyDepartureId, { forUpdate: true });
    if (!dep || dep.status === "cancelled") throw new AppError(409, "This departure has been canceled.");
    if (seatsTotal(dep.pledges) + await heldForWaitlist(c, dep.id, entry.seats) + entry.seats > dep.maxSeats) {
      throw new AppError(409, "The held seats are no longer available. Please contact us.");
    }
    const product = dep.tourProductId ? await loadProduct(c, dep.tourProductId) : null;
    const phone = String(req.body?.customerPhone || entry.phone || "").trim() || null;
    await requireCompleteBooking(c, dep.id, manifest, entry.seats, phone);
    const pricing = computePledgePricing(dep, product, { seats: entry.seats, roomingType: req.body?.roomingType, accommodationTier: req.body?.accommodationTier });
    const pledgeId = newPledgeId(dep.id);
    await insertPledge(c, dep.id, {
      id: pledgeId, agencyId: "direct_customer", agency: "Direct traveler", seats: entry.seats, customers: entry.name,
      customerEmail: entry.email, customerPhone: phone, source: "public", bookingCode: await uniqueBookingCode(c), manifest, ...pricing,
    });
    await fixBookingTerms(c, { pledgeId, by: "traveller" });
    await stampBookingPrice(c, { pledgeId });
    const done = await completeWaitlistOffer(c, { entryId: entry.id, pledgeId, departure: cat });
    const saved = (await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId])).rows[0];
    return { booking: mapPledge(saved), departureId: dep.id, request: done.request };
  });
  await logAudit(req, { action: "waitlist.book", entity: "pledge", entityId: result.booking.id, detail: { departureId: result.departureId } });
  emitDepartureSync(result.departureId);
  res.status(201).json({ booking: { code: result.booking.bookingCode, seats: result.booking.seats } });
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
  // A booking still waiting for its email confirmation (058) isn't in
  // pledges yet: canceling it just drops the hold.
  const held = await heldByCode(pool, code);
  if (held && !held.pledge_id) {
    if (await cancelHeld(pool, { code })) {
      await logAudit(req, { action: "booking.hold_cancel", entity: "booking", entityId: held.booking_code });
    }
    return res.json({ cancelled: true });
  }

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
    if (catalogueV2Enabled()) {
      await c.query(`UPDATE pledges SET cancelled_at = now(), cancelled_reason = 'traveler' WHERE id = $1`, [pledge.id]);
      // A widget booking belongs to an agency: canceled before payment, nothing is owed for it.
      await releaseUnpaidAgencyBookings(c, { pledgeIds: [pledge.id] });
    }
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

// E01 — the <head> facts for a route, for the SPA to apply after a client-side
// navigation. The same buildHead() the server renders pages with, so a title
// can't differ between a direct load and a click. Only paths that buildHead
// serves; portal, API and static /site pages never reach here.
app.get("/api/public/route-head", h(async (req, res) => {
  const path = String(req.query.path || "");
  if (!/^\/[A-Za-z0-9\-/_.%]*$/.test(path) || path.length > 300 || /^\/(api|admin|agency|portal|embed)(\/|$)/.test(path)) {
    throw new AppError(422, "Invalid path.");
  }
  const { meta, notFound } = await buildHead(path);
  res.set("Cache-Control", path.startsWith("/blog") ? "no-store" : "public, max-age=60, s-maxage=300");
  res.json({ ...meta, notFound });
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
// A new date, started by someone outside Sawa — a traveller on the public site
// or an operator from their dashboard. Both go through the same rules (window,
// operating days, blackouts, join-first) and land in the same place: a
// `pending_review` date with one `pending` booking, waiting on Date requests.
// Returns { nearMatches } when open dates already exist close by.
//
// A traveler's request is held for email confirmation (migration 060) with
// `hold`: every check below runs, then nothing is written but the held
// request. The "Confirm my booking" link replays it with `confirmation`,
// through the same checks, keeping its booking code.
async function createDateRequest(input, req, requester = {}, { hold = false, confirmation = null } = {}) {

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const picked = new Date(`${input.date}T12:00:00`);
  if (isNaN(picked)) throw new AppError(422, "A valid date is required.");
  const daysOut = Math.round((picked - today) / 86400000);
  // The window is checked INSIDE the transaction below, once the product is
  // loaded — it is per product now, and this ran before anything knew which
  // tour was being requested.

  // Operator blackouts (Autoura capacity feed): the weekly pattern may allow
  // this weekday, but not THIS date if the operation is dark. Checked before
  // the transaction — it may involve an HTTP fetch (cached 10 min).
  const blocked = await unavailableDates();
  if (blocked.has(input.date)) {
    throw new AppError(422, "That day isn't available operationally — please pick another date.");
  }

  return withTransaction(async (c) => {
    // Two clicks on the same link make one request.
    if (confirmation) {
      const still = (await c.query("SELECT status FROM booking_confirmations WHERE id = $1 FOR UPDATE", [confirmation.id])).rows[0];
      if (still?.status !== "unconfirmed") throw Object.assign(new AppError(409, "This booking is already confirmed."), { alreadyConfirmed: true });
    }
    const holdRequest = async (departureId) => ({
      product,
      held: await holdBooking(c, {
        kind: "date_request", departureId, tourProductId: product.id, requestDate: input.date,
        bookingCode: await uniqueBookingCode(c), email: input.customerEmail, seats: input.seats, payload: { input },
      }),
    });
    const product = await loadProduct(c, input.tourProductId);
    if (!product || product.active === false || product.status !== "approved") {
      throw new AppError(404, "Tour not found.");
    }

    // The request window, per product. A Nile cruise sold six months ahead and a
    // Cairo day tour sold three weeks ahead want different answers, and until
    // now both got 3/90 from a constant.
    const minLead = minLeadDaysFor(product);
    const maxHorizon = maxHorizonDaysFor(product);
    if (daysOut < minLead) {
      throw new AppError(422, `${product.title} needs at least ${minLead} day${minLead === 1 ? "" : "s"} of notice.`);
    }
    if (daysOut > maxHorizon) {
      throw new AppError(422, `${product.title} can be requested up to ${maxHorizon} days ahead.`);
    }

    // Operating days: a Nile cruise that sails Mondays must not accept a
    // Tuesday request, whatever the client sent. One rule, in shared/, so the
    // admin route below and the date picker cannot drift from this one.
    const dayProblem = operatingDayError(product, input.date);
    if (dayProblem) throw new AppError(422, dayProblem);

    // F02 — the new date is created with the product's maxSeats, so the request
    // that seeds it cannot be bigger. The schema allowed 20 against a 12-seat
    // ceiling (and less on smaller tours), leaving an over-capacity date behind.
    const capacity = Number(product.maxSeats);
    if (Number.isFinite(capacity) && capacity > 0 && input.seats > capacity) {
      throw new AppError(422, `${product.title} takes up to ${capacity} traveler${capacity === 1 ? "" : "s"} per date.`);
    }

    // Same tour, same day (27 Sep 2026): eleven travelers of one group booked
    // the same tour and day separately, and each made a new date — the check
    // below saw only `open` dates, so a date still in review (or already going
    // ahead) was invisible, and the traveler could always press "request my
    // date anyway". An exact day now joins the date that exists, whatever the
    // traveler chose:
    //   - a date awaiting review: this booking joins the request (pending, like
    //     the first), and is approved or declined with it;
    //   - an open or going-ahead date: 409 exact_day, and the client books it
    //     through the normal booking route (its checks, pricing and emails).
    // Only when every such date is full is a second date for that day made.
    // Two requests for the same new day at the same moment: FOR UPDATE below
    // locks rows that exist, and a day with no date yet has none, so both
    // would insert one. Serialize on the tour and day instead; the second
    // request waits, then sees the first one's date and joins it.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('departure-day'), hashtext($1::text || ':' || $2::text))", [product.id, input.date]);
    const merged = (await c.query("SELECT to_regclass('public.departure_merges') AS t")).rows[0].t != null;
    const sameDay = await c.query(
      `SELECT id, status FROM departures
        WHERE tour_product_id = $1 AND COALESCE(start_date, date) = $2::date
          AND status IN ('pending_review', 'open', 'minimum_reached', 'supplier_confirmed')
          ${merged ? "AND merged_into_id IS NULL" : ""}
        ORDER BY (status = 'pending_review'), id FOR UPDATE`,
      [product.id, input.date]);
    const bookable = [];
    for (const row of sameDay.rows) {
      const d = await loadDeparture(c, row.id);
      if (!d || seatsTotal(d.pledges) + input.seats > d.maxSeats) continue;
      if (d.status === "pending_review") {
        if (bookable.length) continue;
        if (hold) return holdRequest(d.id);
        const joinPricing = computePledgePricing(d, product, input);
        const joinRef = requester.agencyId ? "" : cleanRefCode(input.refCode);
        if (joinRef) await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [joinRef]);
        const joinId = newPledgeId(d.id);
        await insertPledge(c, d.id, {
          id: joinId,
          agencyId: requester.agencyId || "direct_customer",
          agency: requester.agencyName || "Direct traveler",
          seats: input.seats, customers: input.customerName, customerEmail: input.customerEmail,
          customerPhone: input.customerPhone || null,
          source: requester.agencyId ? "agency_request" : "public_request",
          createdByUserId: requester.userId || null,
          bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c), refCode: joinRef || null,
          ...joinPricing, status: "pending",
        });
        if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId: joinId });
        const joined = await loadDeparture(c, d.id);
        const savedJoin = await c.query(`SELECT * FROM pledges WHERE id=$1`, [joinId]);
        return { departure: joined, booking: mapPledge(savedJoin.rows[0]), joinedRequest: true };
      }
      bookable.push(presentDeparture(d, req.user));
    }
    if (bookable.length) return { exactDay: bookable };

    // Join-first rule: surface bookable departures for the same tour within
    // the match window. The client may reject these near dates (ignoreMatches)
    // — a different day is a real choice — but never the same day (above).
    if (!input.ignoreMatches) {
      const win = await c.query(
        `SELECT id FROM departures
         WHERE tour_product_id = $1 AND status IN ('open', 'minimum_reached', 'supplier_confirmed')
           AND COALESCE(start_date, date) BETWEEN ($2::date - $3::int) AND ($2::date + $3::int)
           ${merged ? "AND merged_into_id IS NULL" : ""}
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

    if (hold) return holdRequest(null);
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
         quality, status, notes, deposit_percent, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,'pending_review',$20,$21,$22)`,
      [
        id, product.type, product.id, product.title, input.date,
        isPkg ? input.date : null, isPkg ? endDate : null, isPkg ? product.nights : null,
        isPkg ? JSON.stringify(product.cities || []) : null, product.defaultTime,
        product.city, product.guide, product.vehicle,
        Number(product.minSeats), Number(product.maxSeats),
        Number(product.baseCost || 0), Number(product.publishedRate),
        Number(product.breakPrice || Math.round(product.publishedRate * 0.8)),
        product.quality,
        requester.agencyId
          ? `Operator request (${requester.agencyName})${input.note ? `: ${input.note}` : " awaiting review."}`
          : input.note ? `Traveler request: ${input.note}` : "Traveler-requested date awaiting review.",
        Number(product.depositPercent || defaultDepositFor(product)),
        requester.agencyId ? "agency" : "traveler",
      ]
    );

    const dep = await loadDeparture(c, id);
    const pricing = computePledgePricing(dep, product, input);
    // A traveller's request made through a partner's widget is credited to
    // that partner, the same as a booking on an existing date. An operator's
    // own request is theirs already and carries no code.
    const refCode = requester.agencyId ? "" : cleanRefCode(input.refCode);
    if (refCode) await c.query("INSERT INTO referrals (code) VALUES ($1) ON CONFLICT (code) DO NOTHING", [refCode]);
    const pledgeId = newPledgeId(id);
    await insertPledge(c, id, {
      id: pledgeId,
      agencyId: requester.agencyId || "direct_customer",
      agency: requester.agencyName || "Direct traveler",
      seats: input.seats,
      customers: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone || null,
      source: requester.agencyId ? "agency_request" : "public_request",
      createdByUserId: requester.userId || null,
      bookingCode: confirmation ? confirmation.booking_code : await uniqueBookingCode(c),
      refCode: refCode || null,
      ...pricing,
      // Nobody has approved this date yet, so the booking is not confirmed
      // either. It still holds its seats (every count reads `<> 'cancelled'`);
      // approve moves it to `confirmed`, decline to `cancelled`. Before this it
      // took the column default and every request read "confirmed" in admin.
      status: "pending",
    });
    if (confirmation) await markConfirmed(c, { id: confirmation.id, pledgeId });
    const departure = await loadDeparture(c, id);
    const saved = await c.query(`SELECT * FROM pledges WHERE id=$1`, [pledgeId]);
    return { departure, booking: mapPledge(saved.rows[0]) };
  });
}

app.post("/api/public/departure-requests", writeLimiter, bookingAttemptLimiter, h(async (req, res) => {
  await requireTurnstile(req);
  const input = parse(publicDepartureRequestSchema, req.body);
  input.pageUrl = (await partnerPageFor(pool, input.refCode, input.pageUrl)) || undefined;
  input.customerPhone = verifiedPhoneFor(input);
  delete input.turnstileToken;
  delete input.phoneToken;
  const hold = await holdForConfirmation(pool) && await dateRequestHoldAvailable(pool);
  const result = await createDateRequest(input, req, {}, { hold });

  if (result.exactDay) {
    // The same tour already runs that day: book on it, never beside it.
    return res.status(409).json({
      error: "This tour already has a group on that day. Join it instead.",
      code: "near_matches", exactDay: true,
      nearMatches: result.exactDay,
    });
  }
  if (result.nearMatches) {
    // Not an error for the traveler — the UI offers these to join instead.
    return res.status(409).json({
      error: "Open departures already exist near this date.",
      code: "near_matches",
      nearMatches: result.nearMatches,
    });
  }
  if (result.held) {
    // Held until the traveler confirms their email (060): not a request yet.
    const code = result.held.row.booking_code;
    sendEmailInBackground(forPartner(input.refCode, confirmBookingEmail({
      to: input.customerEmail, customerName: input.customerName, route: result.product.title,
      dateLabel: input.date, seats: input.seats, bookingCode: code,
      url: confirmLink(confirmBookingUrl(result.held.token), result.held.token, input.pageUrl), dateRequest: true,
    }), { pageUrl: input.pageUrl, bookingCode: code }));
    await logAudit(req, { action: "departure_request.hold", entity: "booking", entityId: code,
      detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "public", joins: result.held.row.departure_id ?? null } });
    return res.status(202).json({ confirmationRequired: true, booking: { bookingCode: code, seats: input.seats, customers: input.customerName, status: "unconfirmed" } });
  }
  await announceDateRequest(req, input, result);
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// A traveler's request is made (at once, or from its confirmation link): the
// audit line, the traveler's "request received" email, and ops.
async function announceDateRequest(req, input, result, { confirmedEmail = false } = {}) {
  await logAudit(req, {
    action: result.joinedRequest ? "departure_request.join" : "departure_request.create", entity: "departure", entityId: String(result.departure.id),
    detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "public", joinedExisting: !!result.joinedRequest, ...(confirmedEmail ? { confirmedEmail: true } : {}) },
  });
  const d = result.departure;
  sendEmailInBackground(forPartner(input.refCode, departureRequestReceivedEmail({
    to: input.customerEmail, customerName: input.customerName, route: d.route,
    dateLabel: d.startDate ? `${d.startDate} – ${d.endDate}` : d.date,
    seats: input.seats, bookingCode: result.booking.bookingCode,
  }), { pageUrl: input.pageUrl, bookingCode: result.booking.bookingCode }));
  await rememberPartnerPage(pool, result.booking.bookingCode, input.pageUrl);
  notifyOps(d, result.booking, input, { isRequest: true });
}

// An operator requests a new date from their dashboard. Until 24 Sep 2026 an
// operator could only join dates Sawa had already published; a tour with none
// was greyed out. The old POST /api/departures, which opened a date directly
// with placeholder values and no review, is gone — this is the only way in.
app.post("/api/agency/departure-requests", requireAuth, requireRole("agency_owner", "agency_agent"), writeLimiter, h(async (req, res) => {
  const body = parse(agencyDepartureRequestSchema, req.body);
  if (!req.user.agencyId) throw new AppError(403, "Your account is not linked to an agency.");
  const agency = (await pool.query(`SELECT id, name FROM agencies WHERE id=$1`, [req.user.agencyId])).rows[0];
  if (!agency) throw new AppError(403, "Your account is not linked to an agency.");
  const input = { ...body, customerName: (body.customers || "Customer details pending").trim() };
  const result = await createDateRequest(input, req, { agencyId: agency.id, agencyName: agency.name, userId: req.user.id });

  if (result.exactDay) {
    return res.status(409).json({
      error: "This tour already has a date on that day. Join it instead.",
      code: "near_matches", exactDay: true,
      nearMatches: result.exactDay,
    });
  }
  if (result.nearMatches) {
    return res.status(409).json({
      error: "Open departures already exist near this date.",
      code: "near_matches",
      nearMatches: result.nearMatches,
    });
  }
  await logAudit(req, {
    action: result.joinedRequest ? "departure_request.join" : "departure_request.create", entity: "departure", entityId: String(result.departure.id),
    detail: { tourProductId: input.tourProductId, date: input.date, seats: input.seats, source: "agency", agencyId: agency.id, joinedExisting: !!result.joinedRequest },
  });
  // Sawa's own customers are emailed by Sawa; an operator's customer is the
  // operator's to tell. Ops is told either way.
  notifyOps(result.departure, result.booking, input, { isRequest: true, bookedBy: agency.name });
  res.status(201).json({ departure: presentDeparture(result.departure, req.user), booking: result.booking });
}));

// The operator's own date requests, whatever their state. Dates in review are
// withheld from the operator's bootstrap (it shows only what the public may
// see), so without this a request vanished from their view the moment it was
// made.
app.get("/api/agency/departure-requests", requireAuth, requireRole("agency_owner", "agency_agent"), h(async (req, res) => {
  const r = await pool.query(
    `SELECT p.id, p.seats, p.customers, p.customer_email, p.status AS booking_status, p.created_at,
            d.id AS departure_id, d.route, d.date, d.start_date, d.end_date, d.status AS departure_status
       FROM pledges p JOIN departures d ON d.id = p.departure_id
      WHERE p.agency_id = $1 AND p.source = 'agency_request'
      ORDER BY p.created_at DESC LIMIT 100`,
    [req.user.agencyId]
  );
  res.json({ requests: r.rows.map((x) => ({
    id: x.id, seats: Number(x.seats), customers: x.customers, customerEmail: x.customer_email,
    bookingStatus: x.booking_status, departureId: x.departure_id, route: x.route,
    date: isoDate(x.start_date) || isoDate(x.date), endDate: isoDate(x.end_date),
    departureStatus: x.departure_status,
    createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : x.created_at,
  })) });
}));

// Admin approves a traveler-requested departure into the open pool.
app.post("/api/admin/departure-requests/:id/approve", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const departure = await withTransaction(async (c) => {
    const dep = await loadDeparture(c, Number(req.params.id), { forUpdate: true });
    if (!dep) throw new AppError(404, "Departure not found.");
    if (dep.status !== "pending_review") throw new AppError(409, "This departure is not awaiting review.");
    // On 24 Sep 2026 two requests for dates already gone (8 and 20 Sep) were
    // approved from the list, and both travellers — who had cancelled — were
    // emailed "Your date is live". A date that has started cannot be opened.
    if (departureStarted(dep)) {
      throw new AppError(409, "This date has already passed, so it can't be opened. Decline it to clear the request.");
    }
    // F02 — requests created before the size check existed can still hold more
    // than the date seats. Opening one would publish an overbooked date.
    if (seatsTotal(dep.pledges) > dep.maxSeats) {
      throw new AppError(409, `This request holds ${seatsTotal(dep.pledges)} travelers on a date that seats ${dep.maxSeats}. Decline it, or raise the tour's capacity first.`);
    }
    await c.query(`UPDATE departures SET status='open' WHERE id=$1`, [dep.id]);
    // Only `pending` rows: requests made before bookings carried that status are
    // already `confirmed` and stay exactly as the traveller was told.
    await c.query(`UPDATE pledges SET status='confirmed' WHERE departure_id=$1 AND status='pending'`, [dep.id]);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.approve", entity: "departure", entityId: String(departure.id) });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  // A traveller who withdrew their request is not told their date is live.
  if (seed?.customerEmail && seed.status !== "cancelled") {
    sendEmailInBackground(throughPartner(pool, { pledgeId: seed.id }, departureRequestApprovedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      bookingCode: seed.bookingCode,
    })));
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
    await c.query(`UPDATE pledges SET status='cancelled' WHERE departure_id=$1 AND status='pending'`, [dep.id]);
    // TT1 — a declined request moves from pending_review, which is withheld, to
    // cancelled, which is mirrored. Without this the partner never learns the
    // date is off, and nothing else ever corrects it.
    touch(dep.id);
    return loadDeparture(c, dep.id);
  });
  await logAudit(req, { action: "departure_request.decline", entity: "departure", entityId: String(departure.id), detail: { reason: reason || null } });
  const seed = departure.pledges.find((p) => p.source === "public_request");
  if (seed?.customerEmail) {
    sendEmailInBackground(throughPartner(pool, { pledgeId: seed.id }, departureRequestDeclinedEmail({
      to: seed.customerEmail, customerName: seed.customers, route: departure.route,
      dateLabel: departure.startDate ? `${departure.startDate} – ${departure.endDate}` : departure.date,
      reason: reason || undefined,
    })));
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

// Public: the display name behind a partner code, for the in-widget booking
// view's "Booked through …" line. Only a named, active partner answers — the
// booking route creates bare rows for any code it is sent, and those have no
// name to show. Nothing else about the partner is returned.
app.get("/api/public/referrals/:code", h(async (req, res) => {
  const code = cleanRefCode(req.params.code);
  if (!code) throw new AppError(404, "Unknown partner.");
  const row = (await pool.query(
    `SELECT COALESCE(a.name, r.name) AS name
       FROM referrals r LEFT JOIN agencies a ON a.id = r.agency_id
      WHERE r.code = $1 AND r.active`, [code])).rows[0];
  if (!row?.name) throw new AppError(404, "Unknown partner.");
  res.set("Cache-Control", "public, max-age=300");
  res.json({ code, name: row.name });
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
  // 070: shown on the Promote page, beside the snippet that uses it.
  const website = (await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0]?.website || null;
  res.json({
    website,
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

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

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
