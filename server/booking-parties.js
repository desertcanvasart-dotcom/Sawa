// Group bookings (migration 056), behind catalogue_v2.
//
// A traveler who has booked gets a "Join my group" link. Anyone who books
// through it books the same departure and joins the same party. A party is only
// a grouping: each member keeps its own booking, its own seats and its own
// payment request at GoAhead (mode C). What the party changes is the operator's
// manifest, where its members are listed together under one lead contact.
//
// A party never holds seats. Joining is an ordinary booking, refused past the
// free seats like any other, and the link says how many are left.
//
// Staff can link existing bookings on one date into a party, and unlink them.
import { randomBytes } from "node:crypto";
import { pool, withTransaction } from "./db/index.js";
import { BRAND } from "./brand.js";
import { CatalogueError } from "./catalogue.js";
import { seatsHeldForWaitlist } from "./pay-at-goahead.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const site = () => String(process.env.APP_URL || BRAND.url || "").replace(/\/$/, "");

// Dates a party can be formed on or joined: live and taking bookings.
export const JOINABLE_STATUSES = ["open", "minimum_reached", "supplier_confirmed"];

export const joinUrl = (token) => `${site()}/join/${encodeURIComponent(token)}`;
const newToken = () => randomBytes(12).toString("base64url");
const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

// Whether migration 056 is applied. Asked before any party query so a missing
// table never aborts the surrounding transaction.
export async function partiesAvailable(db) {
  return (await db.query("SELECT to_regclass('booking_parties') IS NOT NULL AS ok")).rows[0].ok === true;
}

async function requireParties(db) {
  if (!(await partiesAvailable(db))) throw new CatalogueError(503, "Group bookings need migration 056. Apply it and try again.");
}

async function isCatalogueDeparture(c, departureId) {
  return (await c.query("SELECT 1 FROM catalogue_departures WHERE legacy_departure_id = $1", [departureId])).rowCount > 0;
}

// Seats still for sale on the date: capacity less the live seats and the seats
// held for waitlist offers.
export async function seatsLeft(c, departureId) {
  const r = (await c.query(
    `SELECT d.max_seats, COALESCE((SELECT SUM(seats) FROM pledges WHERE departure_id = d.id AND status <> 'cancelled'), 0) AS booked
       FROM departures d WHERE d.id = $1`, [departureId])).rows[0];
  if (!r) return 0;
  const held = await seatsHeldForWaitlist(c, departureId);
  return Math.max(0, Number(r.max_seats) - Number(r.booked) - Number(held || 0));
}

