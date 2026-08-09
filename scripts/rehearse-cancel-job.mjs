// JJ2 — rehearse the auto-cancel job against a candidate, before real data exists.
//
// Runs against an EPHEMERAL local Postgres whose schema is column-for-column
// identical to production (verified by .rehearsal/cols.mjs). Nothing here ever
// touches the production database.
//
// Driven by scripts/rehearse-cancel-job.sh — `npm run rehearse:cancel-job`,
// which builds the cluster, runs every step in order, and destroys it.
//
// Usage: DATABASE_URL=postgres://sawa@127.0.0.1:55432/sawa_rehearsal \
//          node scripts/rehearse-cancel-job.mjs <seed|state|dry|live|purge|email>
import "dotenv/config";
import { pool } from "../server/db/index.js";
import { runCancelUnconfirmed } from "../server/jobs/cancel-unconfirmed.js";
import { cancellationEmail } from "../server/email.js";

const MARK = "REHEARSAL-JJ2";
const DEP_ID = 999001;
const PLEDGE_ID = `${MARK}-PLEDGE`;
const INTERNAL_TO = "hello@sawa.tours";

if (!/127\.0\.0\.1:55432\/sawa_rehearsal/.test(process.env.DATABASE_URL || "")) {
  console.error("REFUSING: DATABASE_URL is not the ephemeral rehearsal database.");
  process.exit(1);
}

const cmd = process.argv[2];

async function seed() {
  // Start date 3 days out, minimum 4 seats, one seat held. A day tour's confirm
  // deadline is well beyond 3 days, so the deadline is already behind us.
  await pool.query(
    `INSERT INTO agencies (id, name, status) VALUES ($1, $2, 'active')`,
    [`${MARK}-AGENCY`, `${MARK} — synthetic, not a real operator`]
  );
  await pool.query(
    `INSERT INTO cities (id, name, status) VALUES ($1, $2, 'active')`,
    [`${MARK}-CITY`, `${MARK} — synthetic city`]
  );
  await pool.query(
    `INSERT INTO tour_products (id, type, title, city, published_rate, min_seats, max_seats, agency_id)
     VALUES ($1, 'day_tour', $2, $3, 100, 4, 12, $4)`,
    [`${MARK}-PRODUCT`, `${MARK} — synthetic tour, never sold`, `${MARK}-CITY`, `${MARK}-AGENCY`]
  );

  const start = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO departures
       (id, type, tour_product_id, route, date, start_date, city, min_seats, max_seats,
        published_rate, status, notes, created_by)
     VALUES ($1, 'day_tour', $2, $3, $4, $4, $5, 4, 12, 100, 'open', $6, $7)`,
    [DEP_ID, `${MARK}-PRODUCT`, `${MARK} — synthetic departure, DO NOT SHIP`,
      start, `${MARK}-CITY`, `${MARK}: created for the JJ2 rehearsal; purge in the same session`,
      // created_by is constrained to admin|agency|traveler — the synthetic
      // marking has to live in route and notes instead.
      "admin"]
  );
  await pool.query(
    `INSERT INTO pledges (id, departure_id, seats, customer_email, customers, status, source)
     VALUES ($1, $2, 1, $3, $4, 'confirmed', $5)`,
    [PLEDGE_ID, DEP_ID, INTERNAL_TO, `${MARK} — synthetic traveller`, MARK]
  );
  console.log(`seeded: departure #${DEP_ID} starting ${start}, 1 of 4 seats, pledge -> ${INTERNAL_TO}`);
}

async function state(label) {
  const dep = await pool.query("SELECT id, status, start_date, route FROM departures ORDER BY id");
  const pl = await pool.query("SELECT id, departure_id, seats, status, customer_email FROM pledges ORDER BY id");
  const al = await pool.query("SELECT action, entity_id, actor_email FROM audit_log ORDER BY id");
  const el = await pool.query("SELECT recipient, subject, kind, status FROM email_log ORDER BY id");
  console.log(`\n===== ${label} =====`);
  console.log("departures:", dep.rows.length ? JSON.stringify(dep.rows) : "(none)");
  console.log("pledges   :", pl.rows.length ? JSON.stringify(pl.rows) : "(none)");
  console.log("audit_log :", al.rows.length ? JSON.stringify(al.rows) : "(none)");
  console.log("email_log :", el.rows.length ? JSON.stringify(el.rows) : "(none)");
}

async function purge() {
  await pool.query("DELETE FROM pledges WHERE id = $1", [PLEDGE_ID]);
  await pool.query("DELETE FROM departures WHERE id = $1", [DEP_ID]);
  await pool.query("DELETE FROM tour_products WHERE id = $1", [`${MARK}-PRODUCT`]);
  await pool.query("DELETE FROM cities WHERE id = $1", [`${MARK}-CITY`]);
  await pool.query("DELETE FROM agencies WHERE id = $1", [`${MARK}-AGENCY`]);
  console.log("purged the synthetic rows");
}

function renderEmail() {
  const mail = cancellationEmail({
    to: INTERNAL_TO,
    route: "Giza Pyramids & Sphinx — small group",
    dateLabel: "2026-08-12",
  });
  console.log("\n===== cancellationEmail, rendered =====");
  console.log("To     :", mail.to);
  console.log("Subject:", mail.subject);
  console.log("Kind   :", mail.kind);
  console.log("\n--- text part (what a plain-text client shows) ---");
  console.log(mail.text);
  console.log("\n--- HTML body, tags stripped ---");
  console.log(
    mail.html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

try {
  if (cmd === "seed") await seed();
  else if (cmd === "state") await state("state");
  else if (cmd === "dry") await runCancelUnconfirmed({ dryRun: true });
  else if (cmd === "live") await runCancelUnconfirmed({ dryRun: false });
  else if (cmd === "purge") await purge();
  else if (cmd === "email") renderEmail();
  else { console.error("unknown command"); process.exit(1); }
} finally {
  await pool.end();
}
