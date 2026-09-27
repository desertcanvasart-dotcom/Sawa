// The below-minimum cancellation notice (model phase 1 gap).
//
// When the status job cancels a catalogue departure below its minimum, it
// writes a `traveller_notice.cancelled_below_minimum` event with the exact
// bookings it released. This turns each event into one notice row per traveler
// (and one per agency owner for an agency booking), then sends what is owed.
//
// Safe to re-run: a notice row is unique per (departure, booking, kind,
// recipient), and only rows not yet sent are sent. Every send is recorded on
// its row: status, attempts, last error, sent_at.
//
// Behind catalogue_v2: with the flag off nothing is sent (and there are no
// generated departures to cancel anyway).
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { sendEmail, belowMinimumCancellationEmail } from "./email.js";
import { publicCatalogue } from "./catalogue-public.js";
import { catalogueV2Enabled } from "./features.js";

const MAX_ATTEMPTS = 5;
const RECLAIM_AFTER_MIN = 30;

export function readableDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(ymd || ""))) return String(ymd || "");
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`));
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10));

// Step 1: events → notice rows. One transaction per event, so an event is
// marked processed exactly when its rows exist.
export async function queueCancellationNotices({ db = pool } = {}) {
  const events = await db.query(
    `SELECT e.*, cd.legacy_departure_id FROM catalogue_events e
       JOIN catalogue_departures cd ON cd.id = e.departure_id
      WHERE e.type = 'traveller_notice.cancelled_below_minimum' AND e.processed_at IS NULL
      ORDER BY e.id`
  );
  let queued = 0;
  for (const ev of events.rows) {
    queued += await inTx(db, async (c) => {
      const lock = await c.query(
        "SELECT id FROM catalogue_events WHERE id = $1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED", [ev.id]);
      if (!lock.rows.length) return 0;
      // The bookings this cancellation released. Events written before the
      // payload carried them fall back to every canceled booking on the date.
      const ids = Array.isArray(ev.payload?.releasedPledgeIds) ? ev.payload.releasedPledgeIds : null;
      const pledges = ids
        ? (await c.query("SELECT * FROM pledges WHERE id = ANY($1::text[])", [ids])).rows
        : ev.legacy_departure_id
          ? (await c.query("SELECT * FROM pledges WHERE departure_id = $1 AND status = 'cancelled'", [ev.legacy_departure_id])).rows
          : [];
      let n = 0;
      for (const p of pledges) {
        if (p.customer_email) n += await addNotice(c, ev.departure_id, p.id, "traveler", p.customer_email);
        if (p.agency_id && p.agency_id !== "direct_customer") {
          const owners = await c.query(
            "SELECT email FROM app_users WHERE agency_id = $1 AND role = 'agency_owner' AND status = 'active' ORDER BY email",
            [p.agency_id]);
          for (const o of owners.rows) n += await addNotice(c, ev.departure_id, p.id, "agency_copy", o.email);
        }
      }
      await c.query(
        `UPDATE catalogue_events SET processed_at = now()
          WHERE departure_id = $1 AND type IN ('traveller_notice.cancelled_below_minimum', 'next_date_offer') AND processed_at IS NULL`,
        [ev.departure_id]);
      return n;
    });
  }
  return queued;
}

async function addNotice(c, departureId, pledgeId, kind, recipient) {
  const r = await c.query(
    `INSERT INTO catalogue_notices (departure_id, pledge_id, kind, recipient) VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT uq_catalogue_notices_once DO NOTHING`,
    [departureId, pledgeId, kind, String(recipient).trim().toLowerCase()]);
  return r.rowCount;
}

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));

// Step 2: send what is owed. Rows are claimed with SKIP LOCKED so two runs
// never send the same one; a row left 'sending' by a crash is reclaimed after
// half an hour.
export async function sendPendingNotices({ db = pool, send = sendEmail, now = Date.now(), log = () => {} } = {}) {
  const claimed = await db.query(
    `UPDATE catalogue_notices n SET status = 'sending', attempts = n.attempts + 1, sent_at = NULL, claimed_at = now()
      WHERE n.id IN (
        SELECT id FROM catalogue_notices
         WHERE (status IN ('pending', 'failed') AND attempts < $1)
            OR (status = 'sending' AND claimed_at < now() - ($2 || ' minutes')::interval AND attempts < $1)
         ORDER BY id
         FOR UPDATE SKIP LOCKED LIMIT 50)
      RETURNING n.*`,
    [MAX_ATTEMPTS, String(RECLAIM_AFTER_MIN)]
  );
  if (!claimed.rows.length) return { sent: 0, failed: 0 };
  const cat = await publicCatalogue(now);
  let sent = 0;
  let failed = 0;
  for (const n of claimed.rows) {
    try {
      const message = await buildNotice(db, n, cat);
      const r = await send(message);
      if (!r?.ok) throw new Error(r?.error || "the mail provider did not accept it");
      await db.query("UPDATE catalogue_notices SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [n.id]);
      sent += 1;
    } catch (e) {
      await db.query("UPDATE catalogue_notices SET status = 'failed', last_error = $2 WHERE id = $1", [n.id, String(e.message).slice(0, 500)]);
      log(`catalogue notice ${n.id} to ${n.recipient} failed (attempt ${n.attempts}): ${e.message}`);
      failed += 1;
    }
  }
  if (sent || failed) log(`catalogue notices: ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

