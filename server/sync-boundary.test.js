// TT1 / TT2 — the mirror as a consequence of the write, and a failure that is
// audible.
//
// `emitDepartureSync` was called from nine route handlers and nowhere else.
// FOUR writers changed a departure and never reached it:
//
//   admin/tour-products/:id/pricing   a price change, and the payload carries
//                                     priceFrom — never propagated
//   admin/departure-requests/decline  status -> cancelled; the mirror kept the
//                                     date OPEN, indefinitely
//   PATCH admin/bookings/:id          seatsTaken AND status both move
//   jobs/cancel-unconfirmed           the unattended path
//
// And one was correct by accident of what the payload builder does rather than
// by anything the caller decided: `POST /api/public/departure-requests` inserts
// a pending_review departure and does not sync, because the builder returns
// null for it. The route author did not decide that.
//
// That is the argument for the boundary rather than a fifth call site, and for
// NOT_MIRRORED carrying a reason per entry: a caller cannot tell a deliberate
// silence from a forgotten call when both look like nothing happening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeparturePayload, mirrorDecision, NOT_MIRRORED,
  syncDivergences, __resetDivergences,
} from "./autoura-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(join(ROOT, "server", "app.js"), "utf8");
const JOB = readFileSync(join(ROOT, "server", "jobs", "cancel-unconfirmed.js"), "utf8");

// ---- TT1: the decision, and its reasons -----------------------------------

test("every withheld status carries a reason", () => {
  // An entry without one is how the next person learns the wrong general rule.
  // The reason is also what the emitter prints, so a silence is legible in
  // production rather than only in this file.
  assert.ok(Object.keys(NOT_MIRRORED).length >= 1, "nothing is withheld — did the list get emptied?");
  for (const [status, reason] of Object.entries(NOT_MIRRORED)) {
    assert.equal(typeof reason, "string", `${status} has no reason`);
    assert.ok(reason.length > 40, `${status}'s reason is too thin to be one: "${reason}"`);
  }
});

test("pending_review is withheld, and says why", () => {
  const d = mirrorDecision({ status: "pending_review" });
  assert.equal(d.mirror, false);
  assert.match(d.reason, /not yet approved by ops/);
  assert.equal(buildDeparturePayload({ id: 1, status: "pending_review" }), null);
});

test("a CANCELLED departure IS mirrored — the correction that was never sent", () => {
  // The point of the whole change. Two write paths cancelled a departure and
  // never told the mirror, so Autoura has been holding dates as `open`, with
  // their seats, indefinitely. If `cancelled` ever appears in NOT_MIRRORED,
  // that silence comes back.
  assert.ok(!("cancelled" in NOT_MIRRORED), "cancelled must not be withheld");
  assert.equal(mirrorDecision({ status: "cancelled" }).mirror, true);

  const payload = buildDeparturePayload({
    id: 42, status: "cancelled", route: "R", type: "day_tour",
    date: "2026-09-01", city: "Aswan", minSeats: 4, maxSeats: 12,
    publishedRate: 49, seatsTaken: 0,
  });
  assert.ok(payload, "a cancelled departure produced no payload");
  assert.equal(payload.departure.status, "cancelled");
});

test("every live status is mirrored unless the list says otherwise", () => {
  for (const status of ["open", "minimum_reached", "supplier_confirmed", "closed", "cancelled"]) {
    assert.equal(mirrorDecision({ status }).mirror, true, `${status} was unexpectedly withheld`);
  }
});

// ---- TT1.1: the field list is pinned on EVERY path -------------------------

const PINNED = [
  "city", "currency", "date", "endDate", "externalId", "maxSeats", "minSeats",
  "priceFrom", "route", "seatsTaken", "status", "time", "type",
];

// The four paths that now emit, each with the departure shape it produces.
// `loadInventory` builds the same object for all of them — which is the point:
// the narrowing is structural, not per-caller — so this asserts that no path
// can widen it.
const PATHS = {
  "admin/tour-products/:id/pricing": { status: "open", publishedRate: 120, seatsTaken: 1 },
  "admin/departure-requests/:id/decline": { status: "cancelled", seatsTaken: 0 },
  "PATCH admin/bookings/:id": { status: "minimum_reached", seatsTaken: 4 },
  "jobs/cancel-unconfirmed": { status: "cancelled", seatsTaken: 2 },
};

for (const [path, extra] of Object.entries(PATHS)) {
  test(`${path}: the wire payload carries only the pinned fields`, () => {
    const wire = buildDeparturePayload({
      id: 7, route: "Aswan Highlights", type: "day_tour",
      date: "2026-09-01", time: "08:00", city: "Aswan",
      minSeats: 4, maxSeats: 12, publishedRate: 49, ...extra,
    });
    assert.deepEqual(Object.keys(wire.departure).sort(), PINNED,
      "the field list is pinned — widening it is a deliberate act, not an accident");
  });

  test(`${path}: it fires — a personal field on this path does not reach the wire`, () => {
    // W3 for each path individually, not once for the builder. Someone widening
    // one call site is the failure being guarded against, and a single shared
    // assertion would not prove the guard covers the path they widened.
    const wire = JSON.stringify(buildDeparturePayload({
      id: 7, route: "Aswan Highlights", type: "day_tour",
      date: "2026-09-01", city: "Aswan", minSeats: 4, maxSeats: 12,
      publishedRate: 49, ...extra,
      customerEmail: "mariam@example.com",
      customers: "Mariam Hassan",
      bookingCode: "SAWA-ABCDE",
      pledges: [{ seats: 1, status: "confirmed", customerEmail: "mariam@example.com" }],
    }));
    for (const leak of ["mariam@example.com", "Mariam Hassan", "SAWA-ABCDE"]) {
      assert.ok(!wire.includes(leak), `${leak} crossed the boundary on ${path}`);
    }
  });
}

