// The automatic EUR/EGP rate (064). Two rates, kept apart:
//
//   market rate    EGP per 1 EUR, a row a day in fx_rates (the Finance rate
//                  table), fetched daily (runFxDaily) or entered by hand. A
//                  fetched rate more than 5% from the previous one waits as
//                  `pending` until an admin approves it. Only approved rows
//                  are ever read (approvedFx below; finance.js and the
//                  statements use the same filter).
//   traveler rate  site-wide, behind catalogue_v2: the latest approved market
//                  rate less the buffer (Finance, default 3%), renewed weekly
//                  or at once when the market moves more than 3%. Every
//                  change is a row in fx_traveller_rates. A booking stores the
//                  one in force (pledges.published_eur_rate) and is charged
//                  at it.
//
// The rules are shared/fx-rules.js; this is the storage, the fetch and the
// alerts. Where the rate comes from: docs/fx/REPORT.md.
import { pool, withTransaction } from "./db/index.js";
import { CatalogueError, todayIn } from "./catalogue.js";
import { catalogueV2Enabled } from "./features.js";
import {
  DEFAULT_BUFFER_PCT, APPROVAL_JUMP_PCT, needsApproval, changePct, travellerRateFrom, travellerUpdateDue, bufferError,
} from "../shared/fx-rules.js";

const inTx = (db, fn) => (db === pool ? withTransaction(fn) : fn(db));
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = (v) => (v == null ? null : Number(v));
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const DAY_MS = 24 * 60 * 60 * 1000;

// SQL for "the rates anything may use". Every reader of fx_rates filters on it.
export const APPROVED_FX = "status = 'approved'";

// ---------------------------------------------------------------- providers
// Tried in order; the first good answer is stored with its name. Each returns
// { egpPerEur, asOf (YYYY-MM-DD), source }.
//
//   frankfurter-cbe   the Central Bank of Egypt's official rate (the midpoint
//                     of its buy and sell), republished as JSON by Frankfurter
//                     (open source, no key). CBE publishes Sunday to Thursday;
//                     on other days the answer is the last published rate.
//   exchangerate-api  ExchangeRate-API's open access endpoint (no key): a
//                     market midpoint from its own blend of sources, daily.
//
// FX_PROVIDERS picks and orders them (comma-separated); the default is both,
// CBE first.
export const PROVIDERS = {
  "frankfurter-cbe": {
    label: "Central Bank of Egypt (via Frankfurter), buy/sell midpoint",
    url: "https://api.frankfurter.dev/v2/providers/CBE/rate/EUR/EGP",
    parse(j) {
      if (j?.base !== "EUR" || j?.quote !== "EGP") throw new Error("unexpected pair in the answer");
      return { egpPerEur: Number(j.rate), asOf: ymd(j.date) };
    },
  },
  "exchangerate-api": {
    label: "ExchangeRate-API open access, market midpoint",
    url: "https://open.er-api.com/v6/latest/EUR",
    parse(j) {
      if (j?.result !== "success" || j?.base_code !== "EUR") throw new Error(`answer was ${j?.result || "not a success"}`);
      const at = Number(j.time_last_update_unix);
      return { egpPerEur: Number(j.rates?.EGP), asOf: Number.isFinite(at) ? new Date(at * 1000).toISOString().slice(0, 10) : null };
    },
  },
};
export const DEFAULT_PROVIDERS = ["frankfurter-cbe", "exchangerate-api"];

export function providerOrder(env = process.env) {
  const list = String(env.FX_PROVIDERS || "").split(",").map((s) => s.trim()).filter((k) => PROVIDERS[k]);
  return list.length ? list : DEFAULT_PROVIDERS;
}

// A rate older than this is not today's rate (a provider that stopped
// updating): treated as a failed fetch. CBE's weekend is two days.
const STALE_DAYS = 5;

