// GENERATED — do not edit. Run `npm run sync:rules`.
//
// Source: shared/group-size.js + shared/departure-state.js
//
// The static pages used to hand-write these rules, once each, with a comment
// asking the next person to keep them in sync. They did not stay in sync. This
// file exists so there is nothing left to keep in sync.
(function (global) {
  "use strict";

  // The two numbers in the booking conditions, and nothing else.
  //
  // "Every Sawa departure runs with a minimum of 4 and a maximum of 12 travelers"
  // is a term of the contract. It is stated on the homepage, the how-it-works
  // page, the GoAhead promise, in the terms, in the React app, and in twenty
  // static HTML files. It is enforced by validation in server/domain.js and by
  // CHECK constraints in the database.
  //
  // This module exists so all of that reads ONE declaration. It cannot live in
  // server/domain.js, which is where the rules live: domain.js imports tz.js,
  // tz.js reads process.env, and the browser has no process — so the React app
  // kept its own `const DEFAULT_GO_AHEAD = 4` and the two were free to drift.
  //
  // Deliberately dependency-free. Anything imported here would be imported into
  // the browser bundle and into every server module that touches a price.
  //
  // server/domain.js re-exports these, so `import { MAX_GROUP_SIZE } from
  // "./domain.js"` keeps working everywhere it is already written.

  // The default number of travellers a date confirms at, and the floor beneath
  // which no listing may be published. A listing may require MORE — a nine-day
  // cruise is not viable at four — so this is a default and a minimum, never a
  // fixed value. The real threshold for a date is on the date.
  const DEFAULT_GO_AHEAD = 4;

  // The hard ceiling. Universal, unlike the threshold: it applies to every
  // itinerary, and it is the promise the site markets. Raising it means changing
  // what the booking conditions say, so it is deliberately a literal here rather
  // than anything configurable.
  const MAX_GROUP_SIZE = 12;

  // Prose says "four travellers", a stat display says "4". Both come from the
  // constant, so raising either number updates the sentence and the figure
  // together — see scripts/sync-constants.js, which writes them into the static
  // pages, and server/constants.test.js, which fails the build if they drift.
  const WORDS = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen", "twenty",
  ];

  function numberWord(n) {
    return WORDS[n] ?? String(n);
  }

  const GO_AHEAD_WORD = numberWord(DEFAULT_GO_AHEAD);
  const GROUP_MAX_WORD = numberWord(MAX_GROUP_SIZE);

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

  // The threshold for THIS date. A listing may require more than the default — a
  // nine-day cruise is not viable at four — so the number on the date wins.
  // snake_case is accepted because raw database rows reach this on the server.
  function goAheadSeatsFor(item) {
    return Math.max(1, Number(item?.minSeats || item?.min_seats || DEFAULT_GO_AHEAD));
  }

  // Cancelled pledges no longer hold their seats, so they must not count toward
  // capacity, live pricing, or the go-ahead threshold.
  //
  // A missing or zero `seats` counts as ZERO. The static boards used to read
  // `Number(x.seats||x.pax)||1`, which turns a seatless row into one traveller —
  // inventing a person on a public board. The server's reading is the correct one
  // and it is now the only one.
  function seatsTotal(pledges = []) {
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
  function statusFor(departure, pledges = departure?.pledges) {
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
  function isFormingDeparture(departure, pledges = departure?.pledges) {
    if (departure?.status !== "open") return false;
    const seats = seatsTotal(pledges);
    return seats >= 1 && seats < goAheadSeatsFor(departure);
  }

  // Confirmed to run: at or past its minimum, or confirmed by the operator.
  // `closed` and `cancelled` are deliberately excluded — the GoAhead board
  // advertises trips a traveller can still join, not history.
  function isGoAheadDeparture(departure, pledges = departure?.pledges) {
    return ["minimum_reached", "supplier_confirmed"].includes(statusFor(departure, pledges || []));
  }

  // F05 — may a traveller still reserve this date? `bookingClosesAt` is the
  // instant the server's own bookingClosed() rule shuts it (the product's cutoff
  // before the Egyptian-local start), published with every departure. Pages
  // compare against their own clock, so a page left open, or a payload served
  // from cache, still closes the date on time. A departure without the field
  // reads as open, as before, and the server refuses the booking regardless.
  function isBookingOpen(departure, nowMs = Date.now()) {
    const at = Date.parse(departure?.bookingClosesAt || "");
    return Number.isNaN(at) || nowMs <= at;
  }

  global.SawaRules = {
    DEFAULT_GO_AHEAD,
    MAX_GROUP_SIZE,
    numberWord,
    goAheadSeatsFor,
    seatsTotal,
    statusFor,
    isFormingDeparture,
    isGoAheadDeparture,
    isBookingOpen,
  };
})(typeof window !== "undefined" ? window : globalThis);
