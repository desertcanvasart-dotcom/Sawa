// One-off platform reset: remove fabricated inventory so the catalogue starts
// clean under the "a date is created by its first booking" rule (2026-08-08).
//
// What it removes, and why it is safe:
//
//   1. Departures with ZERO non-cancelled pledges — the empty dates admin
//      publishing used to mint before the rule existed. No traveller holds a
//      seat on any of them, so deleting destroys no booking, no history a
//      customer could ask about, and no money. Pledge rows (only cancelled
//      ones can exist here) go with them via ON DELETE CASCADE.
//
//   2. Archived TEST listings whose title matches "giza and the pyramid" —
//      portal experiments, never real product. Their departures are covered
//      by rule 1 (they never had bookings); the product rows are deleted after.
//
// What it never touches: any departure with at least one live pledge, and any
// active listing. The 14 real itineraries stay exactly as they are.
//
// Dry run (default):  node server/db/reset-fabricated-inventory.js
// Actually delete:    node server/db/reset-fabricated-inventory.js --apply
import "dotenv/config";
import { pool, withTransaction } from "./index.js";

const APPLY = process.argv.includes("--apply");
const TEST_TITLE = /giza and the pyramid/i;

async function run() {
  const deps = await pool.query(`
    SELECT d.id, d.route, COALESCE(d.start_date, d.date) AS start, d.status,
           COALESCE(SUM(CASE WHEN p.status IS DISTINCT FROM 'cancelled' THEN p.seats ELSE 0 END), 0) AS live_seats
      FROM departures d
      LEFT JOIN pledges p ON p.departure_id = d.id
     GROUP BY d.id
     ORDER BY start`);
  const empty = deps.rows.filter((d) => Number(d.live_seats) === 0);
  const kept = deps.rows.length - empty.length;

  const products = await pool.query("SELECT id, title, active FROM tour_products");
  const testProducts = products.rows.filter((p) => p.active === false && TEST_TITLE.test(p.title || ""));

  console.log(`Departures: ${deps.rows.length} total — ${empty.length} with no traveller (to remove), ${kept} with live bookings (kept).`);
  for (const d of empty) console.log(`  - #${d.id} ${d.route} on ${String(d.start).slice(0, 10)} [${d.status}]`);
  console.log(`Test listings to remove: ${testProducts.length}`);
  for (const p of testProducts) console.log(`  - ${p.id} "${p.title}" (archived)`);

  if (!APPLY) {
    console.log("\nDry run — nothing deleted. Re-run with --apply to execute.");
    return;
  }

  await withTransaction(async (c) => {
    // Re-check inside the transaction: a booking that landed between the scan
    // and now must save its departure.
    for (const d of empty) {
      const live = await c.query(
        `SELECT COALESCE(SUM(CASE WHEN status IS DISTINCT FROM 'cancelled' THEN seats ELSE 0 END), 0) AS s
           FROM pledges WHERE departure_id = $1`, [d.id]);
      if (Number(live.rows[0].s) > 0) { console.log(`  ! #${d.id} gained a booking — kept.`); continue; }
      await c.query("DELETE FROM departures WHERE id = $1", [d.id]); // pledges cascade
    }
    for (const p of testProducts) {
      await c.query("DELETE FROM tour_products WHERE id = $1", [p.id]);
    }
  });
  console.log("\nDone. The catalogue keeps only real itineraries; every remaining date has a traveller aboard.");
}

run().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
