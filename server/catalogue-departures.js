// Numbered departures (29 Sep 2026, catalogue_v2). See shared/departure-numbers.js
// for the rules. This is where they meet the database: finding the siblings of a
// departure, routing a booking to the right one, opening the next, and moving a
// whole party.
//
// A date's departures are locked together (an advisory lock on product and day)
// before any is read, so two bookings arriving at once can't both take the last
// seats or both open departure 2.
import { pool, withTransaction } from "./db/index.js";
import { mapCatalogueProduct, makeBookable, todayIn, departureInstants } from "./catalogue.js";
import { seatsHeldForWaitlist } from "./pay-at-goahead.js";
import { stampBookingPrice } from "./pool-settlement.js";
import { JOINABLE_STATUSES } from "./booking-parties.js";
import { pickDeparture, allFull, nextNumber, placeParty } from "../shared/departure-numbers.js";

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function lockDate(c, productId, date) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('catalogue-date'), hashtext($1))", [`${productId}:${ymd(date)}`]);
}

// Every departure of this departure's product and date, lowest number first.
export async function siblingsOf(c, legacyDepartureId) {
  const cd = (await c.query("SELECT * FROM catalogue_departures WHERE legacy_departure_id = $1", [legacyDepartureId])).rows[0];
  if (!cd) return null;
  await lockDate(c, cd.product_id, cd.date);
  const rows = (await c.query(
    `SELECT cd.id AS cd_id, cd.departure_no, cd.status AS cd_status, cd.legacy_departure_id AS id, d.status, d.max_seats,
            COALESCE((SELECT SUM(p.seats) FROM pledges p WHERE p.departure_id = d.id AND p.status <> 'cancelled'), 0)::int AS booked
       FROM catalogue_departures cd JOIN departures d ON d.id = cd.legacy_departure_id
      WHERE cd.product_id = $1 AND cd.date = $2 ORDER BY cd.departure_no`, [cd.product_id, cd.date])).rows;
  const siblings = [];
  for (const r of rows) {
    const held = Number(await seatsHeldForWaitlist(c, r.id)) || 0;
    siblings.push({
      id: Number(r.id), cdId: Number(r.cd_id), no: Number(r.departure_no),
      free: Math.max(0, Number(r.max_seats) - r.booked - held), booked: r.booked, max: Number(r.max_seats),
      joinable: ["open", "go_ahead"].includes(r.cd_status) && JOINABLE_STATUSES.includes(r.status),
    });
  }
  return { cd, siblings };
}

// Opens departure N+1 of the same product and date, sold through an ordinary
// departure like the first. Caller holds the date lock.
export async function openNextDeparture(c, cd, siblings) {
  const product = mapCatalogueProduct((await c.query("SELECT * FROM catalogue_products WHERE id = $1", [cd.product_id])).rows[0]);
  const t = (await c.query("SELECT * FROM tour_products WHERE id = $1", [product.legacyProductId])).rows[0];
  if (!t) return null;
  const no = nextNumber(siblings);
  const row = (await c.query(
    `INSERT INTO catalogue_departures (product_id, date, spec_version_id, status, origin, departure_no)
     VALUES ($1, $2, $3, 'open', 'generated', $4) RETURNING *`, [cd.product_id, cd.date, cd.spec_version_id, no])).rows[0];
  const id = await makeBookable(c, row, product, t);
  return { id: Number(id), cdId: Number(row.id), no, free: product.maxGroup, booked: 0, max: product.maxGroup, joinable: true };
}

// Whole-party guard: a party may move only while none of its bookings has a
// payment request or a payment.
async function partyState(c, partyId) {
  const party = (await c.query("SELECT * FROM booking_parties WHERE id = $1 FOR UPDATE", [partyId])).rows[0];
  const members = (await c.query(
    "SELECT id, seats FROM pledges WHERE party_id = $1 AND status <> 'cancelled' ORDER BY id", [partyId])).rows;
  const ids = members.map((m) => m.id);
  const paid = ids.length ? Number((await c.query(
    `SELECT (SELECT COUNT(*) FROM payment_requests WHERE pledge_id = ANY($1::text[]))
          + (SELECT COUNT(*) FROM booking_payments WHERE pledge_id = ANY($1::text[])) AS n`, [ids])).rows[0].n) : 0;
  return { party, ids, seats: members.reduce((s, m) => s + Number(m.seats), 0), movable: paid === 0 };
}

async function moveParty(c, { party, ids, toId }) {
  await c.query("UPDATE pledges SET departure_id = $2 WHERE party_id = $1", [party.id, toId]);
  await c.query("UPDATE booking_parties SET departure_id = $2 WHERE id = $1", [party.id, toId]);
  for (const id of ids) await stampBookingPrice(c, { pledgeId: id });
  return ids.length;
}

