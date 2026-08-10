// NN2.1 — the browser's copy of the board rules must answer exactly what the
// server answers.
//
// MM3's category: a rule implemented once, tested once, and re-implemented by
// hand three or four times with a comment asking the next person to keep it in
// sync. Nothing compared the copies. They had already diverged in three ways.
//
// LL1.2 does not cover this. check:status-literals catches a bad status STRING.
// It cannot catch a divergent RULE — change isGoAhead in domain.js, forget the
// copies, and every check in the project still passes while the boards lie
// again, in a new way, silently. This is the check that catches that.
//
// It evaluates site/assets/rules.js — the file the browser actually loads, not
// the module it was generated from — so a broken generator fails here too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as server from "./domain.js";
import { generate } from "../scripts/sync-departure-rules.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_PATH = join(ROOT, "site", "assets", "rules.js");

// Load the generated file the way a browser would: as a script, with a global.
function loadBrowserRules() {
  const src = readFileSync(RULES_PATH, "utf8");
  const globalObj = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(globalObj);
  return globalObj.SawaRules;
}

const browser = loadBrowserRules();

// Every shape that has ever mattered, plus the three that had actually
// diverged. Each case is a departure as the boards receive it.
const CASES = [
  ["a date nobody has booked", { status: "open", minSeats: 4, pledges: [] }],
  ["forming, one traveller", { status: "open", minSeats: 4, pledges: [{ seats: 1, status: "confirmed" }] }],
  ["forming, one short", { status: "open", minSeats: 4, pledges: [{ seats: 3, status: "confirmed" }] }],
  ["exactly at its minimum", { status: "open", minSeats: 4, pledges: [{ seats: 4, status: "confirmed" }] }],
  ["past its minimum", { status: "open", minSeats: 4, pledges: [{ seats: 7, status: "confirmed" }] }],
  ["a listing that requires more than the default", { status: "open", minSeats: 6, pledges: [{ seats: 4, status: "confirmed" }] }],
  ["every booking cancelled", { status: "open", minSeats: 4, pledges: [{ seats: 4, status: "cancelled" }] }],
  ["operator-confirmed with no bookings", { status: "supplier_confirmed", minSeats: 4, pledges: [] }],
  ["cancelled, bookings intact — the KK1 state", { status: "cancelled", minSeats: 4, pledges: [{ seats: 4, status: "confirmed" }] }],
  ["closed", { status: "closed", minSeats: 4, pledges: [{ seats: 4, status: "confirmed" }] }],
  ["awaiting ops review", { status: "pending_review", minSeats: 4, pledges: [{ seats: 4, status: "confirmed" }] }],

  // ---- the three that had actually diverged --------------------------------
  // Stored `minimum_reached`, bookings since cancelled. The hand-written copies
  // trusted the stored value and called it confirmed and running; the server
  // recomputed and called it open.
  //
  // BBBB1 — the server now agrees with the copies. Once a date reaches GoAhead
  // it runs, so this case is here to prove the two sides AGREE rather than to
  // prove they diverge.
  ["stored minimum_reached, bookings since cancelled",
    { status: "minimum_reached", minSeats: 4, pledges: [{ seats: 4, status: "cancelled" }, { seats: 1, status: "confirmed" }] }],
  // `Number(x.seats || x.pax) || 1` turned a seatless row into one traveller.
  ["a pledge row carrying no seats value", { status: "open", minSeats: 4, pledges: [{ status: "confirmed" }] }],
  // `pax` is not a column and never has been.
  ["a pledge row using pax", { status: "open", minSeats: 4, pledges: [{ pax: 3, status: "confirmed" }] }],

  ["no minSeats at all — falls to the default", { status: "open", pledges: [{ seats: 4, status: "confirmed" }] }],
  ["a raw database row using min_seats", { status: "open", min_seats: 6, pledges: [{ seats: 6, status: "confirmed" }] }],
];

test("the generated browser rules exist and expose the whole surface", () => {
  // If this file were empty or the global were misnamed, every comparison below
  // would throw rather than pass — but it would throw confusingly. Fail here.
  assert.ok(browser, "site/assets/rules.js did not define SawaRules");
  for (const name of ["seatsTotal", "goAheadSeatsFor", "statusFor", "isFormingDeparture", "isGoAheadDeparture"]) {
    assert.equal(typeof browser[name], "function", `${name} is missing from the browser copy`);
  }
});

