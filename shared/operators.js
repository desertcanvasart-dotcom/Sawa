// Operator rules with no database (model phase 2): document kinds, strikes,
// the roster deadline, rate bands and the expected operator amount. Display
// only in this phase; nothing is paid from these numbers yet.
import { usesDeadline } from "./catalogue.js";

export const OPERATOR_STATUSES = ["pending", "active", "suspended", "removed"];
export const DOCUMENT_KINDS = ["tourism_license", "etaa_membership", "liability_insurance", "vehicle_insurance"];
export const DOCUMENT_LABELS = {
  tourism_license: "Tourism license",
  etaa_membership: "ETAA membership",
  liability_insurance: "Public liability insurance",
  vehicle_insurance: "Vehicle insurance",
};
export const STRIKE_KINDS = ["missed_acknowledgement", "unapproved_substitution", "shopping_stop", "service_failure", "other"];
export const STRIKE_LABELS = {
  missed_acknowledgement: "Missed acknowledgement",
  unapproved_substitution: "Unapproved substitution",
  shopping_stop: "Shopping stop",
  service_failure: "Documented service failure",
  other: "Other",
};

// Decided 27 Sep 2026.
export const ACK_HOURS = 12;
export const STRIKE_WINDOW_DAYS = 90;
export const STRIKE_FLAG_AT = 3;              // 3 in 90 days: flagged for fewer roster days
export const DOCUMENT_REMINDER_DAYS = [30, 7];
export const MANIFEST_ACCESS_DAYS = 90;       // operator access ends 90 days after the departure

// A month is published by the 15th of the month before it.
export function rosterDeadline(month) {
  const [y, m] = String(month).split("-").map(Number);
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}-15`;
}

export const monthOf = (ymd) => String(ymd).slice(0, 7);

// Every date in a month, as YYYY-MM-DD.
export function datesInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

// ---------------------------------------------------------------- rates
// The departure-fee band for a group. A departure run below its minimum on an
// admin override is paid at the 4–6 band (decided 27 Sep 2026), which is what
// any count up to 6 gives.
export function bandFor(travelers) {
  const n = Number(travelers) || 0;
  if (n >= 10) return "10-12";
  if (n >= 7) return "7-9";
  return "4-6";
}

const FEE_KEY = { "4-6": "fee4_6", "7-9": "fee7_9", "10-12": "fee10_12" };
const num = (v) => (v == null || v === "" ? null : Number(v));

// What the rate card says the operator is owed for a departure, from the
// locked rate version and the manifest (Operator Supply Agreement §8–10):
//
//   bandCount      travelers that decide the band: the live manifest before
//                  the cut-off, the manifest frozen at the cut-off after it
//                  (cancellations after the cut-off don't move the band)
//   perHeadCount   travelers paid the per-traveler amount: the same, so a late
//                  cancellation or a no-show is still paid
//   rooms          { twin, single } rooms for cruises and multi-day
//
// Returns { total, lines, missing }: `missing` lists rate fields the card
// hasn't filled, and the total is null while any is missing.
export function expectedOperatorAmount({ type, rate, bandCount, perHeadCount = bandCount, rooms = {} }) {
  if (!rate) return { total: null, lines: [], missing: ["rate version"] };
  const band = bandFor(bandCount);
  const fee = num(rate[FEE_KEY[band]]);
  const lines = [];
  const missing = [];
  const add = (label, qty, unit, key) => {
    if (unit == null) { missing.push(key); return; }
    lines.push({ label, qty, unit, amount: Math.round(qty * unit * 100) / 100 });
  };
  if (usesDeadline(type)) {
    add("Land services per traveler", perHeadCount, num(rate.landPerTraveler), "landPerTraveler");
    if (rooms.twin) add("Twin room or cabin", rooms.twin, num(rate.roomTwin), "roomTwin");
    if (rooms.single) add("Single room or cabin", rooms.single, num(rate.roomSingle), "roomSingle");
  } else {
    add("Per traveler", perHeadCount, num(rate.perTraveler), "perTraveler");
  }
  add(`Departure fee, ${band.replace("-", "–")} travelers`, 1, fee, FEE_KEY[band]);
  const total = missing.length ? null : Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { total, lines, missing, band };
}

// Rooms a manifest needs: a single-rooming booking takes one single room per
// seat; any other booking shares twin rooms, rounded up. Sawa pays the single
// supplement for solo travelers at launch (decided 27 Sep 2026), so an odd
// traveler in a twin booking is a single room here, not a traveler charge.
export function roomsFor(bookings) {
  let twin = 0;
  let single = 0;
  for (const b of bookings) {
    const seats = Number(b.seats) || 0;
    if (b.roomingType === "single") single += seats;
    else { twin += Math.floor(seats / 2); single += seats % 2; }
  }
  return { twin, single };
}

// The rate fields a product type needs before its version can be published.
export function rateFieldsFor(type) {
  return usesDeadline(type)
    ? ["landPerTraveler", "roomTwin", "roomSingle", "fee4_6", "fee7_9", "fee10_12"]
    : ["perTraveler", "fee4_6", "fee7_9", "fee10_12"];
}

// Strikes still counting (not voided, within the window).
export function strikesInWindow(strikes, now = Date.now(), days = STRIKE_WINDOW_DAYS) {
  const from = now - days * 86400000;
  return strikes.filter((s) => !s.voidedAt && Date.parse(s.createdAt) >= from);
}