// Which departure a booking of `seats` goes to. Inside the booking's transaction,
// before the departure is read. `partyToken`: a "Join my group" booking, placed
// whole with its party. Returns { departureId, no, opened, movedParty }.
export async function routeBooking(c, { departureId, seats, partyToken = null }) {
  const found = await siblingsOf(c, departureId);
  if (!found) return { departureId, routed: false };
  const { cd, siblings } = found;
  const n = Math.max(1, Number(seats) || 1);
  const product = mapCatalogueProduct((await c.query("SELECT * FROM catalogue_products WHERE id = $1", [cd.product_id])).rows[0]);
  if (n > product.maxGroup) return { departureId, routed: false }; // the ordinary capacity check says so

  if (partyToken) {
    const party = (await c.query("SELECT * FROM booking_parties WHERE join_token = $1", [String(partyToken)])).rows[0];
    if (!party || !siblings.some((s) => s.id === Number(party.departure_id))) return { departureId, routed: false };
    const st = await partyState(c, party.id);
    const place = placeParty(siblings, { partyOn: Number(party.departure_id), partySeats: st.seats, n, movable: st.movable });
    if (place) {
      const movedParty = place.move ? await moveParty(c, { party: st.party, ids: st.ids, toId: place.id }) : 0;
      const no = siblings.find((s) => s.id === place.id).no;
      return { departureId: place.id, no, opened: false, movedParty };
    }
    if (!st.movable) return { departureId: Number(party.departure_id), routed: false }; // refused there: a party is never split
    if (st.seats + n > product.maxGroup) return { departureId: Number(party.departure_id), routed: false };
    const next = await openNextDeparture(c, cd, siblings);
    if (!next) return { departureId, routed: false };
    const movedParty = await moveParty(c, { party: st.party, ids: st.ids, toId: next.id });
    return { departureId: next.id, no: next.no, opened: true, movedParty };
  }

  const pick = pickDeparture(siblings, n);
  if (pick) return { departureId: pick.id, no: pick.no, opened: false };
  const next = await openNextDeparture(c, cd, siblings);
  if (!next) return { departureId, routed: false };
  return { departureId: next.id, no: next.no, opened: true };
}

// After a booking: when every departure of the date is full, the system opens
// the next one, so a new traveler always has a departure to join.
export async function ensureOpenDeparture(c, legacyDepartureId) {
  const found = await siblingsOf(c, legacyDepartureId);
  if (!found || !allFull(found.siblings)) return null;
  return openNextDeparture(c, found.cd, found.siblings);
}

// Admin: open another departure on the same date on demand.
export async function openAnother(c, legacyDepartureId) {
  const found = await siblingsOf(c, legacyDepartureId);
  if (!found) return null;
  return openNextDeparture(c, found.cd, found.siblings);
}

// The daily sweep: a date whose every departure is already full (a booking made
// before this rule, or a departure filled without the booking route) gets its
// next departure, unless the date's cut-off has passed. Idempotent: it opens
// one only while every departure of the date is full.
export async function openNextForFullDates({ db = pool, now = Date.now(), log = () => {} } = {}) {
  const today = todayIn(now);
  const dates = (await db.query(
    `SELECT cd.product_id, cd.date, MIN(cd.legacy_departure_id) AS any_id
       FROM catalogue_departures cd
       JOIN departures d ON d.id = cd.legacy_departure_id
       JOIN catalogue_departure_seats s ON s.catalogue_departure_id = cd.id
      WHERE cd.status IN ('open', 'go_ahead') AND d.status IN ('open', 'minimum_reached', 'supplier_confirmed') AND cd.date >= $1
      GROUP BY cd.product_id, cd.date
     HAVING bool_and(s.seats_sold >= d.max_seats)`, [today])).rows;
  let opened = 0;
  for (const row of dates) {
    opened += await withTransaction(async (c) => {
      const found = await siblingsOf(c, Number(row.any_id));
      if (!found || !allFull(found.siblings)) return 0;
      const product = mapCatalogueProduct((await c.query("SELECT * FROM catalogue_products WHERE id = $1", [found.cd.product_id])).rows[0]);
      const t = (await c.query("SELECT default_time, nights FROM tour_products WHERE id = $1", [product.legacyProductId])).rows[0];
      const at = departureInstants({ date: ymd(found.cd.date) }, product, { startTime: t?.default_time, nights: t?.nights });
      if (now >= at.cutoffAt) return 0;
      return (await openNextDeparture(c, found.cd, found.siblings)) ? 1 : 0;
    });
  }
  if (opened) log(`catalog: ${opened} further departure(s) opened for full dates`);
  return opened;
}
