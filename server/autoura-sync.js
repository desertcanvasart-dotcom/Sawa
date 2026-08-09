// ============================================
// AUTOURA SYNC — the Sawa side of the departure mirror
// ============================================
// Eastbound: every departure change POSTs a signed `departure.sync`
// snapshot to Autoura (/api/webhooks/departures), where it upserts into
// the Sawa Tours tenant's tour_departures. Fire-and-forget with retries:
// the mirror is a convenience copy and must never fail a booking.
//
// Westbound: Autoura's capacity feed (/api/integrations/capacity) tells
// us the operator's blackout dates; travelers must not start a date the
// operation can't run, whatever the tour's weekly pattern allows.
//
// Both directions share one secret: AUTOURA_SYNC_SECRET. Everything is
// disabled cleanly when the env vars are absent (local dev, tests).
//
// Env: AUTOURA_SYNC_URL      e.g. https://getautoura.net/api/webhooks/departures
//      AUTOURA_CAPACITY_URL  e.g. https://getautoura.net/api/integrations/capacity
//      AUTOURA_SYNC_SECRET   shared HMAC secret (same value on both apps)
//      AUTOURA_BRAND_KEY     default "sawa-tours"
// ============================================

import { createHmac } from "node:crypto";
import { mapDeparture } from "./db/mappers.js";
import { enrichDeparture, seatsTotal } from "./domain.js";
// NOTE: the db pool is imported lazily inside loadEnriched() so this module
// (and its pure payload builder) can be unit-tested without a DATABASE_URL.

const BRAND = () => process.env.AUTOURA_BRAND_KEY || "sawa-tours";
const syncConfigured = () => !!(process.env.AUTOURA_SYNC_URL && process.env.AUTOURA_SYNC_SECRET);

const sign = (secret, t, body) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

// Pure: departure INVENTORY -> the wire payload. Returns null for states that
// must not be mirrored (pending_review is Sawa-internal).
//
// Y2.1 — this used to take the enriched departure, pledges and all, and read a
// single integer off it via seatsTotal(). The rows it was handed carry customer
// names, emails, phones and booking codes, so exporting personal data to an
// external system was one field away, added in good faith, with nothing at the
// call site to suggest it was a boundary.
//
// It now receives seatsTaken already counted and never holds a pledge. A field
// added here cannot leak a traveller's details because those details are not in
// scope — structural impossibility rather than a guard that has to keep being
// right. The test that pins the field list stays as a second line.
export function buildDeparturePayload(inventory) {
  const dep = inventory;
  if (!dep || dep.status === "pending_review") return null;
  return {
    brand: BRAND(),
    event: "departure.sync",
    sentAt: new Date().toISOString(),
    departure: {
      externalId: String(dep.id),
      route: dep.route,
      type: dep.type || "day_tour",
      date: dep.startDate || dep.date,
      endDate: dep.endDate || null,
      time: dep.time || null,
      city: dep.city || null,
      minSeats: Number(dep.minSeats) || 4,
      maxSeats: Number(dep.maxSeats) || 12,
      seatsTaken: Number(dep.seatsTaken) || 0,
      status: dep.status,
      priceFrom: Number(dep.livePrice) || Number(dep.publishedRate) || null,
      currency: "USD",
    },
  };
}

// Loads the departure and reduces it to INVENTORY before returning.
//
// The pledge rows never leave this function. They are counted here and the
// count is what travels onward, so nothing downstream — this module's payload
// builder or anything added to it later — is holding personal data it could
// accidentally serialise.
async function loadInventory(departureId) {
  const { pool } = await import("./db/index.js");
  const dep = await pool.query("SELECT * FROM departures WHERE id=$1", [departureId]);
  if (!dep.rows.length) return null;
  const pledges = await pool.query(
    "SELECT status, seats FROM pledges WHERE departure_id=$1 ORDER BY created_at ASC, id ASC",
    [departureId]
  );
  const enriched = enrichDeparture(mapDeparture(dep.rows[0], pledges.rows));
  const seatsTaken = seatsTotal(enriched.pledges || []);
  return {
    id: enriched.id, route: enriched.route, type: enriched.type,
    date: enriched.date, startDate: enriched.startDate, endDate: enriched.endDate,
    time: enriched.time, city: enriched.city,
    minSeats: enriched.minSeats, maxSeats: enriched.maxSeats,
    status: enriched.status, livePrice: enriched.livePrice,
    publishedRate: enriched.publishedRate,
    seatsTaken,
  };
}

async function postWithRetry(payload) {
  const body = JSON.stringify(payload);
  const secret = process.env.AUTOURA_SYNC_SECRET;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const t = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(process.env.AUTOURA_SYNC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Autoura-Timestamp": String(t),
          "X-Autoura-Signature": `t=${t},v1=${sign(secret, t, body)}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
      // 4xx = our payload/config is wrong; retrying won't help.
      if (res.status < 500) {
        console.warn("[autoura-sync] rejected", res.status, (await res.text()).slice(0, 200));
        return false;
      }
      throw new Error(`upstream ${res.status}`);
    } catch (e) {
      if (attempt === 3) {
        console.warn("[autoura-sync] gave up after 3 attempts:", e.message);
        return false;
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

// Fire-and-forget: callers never await this and it never throws.
export function emitDepartureSync(departureId) {
  if (!syncConfigured() || !departureId) return;
  (async () => {
    const dep = await loadEnriched(Number(departureId));
    const payload = buildDeparturePayload(dep);
    if (payload) await postWithRetry(payload);
  })().catch((e) => console.warn("[autoura-sync] emit failed:", e.message));
}

// ---- Westbound: operator blackout dates ------------------------------------

let capacityCache = { at: 0, blackouts: new Set() };
const CAPACITY_TTL = 10 * 60 * 1000;

// Fail-open: if the feed is unreachable, travelers can still request —
// ops reviews every request anyway (Phase A) and can decline.
export async function unavailableDates() {
  if (!(process.env.AUTOURA_CAPACITY_URL && process.env.AUTOURA_SYNC_SECRET)) return new Set();
  if (Date.now() - capacityCache.at < CAPACITY_TTL) return capacityCache.blackouts;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const url = `${process.env.AUTOURA_CAPACITY_URL}?brand=${encodeURIComponent(BRAND())}&days=120`;
    const res = await fetch(url, {
      headers: { "x-sync-secret": process.env.AUTOURA_SYNC_SECRET },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      capacityCache = { at: Date.now(), blackouts: new Set(data.blackouts || []) };
    }
  } catch (e) {
    console.warn("[autoura-sync] capacity feed unavailable:", e.message);
    capacityCache.at = Date.now(); // don't hammer a dead endpoint
  }
  return capacityCache.blackouts;
}