// ---- TT1: the writers actually go through the boundary ---------------------

test("all four writers that were missed now go through withDepartureWrites", () => {
  // Source-level, deliberately: the alternative is a live database and four
  // authenticated routes, and what is being asserted is that the wiring exists
  // at all — which is exactly what was absent before.
  const routes = [
    ['app.post("/api/admin/tour-products/:id/pricing"', APP],
    ['app.post("/api/admin/departure-requests/:id/decline"', APP],
    ['app.patch("/api/admin/bookings/:id"', APP],
    ['app.post("/api/admin/departures/:id/cancel"', APP],
  ];
  for (const [marker, src] of routes) {
    const start = src.indexOf(marker);
    assert.ok(start > 0, `${marker} not found`);
    const body = src.slice(start, src.indexOf("\n}));", start));
    assert.match(body, /withDepartureWrites\(/, `${marker} does not use the boundary`);
    assert.match(body, /touch\(/, `${marker} never marks the departure it changed`);
  }
  assert.match(JOB, /withDepartureWrites\(/, "the cancel job does not use the boundary");
  assert.match(JOB, /touch\(dep\.id\)/, "the cancel job never marks the departure it cancelled");
});

test("the public departure-request path still does NOT sync, and for a stated reason", () => {
  // The case that settled the design. It must stay correct — and it is correct
  // because the DECISION says so, not because the route omits a call.
  const start = APP.indexOf('app.post("/api/public/departure-requests"');
  const body = APP.slice(start, APP.indexOf("\n}));", start));
  assert.ok(!/withDepartureWrites\(/.test(body), "the public request path should not emit");
  assert.equal(mirrorDecision({ status: "pending_review" }).mirror, false);
});

// ---- TT2: a divergence is loud, counted, and visible -----------------------

test("a divergence is counted and surfaced, not warned about", () => {
  __resetDivergences();
  assert.equal(syncDivergences().count, 0);
});

test("/api/modes reports the divergence count", () => {
  // "autoura: on" says the mirror is configured. It does not say whether the
  // mirror is keeping up, and a silently diverged mirror looks identical to a
  // working one from outside.
  assert.match(APP, /autouraDiverged:\s*syncDivergences\(\)\.count/);
});

test("nothing clears a divergence except a successful sync", () => {
  // __resetDivergences is a test seam. If production could clear the count, the
  // count would mean nothing — the same reasoning as the loud zero in PP2.
  const src = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8");
  const calls = src.split("__resetDivergences").length - 1;
  assert.equal(calls, 1, "__resetDivergences is referenced more than once — is production clearing it?");
});

// ---- The two bugs the end-to-end run found ---------------------------------

test("every function the sync module awaits actually exists", () => {
  // `emitDepartureSync` called `loadEnriched`. No such function has ever
  // existed — it threw a ReferenceError on every call since the mirror was
  // introduced, and the .catch() downgraded that to a console.warn. The mirror
  // never sent anything, and nothing said so.
  //
  // The general form of that bug, not the instance: every identifier this
  // module awaits as a call must be declared here or imported.
  const src = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const declared = new Set([
    ...[...code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)].map((m) => m[1]),
    ...[...code.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop())),
    "fetch", "setTimeout", "clearTimeout", "Promise", "JSON", "Number", "String", "Date", "import",
  ]);

  const awaited = [...code.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const missing = [...new Set(awaited)].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `awaited but never defined: ${missing.join(", ")}`);
});

test("it fires — a call to something undefined is caught", () => {
  // W3. Without this, a broken regex above passes on everything.
  const code = 'async function f(){ const dep = await loadEnriched(1); }';
  const declared = new Set([...code.matchAll(/(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]));
  const awaited = [...code.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(awaited.filter((n) => !declared.has(n)), ["loadEnriched"]);
});

test("a short-lived process can wait for its emits", async () => {
  // The second bug: emits are fire-and-forget, and the CLI job closed the pool
  // the moment the work finished — so every sync it started died on "Cannot use
  // a pool after calling end on the pool", swallowed by the same .catch().
  //
  // Fire-and-forget and a process that exits are incompatible. The promise is
  // returned and tracked so a job can drain; a route still does not await.
  const { drainDepartureSyncs, emitDepartureSync } = await import("./autoura-sync.js");
  assert.equal(typeof drainDepartureSyncs, "function");
  const returned = emitDepartureSync(1);            // unconfigured here: resolves immediately
  assert.equal(typeof returned?.then, "function", "emitDepartureSync must return something awaitable");
  await drainDepartureSyncs();
});

test("the cancel job drains before closing its pool", () => {
  assert.match(JOB, /drainDepartureSyncs\(\)/, "the job does not wait for its own syncs");
  const drain = JOB.indexOf("drainDepartureSyncs()");
  const end = JOB.indexOf("pool.end()");
  assert.ok(drain < end && drain > 0, "the drain must come before pool.end()");
});
