// YY3.2 — Egyptian local time, at the boundaries, in exact instants.
//
// Every booking cutoff, confirm deadline and "has this date started" resolves a
// stored date and wall-clock time as EGYPTIAN local time. Egypt reinstated DST
// in 2023 — EET (+2) in winter, EEST (+3) in summer — so a fixed offset is
// wrong for roughly half the year, and the host's clock is wrong everywhere
// except Cairo.
//
// This machine's TZ is Africa/Cairo, which is the one timezone where those two
// bugs are invisible: host-based code agrees with Cairo-based code, and the
// suite cannot tell them apart. The suite is now pinned to UTC (YY3.1), and
// these cases assert EXACT epoch milliseconds, so:
//
//   a fixed +2 offset          fails every summer case by an hour
//   host-clock arithmetic      fails every case by 2 or 3 hours
//   a fixed +3 offset          fails every winter case by an hour
//
// This is a YY1 case throughout. None of those bugs throws. They move a booking
// deadline by an hour or three and nothing complains — which is how the real one
// (documented in tz.js) closed bookings 21 hours before departure under a
// "24 hours before" rule, on Railway, for as long as it took someone to notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { zonedDateTimeToUtc, TOUR_TIMEZONE } from "./tz.js";
import { bookingClosed, confirmDeadlineAt, departureStarted } from "./domain.js";

const iso = (ms) => new Date(ms).toISOString();

// Egypt's 2026 transitions, established by asking Intl rather than by assuming
// a rule: DST begins 24 April (+2 -> +3) and ends 30 October (+3 -> +2).
const SPRING_FORWARD = "2026-04-24";
const FALL_BACK = "2026-10-30";

test("the zone is Africa/Cairo, and the suite is not running in it", () => {
  // If the pin is ever removed on a Cairo machine, the cases below still pass —
  // but they stop proving anything about host-independence. Say so rather than
  // let the suite quietly weaken.
  assert.equal(TOUR_TIMEZONE, "Africa/Cairo");
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.notEqual(
    host, "Africa/Cairo",
    "the suite is running in Africa/Cairo, so a host-timezone bug would be invisible — TZ pin lost?"
  );
});

test("winter is +2 and summer is +3, to the millisecond", () => {
  // A fixed offset gets one of these wrong. Host arithmetic gets both wrong.
  assert.equal(iso(zonedDateTimeToUtc("2026-01-10", "08:00")), "2026-01-10T06:00:00.000Z", "winter, EET +2");
  assert.equal(iso(zonedDateTimeToUtc("2026-07-10", "08:00")), "2026-07-10T05:00:00.000Z", "summer, EEST +3");
});

test("the day before, of, and after the spring transition", () => {
  // 23 April is still +2; 25 April is +3. The date the trip departs decides,
  // not the date the calculation runs.
  assert.equal(iso(zonedDateTimeToUtc("2026-04-23", "08:00")), "2026-04-23T06:00:00.000Z");
  assert.equal(iso(zonedDateTimeToUtc(SPRING_FORWARD, "08:00")), "2026-04-24T05:00:00.000Z");
  assert.equal(iso(zonedDateTimeToUtc("2026-04-25", "08:00")), "2026-04-25T05:00:00.000Z");
});

test("the day before, of, and after the autumn transition", () => {
  assert.equal(iso(zonedDateTimeToUtc("2026-10-29", "08:00")), "2026-10-29T05:00:00.000Z");
  assert.equal(iso(zonedDateTimeToUtc(FALL_BACK, "08:00")), "2026-10-30T06:00:00.000Z");
  assert.equal(iso(zonedDateTimeToUtc("2026-10-31", "08:00")), "2026-10-31T06:00:00.000Z");
});

test("a local time that does not exist resolves to a real instant", () => {
  // Egypt springs forward at midnight, so 00:00–00:59 on 24 April never happens
  // on a Cairo clock. A tour is not scheduled then, but nothing validates
  // departures.time, and the old failure mode was an invalid Date making the
  // cutoff FAIL OPEN — bookings never closing at all.
  const ms = zonedDateTimeToUtc(SPRING_FORWARD, "00:30");
  assert.ok(Number.isFinite(ms), "a nonexistent local time produced NaN — the cutoff would fail open");
  assert.equal(iso(ms), "2026-04-23T22:30:00.000Z");
});

