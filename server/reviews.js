// Customer reviews (migration 069), collected from travelers whose tour has run.
//
// Sawa makes a private review link for one booking, from the booking in the
// admin dashboard: copied to send by hand, or emailed to the traveler. The
// link opens /review/<token>, where the traveler gives a star rating, writes
// the review and may add photos and videos. A review waits for an admin, and
// only a published one is shown on the tour page. Nothing here invents a
// rating: every number shown is the average of published reviews, each tied
// to a booking on a date that has run.
//
// Photos and videos go straight from the traveler's browser to the private
// `review-media` bucket through a signed upload link (a video is too large to
// pass through this server as JSON). The keys carry the review's id, so a
// review can only attach files uploaded through its own link.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { pool } from "./db/index.js";
import { BRAND } from "./brand.js";

export const REVIEW_BUCKET = "review-media";
export const MAX_MEDIA = 6;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
// A published review's photo is opened through a link this long-lived; the
// public URL (/api/public/review-media/…) redirects to a fresh one each time.
export const MEDIA_LINK_SECONDS = 600;

const TYPES = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/heic": { ext: "heic", kind: "image" },
  "image/heif": { ext: "heif", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
};
export const REVIEW_MIME_TYPES = Object.keys(TYPES);

const hash = (t) => createHash("sha256").update(String(t)).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");
export const reviewUrl = (token) => `${site()}/review/${encodeURIComponent(token)}`;
const cairoToday = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(ms));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

// { contentType, ext, kind } for an upload the traveler asks to make, or { error }.
export function checkUpload({ contentType, size }) {
  const type = String(contentType || "").toLowerCase();
  const t = TYPES[type];
  if (!t) return { error: "Add a photo (JPG, PNG, WEBP or HEIC) or a video (MP4, MOV or WEBM)." };
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return { error: "That file is empty." };
  const max = t.kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
  if (n > max) return { error: `That ${t.kind} is larger than ${max / 1024 / 1024}MB.` };
  return { contentType: type, ...t };
}

// Where an upload goes: under its review, with a random part so keys can't be guessed.
export function mediaKey(reviewId, ext, { now = Date.now(), rand = randomBytes(6).toString("hex") } = {}) {
  return `reviews/${Number(reviewId)}/${now}-${rand}.${ext}`;
}
const KEY_RE = /^reviews\/([0-9]+)\/[0-9]+-[a-f0-9]+\.(jpg|png|webp|heic|heif|mp4|mov|webm)$/;
export function mediaKeyBelongs(key, reviewId) {
  const m = KEY_RE.exec(String(key || ""));
  return !!m && Number(m[1]) === Number(reviewId);
}
export function mediaKind(key) {
  const ext = String(key).split(".").pop();
  return ["mp4", "mov", "webm"].includes(ext) ? "video" : "image";
}

// The day a booking's tour ended: a package's last day, a day tour's date.
const lastDay = (d) => ymd(d.end_date) || ymd(d.start_date) || ymd(d.date);

// Whether this booking can be asked for a review: not cancelled, and its tour
// has run (its last day is today or earlier, Cairo time). Returns a reason, or null.
export function reviewBlocker(booking, today = cairoToday()) {
  if (!booking) return "Booking not found.";
  if (booking.status === "cancelled") return "This booking was cancelled, so there is no tour to review.";
  if (booking.departure_status === "cancelled") return "This date was cancelled, so there is no tour to review.";
  const end = lastDay(booking);
  if (!end || end > today) return "This tour hasn't run yet. A review link can be made from its last day.";
  return null;
}

export const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1, "Choose a star rating.").max(5, "Choose a star rating."),
  title: z.string().trim().max(120).optional().nullable(),
  body: z.string().trim().min(20, "Write at least a sentence or two (20 characters).").max(4000),
  displayName: z.string().trim().min(2, "Enter the name to show with your review.").max(60),
  country: z.string().trim().max(60).optional().nullable(),
  media: z.array(z.string().max(200)).max(MAX_MEDIA, `Add at most ${MAX_MEDIA} photos or videos.`).optional().default([]),
  consent: z.literal(true, { error: "Tick the box to let us publish your review." }),
});

export async function reviewsAvailable(db = pool) {
  return (await db.query("SELECT to_regclass('customer_reviews') IS NOT NULL AS ok")).rows[0].ok === true;
}

const firstName = (customers) => String(customers || "").trim().split(/[\s,]+/)[0] || "";

