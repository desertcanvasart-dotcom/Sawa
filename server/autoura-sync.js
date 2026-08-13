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
import { CURRENCY } from "../shared/currency.js";
import { enrichDeparture, seatsTotal } from "./domain.js";
import { recordSuccess, recordFailure } from "./effect-log.js";
import { rethrowIfProgrammerError, surfaceProgrammerError } from "./errors.js";
// NOTE: the db pool is imported lazily inside loadInventory() so this module
// (and its pure payload builder) can be unit-tested without a DATABASE_URL.

const BRAND = () => process.env.AUTOURA_BRAND_KEY || "sawa-tours";
const syncConfigured = () => !!(process.env.AUTOURA_SYNC_URL && process.env.AUTOURA_SYNC_SECRET);

const sign = (secret, t, body) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

// TT1 — every reason a departure is NOT mirrored. One list, stated, testable.
//
// This decision used to live inside buildDeparturePayload as a bare
// `if (dep.status === "pending_review") return null`. It was correct, and it was
// invisible: `POST /api/public/departure-requests` writes a departure and does
// not sync, which is RIGHT — but the route author did not decide that, the
// payload builder did. Four other callers got the same question wrong, and the
// one that got it right did so without knowing.
//
// That is the argument for moving the decision to the boundary rather than
// adding a fifth call site: a caller cannot tell a deliberate silence from a
// forgotten call, because both look like nothing happening.
//
// A status belongs here only WITH a reason. An entry with no reason is how the
// next person learns the wrong general rule — and the reason is what the log
// prints when a sync is withheld, so a silence is legible in production too.
export const NOT_MIRRORED = {
  pending_review:
    "traveller-requested and not yet approved by ops — it is not inventory "
    + "until a human says so, and a partner must not be able to sell it",
};

// NOTE what is deliberately ABSENT: `cancelled`.
//
// A cancelled departure IS mirrored, and must be. It is how the partner system
// learns the date is off — and it is the correction that has never once been
// sent, because no cancelling path called the emitter at all. Autoura has been
// holding departures marked `open`, with their seats, indefinitely.
export function mirrorDecision(departure) {
  if (!departure) return { mirror: false, reason: "no such departure" };
  const withheld = NOT_MIRRORED[departure.status];
  if (withheld) return { mirror: false, reason: withheld };
  return { mirror: true, reason: null };
}

// Pure: departure INVENTORY -> the wire payload. Returns null for states that
// must not be mirrored — see NOT_MIRRORED above for which, and why.
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
  if (!mirrorDecision(dep).mirror) return null;
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
      currency: CURRENCY,
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
      if (res.ok) {
        // ZZ2.1 — the thing `autoura: on` never said.
        recordSuccess("autouraSync");
        return true;
      }
      // 4xx = our payload/config is wrong; retrying won't help.
      if (res.status < 500) {
        recordDivergence(payload, `rejected ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return false;
      }
      throw new Error(`upstream ${res.status}`);
    } catch (e) {
      // AAA2 — this handler was written for a network failure. A ReferenceError
      // reaching it means the code is wrong, and retrying it twice more is two
      // more identical failures.
      rethrowIfProgrammerError(e);
      if (attempt === 3) {
        recordDivergence(payload, `gave up after 3 attempts: ${e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return false;
}

// TT2 — a sync that exhausts its retries leaves the two systems disagreeing,
// and nothing is scheduled to notice.
//
// It used to be a console.warn: the same shape as every other line in the log,
// and the same shape as a successful run, which prints nothing at all. Silent
// divergence and a working mirror rendered identically.
//
// So it is an ERROR, it is counted, and the count is readable — by
// /api/modes for a human, and by any job that wraps a write so it can exit
// non-zero. The same three-state discipline as PP2's loud zero: synced,
// deliberately withheld, and FAILED must never look alike.
//
// This does not reconcile anything. The mirror is complete after TT1; it is not
// reliable, and a reconciliation pass is separate work. What this buys is that
// the divergence is known rather than assumed away.
const divergences = [];
const MAX_REMEMBERED = 50;

function recordDivergence(payload, why) {
  const id = payload?.departure?.externalId ?? "unknown";
  recordFailure("autouraSync", `#${id}: ${why}`);
  const entry = { departureId: String(id), why, at: new Date().toISOString() };
  divergences.push(entry);
  if (divergences.length > MAX_REMEMBERED) divergences.shift();
  console.error(
    `[autoura-sync] DIVERGED — departure ${entry.departureId} was not mirrored: ${why}. `
    + "The external system now disagrees with Sawa about this date, and nothing will correct it."
  );
}

// What /api/modes reports, and what a job can check before exiting.
export function syncDivergences() {
  return { count: divergences.length, entries: divergences.slice(-10) };
}

// Test seam. Never called in production — a divergence must not be clearable by
// anything except the sync succeeding.
export function __resetDivergences() {
  divergences.length = 0;
}

// Fire-and-forget: callers never await this and it never throws.
// Fire-and-forget for a route — a mirror outage must never delay a traveller's
// booking — but the promise is RETURNED and tracked, because a short-lived
// process has to be able to wait for it.
//
// Found by running this end to end: the CLI job does `pool.end()` as soon as the
// work finishes, so every emit it started died with
// "Cannot use a pool after calling end on the pool". Fire-and-forget and a
// process that exits are incompatible, and nothing said so — the failure was
// swallowed by the same .catch() that hid the ReferenceError below.
const inFlight = new Set();

export async function drainDepartureSyncs() {
  await Promise.allSettled([...inFlight]);
}

export function emitDepartureSync(departureId) {
  if (!syncConfigured() || !departureId) return Promise.resolve();
  const task = (async () => {
    // `loadEnriched` — the name this called for the whole life of the mirror.
    // No such function has ever existed. Every emit threw a ReferenceError,
    // which the .catch() below downgraded to a console.warn, so the mirror has
    // NEVER sent anything and nothing said so. See TT1's report.
    const dep = await loadInventory(Number(departureId));
    // TT1 — a deliberate silence says why. Before this, a withheld sync and a
    // forgotten call both produced nothing at all in the log, which is why four
    // writers went years without anyone noticing they never emitted.
    const decision = mirrorDecision(dep);
    if (!decision.mirror) {
      console.log(`[autoura-sync] #${departureId} withheld: ${decision.reason}`);
      return;
    }
    await postWithRetry(buildDeparturePayload(dep));
  })().catch((e) => {
    // AAA2 — the exact line that absorbed `loadEnriched is not defined` on every
    // call, for the life of this feature.
    recordDivergence({ departure: { externalId: departureId } }, `emit failed: ${e.message}`);
    // CCC2.2 — surfaced, not fatal. This runs AFTER commit (see
    // withDepartureWrites): the departure is already written and the response
    // already sent, so dying here loses the emit AND the process, and corrects
    // nothing. What the mirror needed was to be visible, and it now is —
    // counted under `programmerErrors`, with `codeIsWrong` true in /api/modes
    // from the first call rather than after years.
    surfaceProgrammerError("autouraSync", e);
  });
  inFlight.add(task);
  task.finally(() => inFlight.delete(task));
  return task;
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
    // AAA2 — fail-open is right for an unreachable feed. It is not right for a
    // typo, which would fail open forever and look like a partner outage.
    rethrowIfProgrammerError(e);
    console.warn("[autoura-sync] capacity feed unavailable:", e.message);
    capacityCache.at = Date.now(); // don't hammer a dead endpoint
  }
  return capacityCache.blackouts;
}