test("a local time that happens twice resolves to one of them, deterministically", () => {
  // 00:00–00:59 on 30 October occurs twice on a Cairo clock. Either instant is
  // defensible; what matters is that it is stable, because a cutoff that moves
  // between two runs is worse than one that is an hour out.
  const first = zonedDateTimeToUtc(FALL_BACK, "00:30");
  const again = zonedDateTimeToUtc(FALL_BACK, "00:30");
  assert.equal(first, again);
  assert.ok(Number.isFinite(first));
});

test("a cutoff spanning the spring transition is 24 real hours, not 24 clock hours", () => {
  // Departure 08:00 on 24 April (+3). Twenty-four hours earlier is 07:00 on
  // 23 April Cairo time (+2), because the clock jumped forward in between.
  // That is what a traveller experiences — twenty-four actual hours of notice —
  // and it is what the operator's confirmation window depends on.
  const departure = { startDate: SPRING_FORWARD, time: "08:00" };
  const product = { bookingCutoffHours: 24 };
  const start = zonedDateTimeToUtc(SPRING_FORWARD, "08:00");
  const cutoff = start - 24 * 3600 * 1000;
  assert.equal(iso(cutoff), "2026-04-23T05:00:00.000Z");

  assert.equal(bookingClosed(departure, product, cutoff - 1), false, "one ms before the cutoff, still open");
  assert.equal(bookingClosed(departure, product, cutoff + 1), true, "one ms after, closed");
});

test("a confirm deadline spanning the autumn transition lands on the right day", () => {
  // Seven days before a 30 October departure is 23 October — and 23 October is
  // still +3 while 30 October is +2, so a fixed-offset implementation puts the
  // deadline an hour out and a host-based one puts it two or three hours out.
  const departure = { startDate: FALL_BACK, time: "08:00" };
  const product = { confirmDeadlineDays: 7 };
  assert.equal(iso(confirmDeadlineAt(departure, product)), "2026-10-23T06:00:00.000Z");
});

test("a date has not started until it has started in Cairo", () => {
  const departure = { startDate: "2026-07-10", time: "08:00" };
  const start = zonedDateTimeToUtc("2026-07-10", "08:00");
  assert.equal(departureStarted(departure, start - 1), false);
  assert.equal(departureStarted(departure, start + 1), true);
});

// ---------------------------------------------------------------------------

test("the same inputs give the same instants in every host timezone — W3", () => {
  // The assertion that makes the rest of this file mean something. Run in a
  // child process under four host timezones; every answer must be identical.
  //
  // Without this, all of the above would pass on a machine whose clock happened
  // to agree with Cairo — which is exactly the machine this was written on.
  const probe = `
    import("./server/tz.js").then(({ zonedDateTimeToUtc }) => {
      const out = ["2026-01-10", "2026-04-23", "2026-04-24", "2026-07-10", "2026-10-29", "2026-10-30"]
        .map((d) => zonedDateTimeToUtc(d, "08:00"));
      console.log(JSON.stringify(out));
    });`;

  const results = {};
  for (const tz of ["UTC", "Africa/Cairo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    results[tz] = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
  }
  const distinct = new Set(Object.values(results));
  assert.equal(
    distinct.size, 1,
    "the host timezone changed the answer:\n  " + Object.entries(results).map(([k, v]) => `${k}: ${v}`).join("\n  ")
  );
});

test("a host-clock implementation WOULD fail these cases — the guard is sensitive", () => {
  // W3 for the assertions themselves. The naive implementation tz.js exists to
  // replace, run against the same input: it must disagree, or the exact-instant
  // cases above are not testing what they claim to.
  const naive = (d, t) => Date.parse(`${d}T${t}:00`);          // resolves in the HOST zone
  const fixedPlusTwo = (d, t) => Date.parse(`${d}T${t}:00Z`) - 2 * 3600 * 1000;

  const summer = zonedDateTimeToUtc("2026-07-10", "08:00");
  assert.notEqual(naive("2026-07-10", "08:00"), summer, "host arithmetic agreed — is the TZ pin lost?");
  assert.notEqual(fixedPlusTwo("2026-07-10", "08:00"), summer, "a fixed +2 offset agreed in summer");

  const winter = zonedDateTimeToUtc("2026-01-10", "08:00");
  assert.equal(fixedPlusTwo("2026-01-10", "08:00"), winter, "a fixed +2 is right in winter — which is why it survived");
});