test("the browser answers exactly what the server answers, on every case", () => {
  const disagreements = [];
  for (const [label, departure] of CASES) {
    const asServer = {
      seats: server.seatsTotal(departure.pledges),
      min: server.goAheadSeatsFor(departure),
      status: server.statusFor(departure, departure.pledges),
      forming: server.isFormingDeparture(departure),
      goAhead: server.isGoAheadDeparture(departure),
    };
    const asBrowser = {
      seats: browser.seatsTotal(departure.pledges),
      min: browser.goAheadSeatsFor(departure),
      status: browser.statusFor(departure, departure.pledges),
      forming: browser.isFormingDeparture(departure),
      goAhead: browser.isGoAheadDeparture(departure),
    };
    if (JSON.stringify(asServer) !== JSON.stringify(asBrowser)) {
      disagreements.push(`${label}\n    server:  ${JSON.stringify(asServer)}\n    browser: ${JSON.stringify(asBrowser)}`);
    }
  }
  assert.deepEqual(disagreements, [], `the boards would show something the server does not agree with:\n  ${disagreements.join("\n  ")}`);
});

test("it fires when the copies diverge — W3", () => {
  // The proof this check is worth having. The old hand-written implementation
  // is reproduced exactly and run through the same comparison; it must fail on
  // the three cases that were found. If someone regenerates the browser copy
  // from a modified rule and forgets the server, this is what catches it.
  const old = {
    seatsTotal: (pledges = []) => pledges.reduce((s, x) => (x && x.status === "cancelled" ? s : s + (Number(x.seats || x.pax) || 1)), 0),
    goAheadSeatsFor: (d) => Number(d.minSeats || (d && d.minSeats)) || 4,
    isFormingDeparture(d) {
      if (d.status !== "open") return false;
      const s = this.seatsTotal(d.pledges);
      return s >= 1 && s < this.goAheadSeatsFor(d);
    },
    isGoAheadDeparture(d) {
      if (d.status === "minimum_reached" || d.status === "supplier_confirmed") return true;
      return d.status === "open" && this.seatsTotal(d.pledges) >= this.goAheadSeatsFor(d);
    },
  };

  const diverged = CASES.filter(([, d]) =>
    old.seatsTotal(d.pledges) !== server.seatsTotal(d.pledges)
    || old.isFormingDeparture(d) !== server.isFormingDeparture(d)
    || old.isGoAheadDeparture(d) !== server.isGoAheadDeparture(d));

  // BBBB1 — this expected THREE until 10 August 2026, and the drop to two is
  // not the check weakening. It is a policy change landing.
  //
  // "stored minimum_reached, bookings since cancelled" no longer diverges,
  // because the old hand-written copies TRUSTED the stored value and the server
  // now does too. Under the old rule the copies were wrong; under the client's
  // settled rule — once a date reaches GoAhead it runs — they were accidentally
  // right about a policy that did not exist yet.
  //
  // The two that remain are genuine implementation defects and must still fire.
  assert.ok(
    diverged.length >= 2,
    `the old implementation should disagree with the server on at least two cases; it disagreed on ${diverged.length}`
  );
  const labels = diverged.map(([l]) => l);
  for (const expected of [
    "a pledge row carrying no seats value",
    "a pledge row using pax",
  ]) {
    assert.ok(labels.includes(expected), `the known divergence "${expected}" was not detected`);
  }

  // And the third case must now AGREE, for the stated reason. Asserted rather
  // than deleted: if it starts diverging again, the ratchet has been lost and
  // the promise on the site is no longer true.
  assert.ok(
    !labels.includes("stored minimum_reached, bookings since cancelled"),
    "a confirmed date that dropped below its minimum is diverging again — the BBBB1 ratchet is gone"
  );
});

test("the checked-in browser copy is what the generator produces", () => {
  // A stale rules.js would pass every comparison above — it would just be
  // comparing the OLD generated file against the NEW server. This is the check
  // that the file in the repository is current.
  assert.equal(
    readFileSync(RULES_PATH, "utf8"),
    generate(),
    "site/assets/rules.js is stale — run `npm run sync:rules`"
  );
});
