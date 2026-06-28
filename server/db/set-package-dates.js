// Replace a package's published departures with a given list of start dates.
// Usage: node server/db/set-package-dates.js <productId> <YYYY-MM-DD> [<YYYY-MM-DD> ...]
// Defaults to the 9-day Nile cruise package and its current schedule.
import { pool } from "./index.js";

const PRODUCT_ID = process.argv[2] || "pkg_egypt_nile_cruise_9d";
const DATES = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["2026-11-13", "2026-12-11", "2027-01-15", "2027-02-19", "2027-03-12", "2027-04-16"];

async function run() {
  const { rows } = await pool.query("SELECT * FROM tour_products WHERE id = $1", [PRODUCT_ID]);
  if (!rows.length) { console.error("No product:", PRODUCT_ID); process.exit(1); }
  const p = rows[0];
  const isPkg = p.type === "package";
  const J = (v) => JSON.stringify(v);

  await pool.query("DELETE FROM departures WHERE tour_product_id = $1", [PRODUCT_ID]);

  let nextId = Number((await pool.query("SELECT COALESCE(MAX(id), 1000) AS m FROM departures")).rows[0].m) + 1;
  for (const start of DATES) {
    let endStr = null;
    if (isPkg && p.nights) {
      const end = new Date(`${start}T12:00:00`);
      end.setDate(end.getDate() + Number(p.nights));
      endStr = end.toISOString().slice(0, 10);
    }
    await pool.query(
      `INSERT INTO departures
         (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
          city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
          quality, status, deposit_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        nextId++, p.type, p.id, p.title, start, isPkg ? start : null, endStr, isPkg ? p.nights : null,
        isPkg ? J(p.cities || []) : null, p.default_time, p.city, p.guide, p.vehicle,
        p.min_seats, p.max_seats, p.base_cost, p.published_rate, p.break_price, p.quality, "open", p.deposit_percent,
      ]
    );
  }
  console.log(`✓ ${p.title}: set ${DATES.length} departures — ${DATES.join(", ")}`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