async function createParty(c, { departureId, leadPledgeId, by }) {
  return (await c.query(
    `INSERT INTO booking_parties (departure_id, lead_pledge_id, join_token, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [departureId, leadPledgeId, newToken(), by])).rows[0];
}

// The party's lead: the booking that started it while it is live, otherwise
// the earliest live member.
async function leadOf(c, party) {
  const r = await c.query(
    `SELECT id, customers, customer_phone, booking_code FROM pledges
      WHERE party_id = $1 AND status <> 'cancelled'
      ORDER BY (id = $2) DESC, created_at, id LIMIT 1`, [party.id, party.lead_pledge_id || ""]);
  return r.rows[0] || null;
}

// The traveler's own link, from their booking code. Any member may share it;
// the first request starts the party with that booking as its lead.
export async function partyLinkFor(db, { code }) {
  await requireParties(db);
  return inTx(db, async (c) => {
    // The date is locked before the booking, the order every booking write takes.
    const found = (await c.query("SELECT id, departure_id FROM pledges WHERE UPPER(booking_code) = UPPER($1)", [code])).rows[0];
    if (!found) throw new CatalogueError(404, "Booking not found.");
    const dep = (await c.query("SELECT id, status FROM departures WHERE id = $1 FOR UPDATE", [found.departure_id])).rows[0];
    const p = (await c.query("SELECT id, departure_id, status, party_id FROM pledges WHERE id = $1 FOR UPDATE", [found.id])).rows[0];
    if (!p) throw new CatalogueError(404, "Booking not found.");
    if (p.status === "cancelled") throw new CatalogueError(409, "This booking was canceled, so it can't invite a group.");
    if (!dep || !JOINABLE_STATUSES.includes(dep.status)) throw new CatalogueError(409, "This date isn't taking bookings, so it can't take a group.");
    if (!(await isCatalogueDeparture(c, dep.id))) throw new CatalogueError(409, "Group links aren't available for this date.");
    let party = p.party_id ? (await c.query("SELECT * FROM booking_parties WHERE id = $1", [p.party_id])).rows[0] : null;
    const created = !party;
    if (!party) {
      party = await createParty(c, { departureId: dep.id, leadPledgeId: p.id, by: "traveler" });
      await c.query("UPDATE pledges SET party_id = $2 WHERE id = $1", [p.id, party.id]);
    }
    return { partyId: party.id, token: party.join_token, url: joinUrl(party.join_token), seatsLeft: await seatsLeft(c, dep.id), created };
  });
}

// What the booking page shows about the booking's party, if any. Reads only.
export async function partyForBooking(db, pledgeId) {
  if (!(await partiesAvailable(db))) return null;
  const r = (await db.query(
    `SELECT bp.* FROM pledges p JOIN booking_parties bp ON bp.id = p.party_id WHERE p.id = $1`, [pledgeId])).rows[0];
  if (!r) return null;
  const members = (await db.query(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(seats), 0)::int AS seats FROM pledges WHERE party_id = $1 AND status <> 'cancelled'", [r.id])).rows[0];
  return { url: joinUrl(r.join_token), bookings: members.n, seats: members.seats, seatsLeft: await seatsLeft(db, r.departure_id) };
}

// GET /api/public/parties/:token: what the link shows before anyone books.
export async function partyView(db, { token }) {
  await requireParties(db);
  const party = (await db.query("SELECT * FROM booking_parties WHERE join_token = $1", [String(token || "")])).rows[0];
  if (!party) throw new CatalogueError(404, "This group link isn't valid.");
  const lead = await leadOf(db, party);
  const members = (await db.query(
    "SELECT COALESCE(SUM(seats), 0)::int AS seats FROM pledges WHERE party_id = $1 AND status <> 'cancelled'", [party.id])).rows[0];
  const dep = (await db.query("SELECT id, status FROM departures WHERE id = $1", [party.departure_id])).rows[0];
  return {
    departureId: Number(party.departure_id),
    departureStatus: dep?.status || null,
    leadFirstName: lead ? firstName(lead.customers) : null,
    groupSeats: members.seats,
    seatsLeft: await seatsLeft(db, party.departure_id),
  };
}

// Inside the public booking's transaction: the party a booking made through a
// link joins. Locked so two joins can't both read the same free seats.
export async function partyToJoin(c, { token, departureId }) {
  if (!(await partiesAvailable(c))) throw new CatalogueError(404, "This group link isn't valid.");
  const party = (await c.query("SELECT * FROM booking_parties WHERE join_token = $1 FOR UPDATE", [String(token || "")])).rows[0];
  if (!party) throw new CatalogueError(404, "This group link isn't valid.");
  if (Number(party.departure_id) !== Number(departureId)) throw new CatalogueError(409, "This group link is for a different date.");
  return party;
}

export async function joinParty(c, { partyId, pledgeId }) {
  await c.query("UPDATE pledges SET party_id = $2 WHERE id = $1", [pledgeId, partyId]);
}

async function lockPledges(c, ids) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) throw new CatalogueError(422, "Choose the bookings.");
  // Their dates first, then the bookings: the order every booking write takes.
  const depIds = (await c.query("SELECT DISTINCT departure_id FROM pledges WHERE id = ANY($1::text[]) ORDER BY departure_id", [list])).rows;
  for (const d of depIds) await c.query("SELECT id FROM departures WHERE id = $1 FOR UPDATE", [d.departure_id]);
  const rows = (await c.query(
    "SELECT id, departure_id, status, party_id, created_at FROM pledges WHERE id = ANY($1::text[]) ORDER BY created_at, id FOR UPDATE", [list])).rows;
  if (rows.length !== list.length) throw new CatalogueError(404, "One of those bookings no longer exists.");
  return rows;
}

// Staff link bookings on one date into a party. Bookings already in a party
// join it; bookings from two different parties are refused (unlink one first).
export async function linkParty(db, { pledgeIds, by }) {
  await requireParties(db);
  return inTx(db, async (c) => {
    const rows = await lockPledges(c, pledgeIds);
    if (rows.length < 2) throw new CatalogueError(422, "Choose at least two bookings to link.");
    if (rows.some((p) => p.status === "cancelled")) throw new CatalogueError(409, "A canceled booking can't be linked.");
    const deps = new Set(rows.map((p) => Number(p.departure_id)));
    if (deps.size > 1) throw new CatalogueError(409, "Only bookings on the same date can travel as one group.");
    const departureId = [...deps][0];
    if (!(await isCatalogueDeparture(c, departureId))) throw new CatalogueError(409, "Groups are for catalog departures only.");
    const parties = [...new Set(rows.map((p) => p.party_id).filter((v) => v != null).map(Number))];
    if (parties.length > 1) throw new CatalogueError(409, "These bookings are already in two different groups. Unlink one group first.");
    const party = parties.length
      ? (await c.query("SELECT * FROM booking_parties WHERE id = $1 FOR UPDATE", [parties[0]])).rows[0]
      : await createParty(c, { departureId, leadPledgeId: rows[0].id, by });
    const added = rows.filter((p) => Number(p.party_id) !== Number(party.id)).map((p) => p.id);
    if (added.length) await c.query("UPDATE pledges SET party_id = $2 WHERE id = ANY($1::text[])", [added, party.id]);
    return { partyId: Number(party.id), departureId, linked: added, created: !parties.length };
  });
}

// Staff take bookings out of their party. A party left with no bookings is
// removed, and its link stops working; one whose lead left gets the earliest
// remaining booking as its lead.
export async function unlinkParty(db, { pledgeIds, by }) {
  await requireParties(db);
  return inTx(db, async (c) => {
    const rows = (await lockPledges(c, pledgeIds)).filter((p) => p.party_id != null);
    if (!rows.length) throw new CatalogueError(409, "None of those bookings is in a group.");
    const parties = [...new Set(rows.map((p) => Number(p.party_id)))];
    await c.query("UPDATE pledges SET party_id = NULL WHERE id = ANY($1::text[])", [rows.map((p) => p.id)]);
    const removed = [];
    for (const id of parties) {
      const next = (await c.query(
        "SELECT id FROM pledges WHERE party_id = $1 ORDER BY (status <> 'cancelled') DESC, created_at, id LIMIT 1", [id])).rows[0];
      if (!next) {
        await c.query("DELETE FROM booking_parties WHERE id = $1", [id]);
        removed.push(id);
      } else {
        await c.query(
          `UPDATE booking_parties SET lead_pledge_id = $2
            WHERE id = $1 AND (lead_pledge_id IS NULL OR lead_pledge_id = ANY($3::text[]))`, [id, next.id, rows.map((p) => p.id)]);
      }
    }
    return { unlinked: rows.map((p) => p.id), parties, removedParties: removed, by };
  });
}

// ---------------------------------------------------------------- manifest
// Orders a departure's bookings so each party's members follow its lead, and
// marks them. Pure: `party_lead_pledge_id` comes from the manifest's query.
// Bookings outside a party keep their order.
export function groupParties(pledges) {
  const byParty = new Map();
  for (const p of pledges) {
    if (p.party_id == null) continue;
    const k = String(p.party_id);
    if (!byParty.has(k)) byParty.set(k, []);
    byParty.get(k).push(p);
  }
  const out = [];
  const done = new Set();
  for (const p of pledges) {
    if (p.party_id == null) { out.push(p); continue; }
    const k = String(p.party_id);
    if (done.has(k)) continue;
    done.add(k);
    const members = byParty.get(k);
    if (members.length < 2) { out.push(members[0]); continue; }
    const lead = members.find((m) => m.id === m.party_lead_pledge_id) || members[0];
    const size = members.reduce((s, m) => s + Math.max(1, Number(m.seats) || 1), 0);
    const party = { lead: String(lead.customers || "").trim(), leadBooking: lead.booking_code || String(lead.id).slice(-8), size };
    out.push({ ...lead, _party: { ...party, isLead: true } });
    for (const m of members) if (m !== lead) out.push({ ...m, _party: { ...party, isLead: false } });
  }
  return out;
}
