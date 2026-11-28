// Adds the four day tours priced in "sawa for T2E" (28 Nov 2026): three from
// Hurghada and the Nubian temples from Aswan. Content, prices and galleries
// come from content/tours/t2e-day-tours.json; the prose is drafted in Tours/.
//
// Called inside the deploy data-fix transaction (apply-deploy-data-fixes.js),
// after the schema is current. Same shape as publishPrivateTourArticle:
//   - one marker in schema_migrations, so later boots are a read-only no-op
//     and admin edits made afterwards are never overwritten;
//   - an advisory lock, so overlapping Railway deployments are harmless;
//   - an existing row with one of these ids is left exactly as it is.
//
// Prices are a per-group-size grid (price_tiers, 020): the sheet gives a
// EUR price for 4, 5, 6, 7 and 8 travellers, so published_rate is the
// 4-traveller price and break_price the 8-traveller price, which is what the
// grid mode of the editor would have saved (shared/price-mode.js).
import { readFile } from "node:fs/promises";
import { cleanHtml } from "../sanitize.js";
import { validatePriceTiers } from "../domain.js";
import { durationShapeError } from "../../shared/booking-policy.js";

const CONTENT = new URL("../../content/tours/t2e-day-tours.json", import.meta.url);

// Pure: the tour_products row for one entry, or a thrown error naming what is
// wrong with the content file. Exported for add-t2e-day-tours.test.js.
export function tourRow(t) {
  const tierCheck = validatePriceTiers(t.tiers, { minSeats: t.minSeats, maxSeats: t.maxSeats });
  if (tierCheck.error) throw new Error(`${t.id}: ${tierCheck.error}`);
  const durationProblem = durationShapeError("day_tour", t.duration);
  if (durationProblem) throw new Error(`${t.id}: ${durationProblem}`);
  const tiers = tierCheck.tiers;
  const html = cleanHtml(t.overviewHtml);
  if (!html) throw new Error(`${t.id}: overviewHtml is empty after sanitising`);
  for (const img of t.images || []) {
    if (!/^\/images\/tours\/[\w-]+\/\d\d\.jpg$/.test(img.url)) throw new Error(`${t.id}: image url ${img.url}`);
  }
  return {
    id: t.id,
    title: t.title,
    city: t.city,
    duration: t.duration,
    defaultTime: t.defaultTime,
    guide: t.guide,
    vehicle: t.vehicle,
    minSeats: t.minSeats,
    maxSeats: t.maxSeats,
    publishedRate: tiers[0].price,
    breakPrice: tiers[tiers.length - 1].price,
    depositPercent: t.depositPercent,
    description: t.description,
    included: t.included,
    notIncluded: t.notIncluded,
    overviewHtml: html,
    whatToBring: t.whatToBring,
    meetingPoint: t.meetingPoint,
    pickupNote: t.pickupNote,
    bookingCutoffHours: t.bookingCutoffHours,
    images: t.images,
    priceTiers: tiers,
  };
}

export async function addT2eDayTours(client) {
  const { marker, tours } = JSON.parse(await readFile(CONTENT, "utf8"));
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [marker]);
  const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1", [marker]);
  if (applied.rows.length) return "already applied";

  const rows = tours.map(tourRow);
  let inserted = 0;
  const skipped = [];
  for (const r of rows) {
    const res = await client.query(
      `INSERT INTO tour_products
        (id, type, title, city, duration, default_time, guide, vehicle,
         min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
         description, included, not_included, overview_html, what_to_bring, meeting_point, pickup_note,
         booking_cutoff_hours, booking_cutoff_unit, images, meeting_points, price_tiers,
         status, submitted_at, reviewed_at)
       VALUES ($1,'day_tour',$2,$3,$4,$5,$6,$7,
         $8,$9,0,$10,$11,4.7,$12,
         $13,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,$19,
         $20,'hours',$21::jsonb,'[]'::jsonb,$22::jsonb,
         'approved',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id, r.title, r.city, r.duration, r.defaultTime, r.guide, r.vehicle,
        r.minSeats, r.maxSeats, r.publishedRate, r.breakPrice, r.depositPercent,
        r.description, JSON.stringify(r.included), JSON.stringify(r.notIncluded), r.overviewHtml,
        JSON.stringify(r.whatToBring), r.meetingPoint, r.pickupNote,
        r.bookingCutoffHours, JSON.stringify(r.images), JSON.stringify(r.priceTiers),
      ]
    );
    if (res.rowCount) inserted += 1; else skipped.push(r.id);
  }
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [marker]);
  return `${inserted} inserted${skipped.length ? `, already present: ${skipped.join(", ")}` : ""}`;
}