// The review as the admin sees it.
export function mapAdminReview(r) {
  return {
    id: Number(r.id), pledgeId: r.pledge_id, departureId: r.departure_id, tourProductId: r.tour_product_id,
    route: r.route, tourDate: ymd(r.tour_date), email: r.email, status: r.status,
    rating: r.rating != null ? Number(r.rating) : null, title: r.title, body: r.body,
    displayName: r.display_name, country: r.country, media: Array.isArray(r.media) ? r.media : [],
    customers: r.customers ?? null, bookingCode: r.booking_code ?? null,
    invitedAt: r.invited_at, emailedAt: r.emailed_at, submittedAt: r.submitted_at,
    moderatedBy: r.moderated_by, moderatedAt: r.moderated_at,
  };
}

// The review as the public sees it: no email, no booking, the tour month only.
export function mapPublicReview(r) {
  const media = Array.isArray(r.media) ? r.media : [];
  return {
    id: Number(r.id), rating: Number(r.rating), title: r.title || null, body: r.body,
    displayName: r.display_name, country: r.country || null,
    traveledOn: ymd(r.tour_date)?.slice(0, 7) || null,
    media: media.map((m, i) => ({ kind: m.kind, url: `/api/public/review-media/${Number(r.id)}/${i}` })),
  };
}

export function summarize(rows) {
  const n = rows.length;
  const avg = n ? rows.reduce((s, r) => s + Number(r.rating), 0) / n : null;
  return { count: n, average: avg == null ? null : Math.round(avg * 10) / 10 };
}

