// Timezone regression tests for date display. Pure — no DB, no DOM.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { toDate, fmtDate } from "./dates.js";

// These tests must switch the ambient timezone, not just the formatter's: a
// browser parses AND renders in the viewer's own zone, so simulating only the
// render half would pass even against the broken implementation.
// Node re-reads process.env.TZ on each Date operation, which lets us do this.
function inTimeZone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

// The bug only appears west of UTC, and this team is in Cairo (UTC+2/+3) — so
// these pin behaviour in zones nobody here would think to check by hand.
const WESTERN = ["America/New_York", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
const EASTERN = ["Africa/Cairo", "Europe/London", "Asia/Tokyo", "Pacific/Auckland"];

const localDay = (value) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(toDate(value));

test("a date-only departure renders the same calendar day in every timezone", () => {
  for (const tz of [...WESTERN, ...EASTERN]) {
    inTimeZone(tz, () => assert.equal(localDay("2026-07-10"), "2026-07-10", `wrong day in ${tz}`));
  }
});

test("the pre-fix implementation really did shift the day (guards the guard)", () => {
  // If this ever stops failing, the test above has stopped proving anything.
  const broken = (v) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
  inTimeZone("America/Los_Angeles", () => {
    assert.equal(broken("2026-07-10"), "2026-07-09", "expected the old UTC-midnight parse to lose a day");
    assert.equal(localDay("2026-07-10"), "2026-07-10");
  });
});

test("holds across DST boundaries and year ends", () => {
  for (const date of ["2026-01-01", "2026-03-08", "2026-11-01", "2026-12-31"]) {
    for (const tz of WESTERN) {
      inTimeZone(tz, () => assert.equal(localDay(date), date, `${date} shifted in ${tz}`));
    }
  }
});

test("full timestamps keep their own instant and are not re-anchored", () => {
  // createdAt / submittedAt / publishedAt arrive as full ISO strings carrying a
  // real instant, which legitimately falls on different days either side of UTC.
  const iso = "2026-07-10T23:30:00.000Z";
  assert.equal(toDate(iso).toISOString(), iso);
  inTimeZone("Africa/Cairo", () => assert.equal(localDay(iso), "2026-07-11"));
  inTimeZone("America/Los_Angeles", () => assert.equal(localDay(iso), "2026-07-10"));
});

test("toDate passes Date objects through unchanged", () => {
  const d = new Date("2026-07-10T12:00:00Z");
  assert.equal(toDate(d), d);
});

test("fmtDate renders an em dash for empty and invalid input", () => {
  for (const bad of [null, undefined, "", "not-a-date"]) assert.equal(fmtDate(bad), "—");
});

test("fmtDate formats a date-only value without shifting it", () => {
  inTimeZone("America/Los_Angeles", () => assert.match(fmtDate("2026-07-10"), /Jul 10, 2026/));
});
