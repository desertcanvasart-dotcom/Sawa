// NN2.1 — which board a departure belongs on. One declaration.
//
// This rule was implemented five times: once in server/domain.js, once in
// src/main.jsx, and once each in the inline scripts of site/index.html,
// site/departures.html and site/goahead.html. Each copy carried a comment
// saying "mirrors server/domain.js — keep in sync". Nothing checked that they
// did, and the tests only ever covered the server's copy.
//
// They had already diverged, in three separate ways, before anyone looked:
//
//   1. A pledge with no `seats` value counted as ONE seat on the static boards
//      (`Number(x.seats||x.pax)||1`) and as ZERO on the server
//      (`Number(p.seats || 0)`).
//   2. The static boards accepted `pax` as an alias for `seats`. The server
//      never has.
//   3. A departure STORED as `minimum_reached` whose bookings have since fallen
//      below its minimum is `open` to the server, which recomputes it, and
//      "confirmed and running" to the static boards, which trust the stored
//      value. The GoAhead board would advertise a date the server no longer
//      considers confirmed.
//
// Bug A — the 'canceled'/'cancelled' mismatch — was one instance of this class,
// not a spelling mistake. check:status-literals catches a bad status STRING; it
// cannot catch a divergent RULE. Change isGoAhead here and forget the copies
// and every check in the project still passes while the boards lie again, in a
// new way, silently.
//
// So the copies are gone. This module is the authority:
//   server/domain.js       re-exports it
//   src/main.jsx           imports it
//   site/assets/rules.js   is GENERATED from it, and check:rules fails if stale
//
// Deliberately dependency-free and browser-safe — same constraint as
// group-size.js, and for the same reason: domain.js imports tz.js, tz.js reads
// process.env, and the browser has no process.
import { DEFAULT_GO_AHEAD } from "./group-size.js";

// The threshold for THIS date. A listing may require more than the default — a
// nine-day cruise is not viable at four — so the number on the date wins.
// snake_case is accepted because raw database rows reach this on the server.
export function goAheadSeatsFor(item) {
  return Math.max(1, Number(item?.minSeats || item?.min_seats || DEFAULT_GO_AHEAD));
}

// Cancelled pledges no longer hold their seats, so they must not count toward
// capacity, live pricing, or the go-ahead threshold.
//
// A missing or zero `seats` counts as ZERO. The static boards used to read
// `Number(x.seats||x.pax)||1`, which turns a seatless row into one traveller —
// inventing a person on a public board. The server's reading is the correct one
// and it is now the only one.
export function seatsTotal(pledges = []) {
  return pledges.reduce(
    (sum, p) => (p?.status === "cancelled" ? sum : sum + Number(p?.seats || 0)),
    0
  );
}

// The status a departure ACTUALLY has, which is not always the status stored on
// it.
//
// Terminal and human-controlled states are returned as stored: pending_review
// is waiting on ops and must never auto-advance from a pledge count, and
// supplier_confirmed, closed and cancelled are decisions nobody's booking may
// undo. Everything else is derived from the seats held right now.
//
// ---------------------------------------------------------------------------
// BBBB1 — `minimum_reached` JOINED THAT LIST ON 10 AUGUST 2026, AND THAT IS A
// REVERSAL OF A DOCUMENTED DECISION, NOT A BUG FIX.
//
// This comment used to end: "including a stored `minimum_reached` whose
// bookings have since been cancelled, which is how a date can fall back to
// `open`." That was deliberate and, under the old policy, right: a date short
// of its minimum was not running, however it got there.
//
// The client has settled the opposite rule. Once a departure reaches GoAhead it
// runs, even if travellers drop out afterwards — so reaching the minimum is an
// EVENT, not a running total, and a date cannot un-confirm itself.
//
// What this is scoped to, precisely: HEADCOUNT. Sawa does not cancel a
// confirmed date for low numbers. A site closure, an operator failure or a
// safety situation still cancels it, with a full refund — that lives in the
// Terms, not in this rule, and not in any promise on the site (P1.5).
//
// The consequence worth stating: the stored value is now AUTHORITATIVE once it
// says `minimum_reached`. A date confirmed at four and since dropped to three
// reads `minimum_reached` here, stays on /goahead, stays off the forming board,
// and — the reason this matters most — is no longer a candidate for the
// unattended cancel job.
export function statusFor(departure, pledges = departure?.pledges) {
  if (["pending_review", "minimum_reached", "supplier_confirmed", "closed", "cancelled"].includes(departure?.status)) {
    return departure.status;
  }
  return seatsTotal(pledges) >= goAheadSeatsFor(departure) ? "minimum_reached" : "open";
}

// Forming: a real traveller holds a seat and the group is still short.
//
// An admin-published date with zero bookings is inventory, not a departure, and
// stays off the board — it is still bookable from its itinerary page. It leaves
// the board in either direction: down when its last booking cancels, up when it
// reaches its minimum and moves to /goahead.
export function isFormingDeparture(departure, pledges = departure?.pledges) {
  if (departure?.status !== "open") return false;
  const seats = seatsTotal(pledges);
  return seats >= 1 && seats < goAheadSeatsFor(departure);
}

// Confirmed to run: at or past its minimum, or confirmed by the operator.
// `closed` and `cancelled` are deliberately excluded — the GoAhead board
// advertises trips a traveller can still join, not history.
export function isGoAheadDeparture(departure, pledges = departure?.pledges) {
  return ["minimum_reached", "supplier_confirmed"].includes(statusFor(departure, pledges || []));
}