async function buildNotice(db, n, cat) {
  const { rows: [row] } = await db.query(
    `SELECT cd.date, cd.product_id, c.title, c.base_city, p.customers, p.agency, p.id AS pledge_id
       FROM catalogue_departures cd
       JOIN catalogue_products c ON c.id = cd.product_id
       JOIN pledges p ON p.id = $2
      WHERE cd.id = $1`,
    [n.departure_id, n.pledge_id]);
  if (!row) throw new Error("departure or booking no longer exists");
  const site = String(BRAND.url || "").replace(/\/$/, "");
  const productId = Number(row.product_id);
  const here = cat?.byProduct.get(productId) || null;
  const nextDates = here ? here.dates.filter((d) => d.date > ymd(row.date)).slice(0, 3)
    .map((d) => ({ dateLabel: readableDate(d.date), label: d.label, url: `${site}${here.path}?date=${d.date}` })) : [];
  // One other bookable product from the same city, the one with the soonest date.
  let alternative = null;
  if (cat) {
    const others = [...cat.byProduct.values()]
      .filter((x) => x.product.id !== productId && x.product.baseCity === row.base_city && x.dates.length)
      .sort((a, b) => (a.dates[0].date < b.dates[0].date ? -1 : 1));
    if (others[0]) {
      alternative = { title: others[0].product.title, url: `${site}${others[0].path}`, dateLabel: readableDate(others[0].dates[0].date) };
    }
  }
  const paid = await hasUnrefundedPayment(db, n.pledge_id);
  return belowMinimumCancellationEmail({
    to: n.recipient, travelerName: row.customers || "", title: row.title, dateLabel: readableDate(row.date),
    paid, nextDates, alternative,
    agencyCopy: n.kind === "agency_copy" ? { agencyName: row.agency || "" } : null,
  });
}

// Before the GoAhead nothing is normally taken, but ops can send a payment
// link at any time (043). A booking with a payment marked paid and not yet
// refunded is told its money is being refunded. Refunds themselves are still
// made by hand in Tab under the current flow.
async function hasUnrefundedPayment(db, pledgeId) {
  try {
    const r = await db.query("SELECT 1 FROM booking_payments WHERE pledge_id = $1 AND state = 'paid' LIMIT 1", [pledgeId]);
    return r.rows.length > 0;
  } catch (e) {
    if (e?.code === "42P01") return false;   // 043 not applied: no payments exist
    throw e;
  }
}

export async function runCancellationNotices({ db = pool, send, now, log = () => {}, env = process.env } = {}) {
  if (!catalogueV2Enabled(env)) return { skipped: "catalogue_v2 is off" };
  const queued = await queueCancellationNotices({ db });
  const result = await sendPendingNotices({ db, send, now, log });
  return { queued, ...result };
}
