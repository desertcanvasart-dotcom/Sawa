// Seeds the database from data/db.json (the existing prototype data),
// so Phase 1 starts with identical content. Re-runnable: it clears first.
// Run: npm run db:seed
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbJsonPath = join(__dirname, "..", "..", "data", "db.json");

const J = (v) => (v === undefined ? null : JSON.stringify(v));

async function main() {
  const data = JSON.parse(await readFile(dbJsonPath, "utf8"));

  await withTransaction(async (c) => {
    // Clear in FK-safe order.
    await c.query("TRUNCATE pledges, departures, tour_products, agencies, cities RESTART IDENTITY CASCADE");

    for (const city of data.cities || []) {
      await c.query(
        `INSERT INTO cities (id, name, region, status) VALUES ($1,$2,$3,$4)`,
        [city.id, city.name, city.region, city.status || "active"]
      );
    }

    for (const a of data.agencies || []) {
      await c.query(
        `INSERT INTO agencies (id, name, contact_name, phone, status) VALUES ($1,$2,$3,$4,$5)`,
        [a.id, a.name, a.contactName, a.phone, a.status || "active"]
      );
    }

    for (const p of data.tourProducts || []) {
      await c.query(
        `INSERT INTO tour_products
          (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
           min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
           description, included, not_included, itinerary, accommodation_tiers)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           $11,$12,$13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22)`,
        [
          p.id, p.type || "day_tour", p.title, p.city, J(p.cities), p.nights ?? null,
          p.duration, p.defaultTime, p.guide, p.vehicle,
          p.minSeats, p.maxSeats, p.baseCost ?? null, p.publishedRate,
          p.breakPrice ?? null, p.quality ?? null, p.depositPercent ?? (p.type === "package" ? 20 : 10),
          p.description, J(p.included || []), J(p.notIncluded || []),
          J(p.itinerary), J(p.accommodationTiers),
        ]
      );
    }

    let maxDepId = 0;
    for (const d of data.departures || []) {
      maxDepId = Math.max(maxDepId, Number(d.id));
      await c.query(
        `INSERT INTO departures
          (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
           city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
           quality, cutoff, status, notes, deposit_percent)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           $11,$12,$13,$14,$15,$16,$17,$18,
           $19,$20,$21,$22,$23)`,
        [
          d.id, d.type || "day_tour", d.tourProductId ?? null, d.route, d.date,
          d.startDate ?? null, d.endDate ?? null, d.nights ?? null, J(d.cities), d.time,
          d.city, d.guide, d.vehicle, d.minSeats, d.maxSeats, d.baseCost ?? null,
          d.publishedRate, d.breakPrice ?? null, d.quality ?? null, d.cutoff,
          d.status || "open", d.notes, d.depositPercent ?? (d.type === "package" ? 20 : 10),
        ]
      );

      for (const pl of d.pledges || []) {
        await c.query(
          `INSERT INTO pledges
            (id, departure_id, agency_id, agency, seats, customers, price_per_person, booking_total,
             deposit_percent, deposit_due, balance_due, balance_due_date, source, booking_code,
             rooming_type, accommodation_tier, accommodation_tier_name, created_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             COALESCE($18, now()))`,
          [
            pl.id, d.id, pl.agencyId ?? null, pl.agency ?? null, pl.seats, pl.customers ?? null,
            pl.pricePerPerson ?? null, pl.bookingTotal ?? null, pl.depositPercent ?? null,
            pl.depositDue ?? null, pl.balanceDue ?? null, pl.balanceDueDate ?? null,
            pl.source ?? null, pl.bookingCode ?? null, pl.roomingType ?? null,
            pl.accommodationTier ?? null, pl.accommodationTierName ?? null, pl.createdAt ?? null,
          ]
        );
      }
    }

    // New departures should get IDs above the highest seeded one.
    await c.query("SELECT setval('departures_id_seq', $1, true)", [Math.max(maxDepId, 1000)]);
  });

  console.log("Seed complete.");
  await pool.end();
}

main().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