export function registerReviewRoutes(app, {
  requireAuth, requireRole, h, logAudit, writeLimiter, uploadLimiter, supabaseAdmin,
  sendEmail, sendEmailInBackground, reviewRequestEmail, opsNewReviewEmail, opsRecipient, portalLink,
}) {
  const staff = [requireAuth, requireRole("super_admin", "ops_staff")];
  // Every message here is written for the person reading it, 5xx included.
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
  const by = (req) => req.user?.email || req.user?.id || null;

  // Every route answers plainly before the migration rather than "Server error."
  const route = (fn) => h(async (req, res) => {
    if (!(await reviewsAvailable())) {
      throw fail(503, "Reviews aren't switched on yet: migration 069 has not been applied to this database.");
    }
    await fn(req, res);
  });

  let bucketReady = null;
  function ensureBucket() {
    bucketReady ??= (async () => {
      const { data } = await supabaseAdmin.storage.getBucket(REVIEW_BUCKET);
      if (data) return;
      const { error } = await supabaseAdmin.storage.createBucket(REVIEW_BUCKET, {
        public: false, fileSizeLimit: VIDEO_MAX_BYTES, allowedMimeTypes: REVIEW_MIME_TYPES,
      });
      if (error && !/already exists/i.test(error.message || "")) throw new Error(error.message);
    })().catch((e) => { bucketReady = null; throw e; });
    return bucketReady;
  }
  async function signedLinks(media, seconds = 3600) {
    if (!supabaseAdmin || !media.length) return media.map((m) => ({ ...m, url: null }));
    const { data } = await supabaseAdmin.storage.from(REVIEW_BUCKET).createSignedUrls(media.map((m) => m.key), seconds);
    return media.map((m, i) => ({ ...m, url: data?.[i]?.signedUrl || null }));
  }

  const loadBooking = async (pledgeId) => (await pool.query(
    `SELECT p.id, p.status, p.customers, p.customer_email, p.booking_code, p.departure_id,
            d.tour_product_id, d.route, d.date, d.start_date, d.end_date, d.status AS departure_status
       FROM pledges p JOIN departures d ON d.id = p.departure_id WHERE p.id = $1`, [pledgeId])).rows[0];

  const byToken = async (token) => (await pool.query(
    `SELECT r.*, p.customers FROM customer_reviews r JOIN pledges p ON p.id = r.pledge_id WHERE r.token_hash = $1`,
    [hash(token)])).rows[0];

  // ============================================================== admin

  // The review state of one booking, for its drawer.
  app.get("/api/admin/bookings/:id/review", ...staff, route(async (req, res) => {
    const b = await loadBooking(req.params.id);
    if (!b) throw fail(404, "Booking not found.");
    const r = (await pool.query(`SELECT * FROM customer_reviews WHERE pledge_id = $1`, [b.id])).rows[0];
    res.json({ blocker: reviewBlocker(b), email: b.customer_email || null, review: r ? mapAdminReview(r) : null });
  }));

  // Make a review link for a booking (a new link replaces the old one), and
  // email it to the traveler when asked.
  app.post("/api/admin/bookings/:id/review-link", ...staff, route(async (req, res) => {
    const { send } = z.object({ send: z.boolean().optional().default(false) }).parse(req.body || {});
    const b = await loadBooking(req.params.id);
    const blocker = reviewBlocker(b);
    if (blocker) throw fail(b ? 409 : 404, blocker);
    if (send && !b.customer_email) throw fail(422, "This booking has no email address. Copy the link and send it another way.");
    const token = newToken();
    const tourDate = lastDay(b);
    const row = (await pool.query(
      `INSERT INTO customer_reviews (pledge_id, departure_id, tour_product_id, route, tour_date, email, token_hash, invited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (pledge_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, email = EXCLUDED.email,
              invited_by = EXCLUDED.invited_by, invited_at = now()
        WHERE customer_reviews.status = 'invited'
       RETURNING *`,
      [b.id, b.departure_id, b.tour_product_id, b.route, tourDate, b.customer_email || null, hash(token), by(req)])).rows[0];
    if (!row) throw fail(409, "This traveler has already sent their review. Find it under Reviews.");
    const url = reviewUrl(token);
    let emailed = false;
    if (send) {
      const r = await sendEmail(reviewRequestEmail({
        to: b.customer_email, customerName: firstName(b.customers), route: b.route, dateLabel: tourDate, url,
      }));
      emailed = !!r?.ok || r?.mode === "log";
      if (emailed) await pool.query(`UPDATE customer_reviews SET emailed_at = now() WHERE id = $1`, [row.id]);
    }
    await logAudit(req, { action: send ? "review.link_emailed" : "review.link_created", entity: "booking", entityId: b.id, detail: { reviewId: Number(row.id), emailed } });
    res.status(201).json({ url, emailed, review: mapAdminReview({ ...row, emailed_at: emailed ? new Date() : row.emailed_at }) });
  }));

  // Every review sent, newest first, waiting ones on top, with their photos
  // and videos opened through signed links for the admin to look at.
  app.get("/api/admin/reviews", ...staff, route(async (_req, res) => {
    const rows = (await pool.query(
      `SELECT r.*, p.customers, p.booking_code FROM customer_reviews r JOIN pledges p ON p.id = r.pledge_id
        WHERE r.status <> 'invited'
        ORDER BY (r.status = 'submitted') DESC, r.submitted_at DESC LIMIT 500`)).rows;
    const invited = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM customer_reviews WHERE status = 'invited'`)).rows[0].n);
    const reviews = [];
    for (const r of rows) {
      const m = mapAdminReview(r);
      reviews.push({ ...m, media: await signedLinks(m.media) });
    }
    res.json({ reviews, invited });
  }));

  app.patch("/api/admin/reviews/:id", ...staff, route(async (req, res) => {
    const { status } = z.object({ status: z.enum(["published", "hidden"]) }).parse(req.body || {});
    const row = (await pool.query(
      `UPDATE customer_reviews SET status = $1, moderated_by = $2, moderated_at = now()
        WHERE id = $3 AND status IN ('submitted', 'published', 'hidden') RETURNING id, tour_product_id`,
      [status, by(req), Number(req.params.id)])).rows[0];
    if (!row) throw fail(404, "Review not found.");
    await logAudit(req, { action: `review.${status}`, entity: "customer_review", entityId: String(row.id), detail: { tourProductId: row.tour_product_id } });
    res.json({ ok: true });
  }));

  // ============================================================== traveler

  app.get("/api/public/reviews/:token", route(async (req, res) => {
    const r = await byToken(req.params.token);
    if (!r) throw fail(404, "This review link isn't valid. It may have been replaced by a newer one.");
    res.json({
      state: r.status === "invited" ? "open" : "sent",
      route: r.route, tourDate: ymd(r.tour_date), firstName: firstName(r.customers),
      maxMedia: MAX_MEDIA, imageMaxMb: IMAGE_MAX_BYTES / 1024 / 1024, videoMaxMb: VIDEO_MAX_BYTES / 1024 / 1024,
    });
  }));

  // A signed link to upload one photo or video straight to storage.
  app.post("/api/public/reviews/:token/uploads", uploadLimiter, route(async (req, res) => {
    const r = await byToken(req.params.token);
    if (!r) throw fail(404, "This review link isn't valid.");
    if (r.status !== "invited") throw fail(409, "This review has already been sent.");
    const file = checkUpload(req.body || {});
    if (file.error) throw fail(422, file.error);
    if (!supabaseAdmin) throw fail(503, "Uploads aren't available right now. You can send your review without photos.");
    try {
      await ensureBucket();
    } catch {
      throw fail(503, "Uploads aren't available right now. You can send your review without photos.");
    }
    const { data: listed } = await supabaseAdmin.storage.from(REVIEW_BUCKET).list(`reviews/${Number(r.id)}`, { limit: 100 });
    if ((listed || []).length >= MAX_MEDIA * 3) throw fail(429, "That's a lot of uploads for one review. Send it with the ones you have.");
    const key = mediaKey(r.id, file.ext);
    const { data, error } = await supabaseAdmin.storage.from(REVIEW_BUCKET).createSignedUploadUrl(key);
    if (error || !data?.signedUrl) throw fail(502, "Couldn't start the upload. Please try again.");
    res.status(201).json({ key, kind: file.kind, uploadUrl: data.signedUrl });
  }));

  app.post("/api/public/reviews/:token", writeLimiter, route(async (req, res) => {
    const r = await byToken(req.params.token);
    if (!r) throw fail(404, "This review link isn't valid.");
    if (r.status !== "invited") throw fail(409, "This review has already been sent. Thank you!");
    const input = reviewSchema.parse(req.body || {});
    const keys = [...new Set(input.media)];
    if (keys.some((k) => !mediaKeyBelongs(k, r.id))) throw fail(422, "One of the files can't be attached. Remove it and add it again.");
    let media = [];
    if (keys.length) {
      if (!supabaseAdmin) throw fail(503, "Uploads aren't available right now. Remove the photos to send your review.");
      const { data: listed } = await supabaseAdmin.storage.from(REVIEW_BUCKET).list(`reviews/${Number(r.id)}`, { limit: 100 });
      const there = new Set((listed || []).map((o) => `reviews/${Number(r.id)}/${o.name}`));
      const missing = keys.filter((k) => !there.has(k));
      if (missing.length) throw fail(422, "A photo or video didn't finish uploading. Remove it and add it again.");
      media = keys.map((key) => ({ key, kind: mediaKind(key) }));
    }
    const done = (await pool.query(
      `UPDATE customer_reviews SET status = 'submitted', rating = $2, title = $3, body = $4, display_name = $5,
              country = $6, media = $7::jsonb, publish_consent_at = now(), submitted_at = now()
        WHERE id = $1 AND status = 'invited' RETURNING id`,
      [r.id, input.rating, input.title || null, input.body, input.displayName, input.country || null, JSON.stringify(media)])).rows[0];
    if (!done) throw fail(409, "This review has already been sent. Thank you!");
    await logAudit(req, { action: "review.submit", entity: "customer_review", entityId: String(r.id), detail: { rating: input.rating, media: media.length } });
    sendEmailInBackground(opsNewReviewEmail({
      to: opsRecipient(), route: r.route, rating: input.rating, displayName: input.displayName, media: media.length, portalLink: portalLink(),
    }));
    res.status(201).json({ ok: true });
  }));

  // ============================================================== public

  // A tour's published reviews, and their count and average.
  app.get("/api/public/tours/:productId/reviews", h(async (req, res) => {
    if (!(await reviewsAvailable())) return res.json({ count: 0, average: null, reviews: [] });
    const rows = (await pool.query(
      `SELECT id, rating, title, body, display_name, country, tour_date, media FROM customer_reviews
        WHERE tour_product_id = $1 AND status = 'published' ORDER BY submitted_at DESC LIMIT 200`,
      [String(req.params.productId)])).rows;
    res.set("Cache-Control", "public, max-age=60");
    res.json({ ...summarize(rows), reviews: rows.map(mapPublicReview) });
  }));

  // A published review's photo or video: a redirect to a short-lived signed link.
  app.get("/api/public/review-media/:id/:n", h(async (req, res) => {
    const id = Number(req.params.id), n = Number(req.params.n);
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 0 || !(await reviewsAvailable())) throw fail(404, "Not found.");
    const r = (await pool.query(`SELECT media FROM customer_reviews WHERE id = $1 AND status = 'published'`, [id])).rows[0];
    const m = r && Array.isArray(r.media) ? r.media[n] : null;
    if (!m || !supabaseAdmin) throw fail(404, "Not found.");
    const { data, error } = await supabaseAdmin.storage.from(REVIEW_BUCKET).createSignedUrl(m.key, MEDIA_LINK_SECONDS);
    if (error || !data?.signedUrl) throw fail(502, "Couldn't open this file.");
    res.set("Cache-Control", "private, max-age=300");
    res.redirect(302, data.signedUrl);
  }));
}
