// Merging duplicate dates (055): two departures of one tour on one day become one
//
// Moved out of server/app.js verbatim (12 Nov 2026), as part of splitting that
// file. app.js loads this module at the point these routes used to stand, so
// the order routes are registered in is unchanged. Anything app.js defines for
// itself (the Express app, its guards, its loaders) arrives through the route
// context it fills first; see server/route-context.js.
import { z } from "zod";
import { logAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth.js";
import { BRAND } from "../brand.js";
import { pool, withDepartureWrites } from "../db/index.js";
import { cancelDepartureAndPledges, CANCEL_REASONS, reportNotifications } from "../departure-cancel.js";
import { MergeError, mergePreview, mergeDepartures, emailMovedTravelers, listMerges, revertMerge } from "../departure-merge.js";
import { sendEmail, departureMergedEmail, cancellationEmail } from "../email.js";
import { rethrowIfProgrammerError } from "../errors.js";
import { sniffImageType } from "../image-type.js";
import { throughPartner } from "../partner.js";
import { supabaseAdmin } from "../supabase.js";
import { routeContext } from "../route-context.js";

const {
  app, h, AppError, parse, loadDeparture, presentDeparture, uploadLimiter,
} = routeContext();

// ---- Merging duplicate dates (055) ------------------------------------------
// The other live dates of the same tour and day: the candidates to merge.
app.get("/api/admin/departures/:id/duplicates", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  const id = Number(req.params.id);
  const d = (await pool.query("SELECT id, tour_product_id, date, start_date FROM departures WHERE id = $1", [id])).rows[0];
  if (!d) throw new AppError(404, "Departure not found.");
  const rows = (await pool.query(
    `SELECT d.id, d.route, d.status, d.max_seats,
            COALESCE((SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status <> 'cancelled'), 0)::int AS seats
       FROM departures d
      WHERE d.tour_product_id = $1 AND COALESCE(d.start_date, d.date) = COALESCE($2::date, $3::date) AND d.id <> $4
        AND d.status IN ('pending_review', 'open', 'minimum_reached', 'supplier_confirmed')
        ${await departureMergesReady() ? "AND d.merged_into_id IS NULL" : ""}
      ORDER BY d.id`, [d.tour_product_id, d.start_date, d.date, id])).rows;
  res.json({ departureId: id, duplicates: rows.map((r) => ({ id: Number(r.id), route: r.route, status: r.status, seats: r.seats, maxSeats: Number(r.max_seats) })) });
}));

const mergeSchema = z.object({
  keptId: z.coerce.number().int().positive(),
  duplicateIds: z.array(z.coerce.number().int().positive()).min(1, "Choose at least one duplicate.").max(50),
  operatorAgencyId: z.string().trim().max(120).nullable().optional(),
});
async function departureMergesReady() {
  return (await pool.query("SELECT to_regclass('public.departure_merges') AS t")).rows[0].t != null;
}
const mergesNotOn = () => Object.assign(new AppError(503, "Merging isn't switched on yet: migration 055 has not been applied to this database."), { expose: true });
const mergeFail = (e) => { if (e instanceof MergeError) throw new AppError(e.status, e.message); throw e; };

app.post("/api/admin/departures/merge/preview", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  if (!(await departureMergesReady())) throw mergesNotOn();
  const input = parse(mergeSchema, req.body);
  res.json(await mergePreview(pool, input).catch(mergeFail));
}));

app.post("/api/admin/departures/merge", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  if (!(await departureMergesReady())) throw mergesNotOn();
  const input = parse(mergeSchema, req.body);
  const out = await mergeDepartures({ ...input, by: req.user.email || null }).catch(mergeFail);
  // One email to each moved traveler: same tour, same day, booking unchanged.
  // Awaited, because the count reached is recorded on the merge.
  const emailed = await emailMovedTravelers(pool, out, { send: sendEmail, template: departureMergedEmail, base: process.env.APP_URL || BRAND.url });
  await logAudit(req, { action: "departure.merge", entity: "departure", entityId: String(out.merge.keptId), detail: {
    mergeId: out.merge.id, kept: out.merge.keptId, merged: out.merge.duplicateIds, movedBookings: out.merge.movedBookings,
    bookings: out.moved.map((p) => ({ id: p.id, from: p.from })), operatorAgencyId: out.merge.operatorAgencyId, emailed,
  } });
  res.status(201).json({ merge: { ...out.merge, emailed }, kept: out.kept });
}));

app.get("/api/admin/departure-merges", requireAuth, requireRole("super_admin", "ops_staff"), h(async (_req, res) => {
  res.json({ merges: await listMerges(pool) });
}));

app.post("/api/admin/departure-merges/:id/revert", requireAuth, requireRole("super_admin", "ops_staff"), h(async (req, res) => {
  if (!(await departureMergesReady())) throw mergesNotOn();
  const out = await revertMerge({ mergeId: Number(req.params.id), by: req.user.email || null }).catch(mergeFail);
  await logAudit(req, { action: "departure.merge_reverted", entity: "departure", entityId: String(out.keptId), detail: out });
  res.json(out);
}));

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
    const sent = await sendEmail(await throughPartner(pool, { departureId: departure.id, email: to }, cancellationEmail({ to, route: departure.route, dateLabel })))
      .catch((e) => { rethrowIfProgrammerError(e); return { ok: false }; });
    if (sent?.ok) reached += 1;
  }
  const notificationsClean = reportNotifications({
    intended: recipients.length, sent: reached,
    context: `departure ${departure.id} canceled`,
  });

  res.json({
    departure: presentDeparture(departure, req.user),
    pledgesCancelled,
    notified: reached,
    notificationsIntended: recipients.length,
    // The caller is told plainly rather than left to compare two numbers.
    notificationWarning: notificationsClean ? null
      : `${recipients.length - reached} traveler(s) on this departure were not reached. They have not been told it is canceled.`,
  });
}));

// Upload a tour image. Open to platform staff AND agency users, since agencies
// upload photos for their own tour listings via the shared product editor.
// Accepts JSON { filename, dataUrl } where dataUrl is a base64 data URI and
// returns the public URL.
app.post("/api/admin/uploads", requireAuth, requireRole("super_admin", "ops_staff", "agency_owner", "agency_agent"), uploadLimiter, h(async (req, res) => {
  if (!supabaseAdmin) throw new AppError(500, "Storage is not configured.");
  const { filename, dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== "string") throw new AppError(422, "No image provided.");
  const m = dataUrl.match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/);
  if (!m) throw new AppError(422, "Unsupported image format. Use PNG, JPG, WEBP, or GIF.");
  const contentType = m[1];
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const buffer = Buffer.from(m[3], "base64");
  if (buffer.length > 6 * 1024 * 1024) throw new AppError(422, "Image is larger than 6MB.");
  // The type in a data URL is whatever the sender wrote. This bucket is
  // public, so the bytes must be the image they are stored as.
  if (sniffImageType(buffer) !== contentType.replace("image/jpg", "image/jpeg")) {
    throw new AppError(422, "That file isn't a valid PNG, JPG, WEBP or GIF image.");
  }

  const safe = String(filename || "image").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const key = `tours/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}.${ext}`;
  const { error } = await supabaseAdmin.storage.from("tour-images").upload(key, buffer, { contentType, upsert: false });
  if (error) throw new AppError(500, "Upload failed: " + error.message);
  const { data } = supabaseAdmin.storage.from("tour-images").getPublicUrl(key);
  await logAudit(req, { action: "image.upload", entity: "tour_image", entityId: key });
  res.status(201).json({ url: data.publicUrl, key });
}));

// Unknown /api/* path -> JSON 404.