export async function fetchMarketRate({ fetchImpl = globalThis.fetch, env = process.env, now = Date.now() } = {}) {
  const errors = [];
  for (const key of providerOrder(env)) {
    const p = PROVIDERS[key];
    try {
      const res = await fetchImpl(p.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout?.(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = p.parse(await res.json());
      if (!(out.egpPerEur > 0) || out.egpPerEur > 10000) throw new Error(`no usable EGP rate (${out.egpPerEur})`);
      if (out.asOf && Date.parse(`${todayIn(now)}T00:00:00Z`) - Date.parse(`${out.asOf}T00:00:00Z`) > STALE_DAYS * DAY_MS) {
        throw new Error(`rate is from ${out.asOf}, more than ${STALE_DAYS} days old`);
      }
      return { egpPerEur: Math.round(out.egpPerEur * 10000) / 10000, asOf: out.asOf, source: key, sourceLabel: p.label };
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
    }
  }
  const err = new Error(`every exchange-rate source failed — ${errors.join("; ")}`);
  err.fxErrors = errors;
  throw err;
}

// ---------------------------------------------------------------- market rates
const mapFx = (x) => x && ({
  day: ymd(x.day), egpPerEur: Number(x.egp_per_eur), status: x.status || "approved", source: x.source || "manual",
  sourceNote: x.source_note, fetchedAt: iso(x.fetched_at), providerAsOf: ymd(x.provider_as_of),
  previousEgpPerEur: num(x.previous_egp_per_eur), decidedBy: x.decided_by, decidedAt: iso(x.decided_at),
  enteredBy: x.entered_by, enteredAt: iso(x.entered_at),
});

export async function latestApprovedFx(db = pool, { before = null } = {}) {
  const r = await db.query(
    `SELECT * FROM fx_rates WHERE ${APPROVED_FX} AND ($1::date IS NULL OR day < $1) ORDER BY day DESC LIMIT 1`, [before]);
  return mapFx(r.rows[0]) || null;
}

// ---------------------------------------------------------------- alerts
const mapAlert = (a) => ({ id: Number(a.id), kind: a.kind, detail: a.detail || {}, createdAt: iso(a.created_at), updatedAt: iso(a.updated_at), emailedAt: iso(a.emailed_at) });

export async function openFxAlerts(db = pool) {
  return (await db.query("SELECT * FROM fx_alerts WHERE resolved_at IS NULL ORDER BY created_at")).rows.map(mapAlert);
}

// One open alert per kind: a repeat updates its detail, and emails only the
// first time (an admin is not mailed every day for the same failure).
async function raiseAlert(db, { kind, detail, send }) {
  const r = await db.query(
    `INSERT INTO fx_alerts (kind, detail) VALUES ($1, $2)
     ON CONFLICT (kind) WHERE resolved_at IS NULL DO UPDATE SET detail = EXCLUDED.detail, updated_at = now()
     RETURNING id, emailed_at`,
    [kind, JSON.stringify(detail)]);
  const row = r.rows[0];
  if (row.emailed_at || !send) return { id: Number(row.id), emailed: false };
  const { fxAlertEmail, opsRecipient } = await import("./email.js");
  const res = await send(fxAlertEmail({ to: opsRecipient(), kind, detail, portalUrl: financeUrl() }))
    .catch((e) => ({ ok: false, error: e.message }));
  if (res?.ok) await db.query("UPDATE fx_alerts SET emailed_at = now() WHERE id = $1", [row.id]);
  return { id: Number(row.id), emailed: !!res?.ok };
}

async function resolveAlert(db, kind, by) {
  await db.query("UPDATE fx_alerts SET resolved_at = now(), resolved_by = $2 WHERE kind = $1 AND resolved_at IS NULL", [kind, by]);
}

function financeUrl(env = process.env) {
  return `${(env.APP_URL || "https://sawa.tours").replace(/\/$/, "")}/admin/finance`;
}

// ---------------------------------------------------------------- the daily fetch
// Once a day (Cairo): fetch, store, and decide whether the rate may be used.
// A day that already has a row (entered by hand, or fetched earlier) is left
// alone, so running it more often is harmless.
//
//   fetch fails        nothing stored; the last good rate stays in use; the
//                      admin is alerted (once, until a fetch succeeds)
//   > 5% from the last stored as `pending`, the admin alerted; not used until
//     approved rate    approved
//   otherwise          stored as approved
//
// Then, with catalogue_v2 on, the traveler rate is renewed if it is due.
export async function runFxDaily({ db = pool, now = Date.now(), fetchImpl, send = null, env = process.env, log = () => {} } = {}) {
  const day = todayIn(now);
  const existing = (await db.query("SELECT * FROM fx_rates WHERE day = $1", [day])).rows[0];
  let market;
  if (existing) {
    market = { skipped: `${day} already has a rate (${existing.source || "manual"}, ${existing.status || "approved"})` };
  } else {
    const previous = await latestApprovedFx(db, { before: day });
    let got;
    try {
      got = await fetchMarketRate({ fetchImpl, env, now });
    } catch (e) {
      const alert = await raiseAlert(db, {
        kind: "fetch_failed",
        detail: { day, errors: e.fxErrors || [e.message], lastGood: previous ? { day: previous.day, egpPerEur: previous.egpPerEur } : null },
        send,
      });
      log(`fx: fetch failed for ${day}; still using ${previous ? `${previous.egpPerEur} from ${previous.day}` : "no rate"} — ${e.message}`);
      market = { failed: e.message, lastGood: previous?.day || null, alerted: alert.id };
    }
    if (got) {
      await resolveAlert(db, "fetch_failed", "fx-daily");
      const pending = previous ? needsApproval(previous.egpPerEur, got.egpPerEur, APPROVAL_JUMP_PCT) : false;
      await db.query(
        `INSERT INTO fx_rates (day, egp_per_eur, source_note, entered_by, status, source, fetched_at, provider_as_of, previous_egp_per_eur)
         VALUES ($1, $2, $3, 'fx-daily', $4, $5, $6, $7, $8) ON CONFLICT (day) DO NOTHING`,
        [day, got.egpPerEur, got.sourceLabel, pending ? "pending" : "approved", got.source, new Date(now), got.asOf, previous?.egpPerEur ?? null]);
      if (pending) {
        const pct = Math.round(changePct(previous.egpPerEur, got.egpPerEur) * 100) / 100;
        await raiseAlert(db, {
          kind: "rate_pending",
          detail: { day, egpPerEur: got.egpPerEur, previous: { day: previous.day, egpPerEur: previous.egpPerEur }, changePct: pct, source: got.source },
          send,
        });
        log(`fx: ${day} ${got.egpPerEur} is ${pct}% from ${previous.egpPerEur} (${previous.day}); waiting for approval`);
      } else {
        log(`fx: ${day} ${got.egpPerEur} from ${got.source}`);
      }
      market = { day, egpPerEur: got.egpPerEur, source: got.source, status: pending ? "pending" : "approved" };
    }
  }
  const traveller = catalogueV2Enabled(env) ? await updateTravellerRate(db, { now }) : { skipped: "catalogue_v2 is off" };
  if (traveller.changed && db === pool) await releaseHeldPayments({ send, now, env });
  return { market, traveller };
}

// An admin's decision on a pending rate. Approved, it is used from then on
// (and may renew the traveler rate at once); rejected, it is kept for the
// record and never used.
export async function decideFxRate(db, { day, approve, by, now = Date.now(), env = process.env }) {
  return inTx(db, async (c) => {
    const r = await c.query(
      `UPDATE fx_rates SET status = $2, decided_by = $3, decided_at = now()
        WHERE day = $1 AND status = 'pending' RETURNING *`, [day, approve ? "approved" : "rejected", by]);
    if (!r.rowCount) throw new CatalogueError(409, "There is no rate waiting for approval on that day.");
    const left = (await c.query("SELECT 1 FROM fx_rates WHERE status = 'pending' LIMIT 1")).rowCount;
    if (!left) await resolveAlert(c, "rate_pending", by);
    const traveller = approve && catalogueV2Enabled(env) ? await updateTravellerRate(c, { now }) : null;
    return { rate: mapFx(r.rows[0]), traveller };
  });
}

// A rate entered by hand for a day replaces a fetched one, pending included:
// once none is left pending, its alert is resolved.
export async function afterManualRate(db, { by, now = Date.now(), env = process.env } = {}) {
  const left = (await db.query("SELECT 1 FROM fx_rates WHERE status = 'pending' LIMIT 1")).rowCount;
  if (!left) await resolveAlert(db, "rate_pending", by);
  return catalogueV2Enabled(env) ? updateTravellerRate(db, { now }) : null;
}

// ---------------------------------------------------------------- traveler rate
// The public pages cache prices. An admin's change is a write, which clears
// them anyway; the job's is not, so it tells whoever registered here (app.js
// clears the public caches).
// Bookings made while no traveler rate was set wait for one (no payment
// request is sent). Called once a rate has been committed; a failure is
// logged and never undoes the rate.
export async function releaseHeldPayments({ send = null, now = Date.now(), env = process.env } = {}) {
  if (!catalogueV2Enabled(env)) return { requested: 0 };
  try {
    const { releaseHeldPayments: release } = await import("./pay-at-goahead.js");
    return await release({ send, now, env });
  } catch (e) {
    console.error("[fx] releasing held payment requests failed —", e.message);
    return { requested: 0, error: e.message };
  }
}

const changeListeners = [];
export function onTravellerRateChange(fn) { changeListeners.push(fn); }
function announceChange() {
  for (const fn of changeListeners) {
    try { fn(); } catch (e) { console.error("[fx] traveler-rate listener failed —", e.message); }
  }
}

const mapTraveller = (x) => x && ({
  id: Number(x.id), egpPerEur: Number(x.egp_per_eur), marketEgpPerEur: num(x.market_egp_per_eur), marketDay: ymd(x.market_day),
  bufferPct: num(x.buffer_pct), reason: x.reason, note: x.note, setBy: x.set_by, effectiveAt: iso(x.effective_at),
});

export async function travellerBuffer(db = pool) {
  const r = (await db.query("SELECT value FROM finance_settings WHERE key = 'traveller_rate'")).rows[0];
  const b = Number(r?.value?.bufferPct);
  return Number.isFinite(b) ? b : DEFAULT_BUFFER_PCT;
}

export async function setTravellerBuffer(db, { bufferPct, by }) {
  const err = bufferError(bufferPct);
  if (err) throw new CatalogueError(422, err);
  const value = { bufferPct: Math.round(Number(bufferPct) * 100) / 100 };
  await db.query(
    `INSERT INTO finance_settings (key, value, updated_by) VALUES ('traveller_rate', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(value), by]);
  return value;
}

// The traveler rate in force: the latest change. Null before there is one.
export async function currentTravellerRate(db = pool) {
  try {
    return mapTraveller((await db.query("SELECT * FROM fx_traveller_rates ORDER BY effective_at DESC, id DESC LIMIT 1")).rows[0]) || null;
  } catch (e) {
    if (e?.code === "42P01") return null; // before 064
    throw e;
  }
}

export async function travellerRateHistory(db = pool, { limit = 100 } = {}) {
  return (await db.query("SELECT * FROM fx_traveller_rates ORDER BY effective_at DESC, id DESC LIMIT $1", [limit])).rows.map(mapTraveller);
}

// Renew the traveler rate if it is due (shared/fx-rules.js: none yet, a week
// old, or the market 3% from its base). A renewal that would give the same
// rate records nothing. Returns what was done.
export async function updateTravellerRate(db = pool, { now = Date.now() } = {}) {
  const [current, market, bufferPct] = await Promise.all([currentTravellerRate(db), latestApprovedFx(db), travellerBuffer(db)]);
  const reason = travellerUpdateDue({ current, market: market?.egpPerEur, bufferPct, now });
  if (!reason) return { kept: current?.egpPerEur ?? null };
  const next = travellerRateFrom(market.egpPerEur, bufferPct);
  if (current && next === current.egpPerEur && reason !== "market_move") return { kept: current.egpPerEur, checked: reason };
  const r = await db.query(
    `INSERT INTO fx_traveller_rates (egp_per_eur, market_egp_per_eur, market_day, buffer_pct, reason, set_by, effective_at)
     VALUES ($1, $2, $3, $4, $5, 'fx-daily', $6) RETURNING *`,
    [next, market.egpPerEur, market.day, bufferPct, reason, new Date(now)]);
  announceChange();
  return { changed: mapTraveller(r.rows[0]), from: current?.egpPerEur ?? null };
}

// A manual traveler rate, with the reason. Stands until the next weekly or
// early renewal (which works from the market rate at the time of the
// override). The route also writes the audit log.
export async function overrideTravellerRate(db, { egpPerEur, reason, by, now = Date.now() }) {
  const rate = Number(egpPerEur);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10000) throw new CatalogueError(422, "Enter EGP per 1 EUR, e.g. 52.40.");
  const note = String(reason || "").trim();
  if (!note) throw new CatalogueError(422, "Say why the traveler rate is being set by hand.");
  const [market, bufferPct] = await Promise.all([latestApprovedFx(db), travellerBuffer(db)]);
  const r = await db.query(
    `INSERT INTO fx_traveller_rates (egp_per_eur, market_egp_per_eur, market_day, buffer_pct, reason, note, set_by, effective_at)
     VALUES ($1, $2, $3, $4, 'override', $5, $6, $7) RETURNING *`,
    [Math.round(rate * 10000) / 10000, market?.egpPerEur ?? null, market?.day ?? null, bufferPct, note.slice(0, 500), by, new Date(now)]);
  announceChange();
  return mapTraveller(r.rows[0]);
}

// Everything the Finance screen shows about the rate.
export async function fxOverview(db = pool, { now = Date.now() } = {}) {
  const [market, current, bufferPct, history, alerts, pending] = await Promise.all([
    latestApprovedFx(db), currentTravellerRate(db), travellerBuffer(db), travellerRateHistory(db, { limit: 30 }), openFxAlerts(db),
    db.query("SELECT * FROM fx_rates WHERE status = 'pending' ORDER BY day").then((r) => r.rows.map(mapFx)),
  ]);
  return {
    market, traveller: current, bufferPct, history, alerts, pending,
    suggested: market ? travellerRateFrom(market.egpPerEur, bufferPct) : null,
    due: travellerUpdateDue({ current, market: market?.egpPerEur, bufferPct, now }),
    providers: providerOrder().map((k) => ({ key: k, label: PROVIDERS[k].label })),
  };
}
