// DIR-20 — rehearse the payment-link queue end to end.
//
// Same argument as JJ2: a mechanism that decides whether anyone is asked to
// collect money is verified against an EPHEMERAL database, before real data
// exists, where failing costs nothing and a synthetic row cannot be confused
// with a real one.
//
// Driven by scripts/rehearse-goahead-alert.sh — `npm run rehearse:goahead`.
import "dotenv/config";
import { pool } from "../server/db/index.js";
import { pendingGoAheads, GOAHEAD, GOAHEAD_ALERT } from "../server/goahead-alert.js";
import { runGoAheadAlerts } from "../server/jobs/alert-goahead.js";

const MARK = "REHEARSAL-DIR20";
const DEP = 999101;

if (!/127\.0\.0\.1:55434\/sawa_goahead/.test(process.env.DATABASE_URL || "")) {
  console.error("REFUSING: DATABASE_URL is not the ephemeral rehearsal database.");
  process.exit(1);
}

const q = (sql, args) => pool.query(sql, args);

async function seed() {
  await q(`INSERT INTO cities (id,name,status) VALUES ($1,$2,'active')`, [`${MARK}-C`, `${MARK} city`]);
  await q(`INSERT INTO agencies (id,name,status,phone) VALUES ($1,$2,'active','+20 100 000 0000')`,
    [`${MARK}-A`, `${MARK} operator`]);
  await q(`INSERT INTO tour_products (id,type,title,city,published_rate,min_seats,max_seats,agency_id)
           VALUES ($1,'day_tour',$2,$3,100,4,12,$4)`,
    [`${MARK}-P`, `${MARK} tour`, `${MARK}-C`, `${MARK}-A`]);
  const start = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  await q(`INSERT INTO departures (id,type,tour_product_id,route,date,start_date,city,min_seats,max_seats,
             published_rate,status,created_by) VALUES ($1,'day_tour',$2,$3,$4,$4,$5,4,12,100,'open','admin')`,
    [DEP, `${MARK}-P`, `${MARK} — synthetic departure`, start, `${MARK}-C`]);
  console.log(`seeded #${DEP}, open, 0 of 4 seats`);
}

// Book seats the way the app does — through the real refreshStatus, so the
// record under test is written by the code under test and not by the harness.
async function book(seats, who) {
  const { withTransaction } = await import("../server/db/index.js");
  const { refreshStatus } = await import("../server/departure-status.js");
  await withTransaction(async (c) => {
    await c.query(`INSERT INTO pledges (id,departure_id,seats,customer_email,customers,status,source,
                     booking_code,booking_total,deposit_due,balance_due)
                   VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,$9,$10)`,
      [`${MARK}-${who}`, DEP, seats, `${who}@sawa.tours`, `${MARK} ${who}`, MARK,
       `SW-${who}`, 100 * seats, 30 * seats, 70 * seats]);
    await refreshStatus(c, DEP);
  });
  const st = (await q(`SELECT status FROM departures WHERE id=$1`, [DEP])).rows[0].status;
  console.log(`booked ${seats} seat(s) for ${who} — departure is now '${st}'`);
}

async function state(label) {
  const d = (await q(`SELECT id,status FROM departures WHERE id=$1`, [DEP])).rows;
  const a = (await q(`SELECT action,entity_id FROM audit_log WHERE entity_id=$1 ORDER BY id`, [String(DEP)])).rows;
  const queue = await pendingGoAheads();
  const el = (await q(`SELECT recipient,kind,status FROM email_log ORDER BY id`)).rows;
  console.log(`\n===== ${label} =====`);
  console.log("departure :", JSON.stringify(d));
  console.log("audit     :", a.length ? a.map((r) => r.action).join(", ") : "(none)");
  console.log("QUEUE     :", queue.length ? queue.map((r) => `#${r.id}`).join(", ") : "(empty)");
  console.log("email_log :", el.length ? JSON.stringify(el) : "(none)");
}

const cmd = process.argv[2];
try {
  if (cmd === "seed") await seed();
  else if (cmd === "book3") await book(3, "first");
  else if (cmd === "book1") await book(1, "fourth");
  else if (cmd === "state") await state("state");
  else if (cmd === "dry") await runGoAheadAlerts({ dryRun: true, to: "ops@sawa.tours" });
  else if (cmd === "live") await runGoAheadAlerts({ dryRun: false, to: "ops@sawa.tours" });
  else { console.error("unknown command"); process.exit(1); }
} finally {
  await pool.end();
}
