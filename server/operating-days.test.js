// The weekday rule, and the path that never enforced it.
//
// A traveller asking for a Tuesday on a Mon/Sat cruise has always been refused.
// The ADMIN route that publishes a departure never checked — so ops could
// publish exactly the date the site refuses to let anyone request.
//
// No restricted product has a departure today, so nothing is broken; this closes
// the gap while it is still cheap. All three Nile cruises run on fixed weekdays,
// and the first cruise date published is the first chance to get it wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  operatingDayError, operatingDaysLabel, operatingDaysOf, weekdayOf,
} from "../shared/operating-days.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const CRUISE = { title: "Nile Majesty", operatingDays: [1, 6] };   // Mondays, Saturdays

test("it refuses a day the tour does not run", () => {
  const err = operatingDayError(CRUISE, "2026-09-15");  // a Tuesday
  assert.match(err, /Nile Majesty departs only on Mondays and Saturdays/);
});

test("it allows the days it does run", () => {
  assert.equal(operatingDayError(CRUISE, "2026-09-14"), null);  // Monday
  assert.equal(operatingDayError(CRUISE, "2026-09-19"), null);  // Saturday
});

test("no operating days means any day", () => {
  // The admin's all-seven-ticked case normalises to NULL, so "unrestricted" and
  // "every day" are the same state and must behave identically.
  for (const p of [{ operatingDays: [] }, { operatingDays: null }, {}, { title: "X" }]) {
    assert.equal(operatingDayError(p, "2026-09-15"), null, JSON.stringify(p));
  }
});

test("it reads a raw database row too", () => {
  // The admin route checks a mapped product; a future caller may hold the row.
  assert.match(operatingDayError({ title: "X", operating_days: [1, 6] }, "2026-09-15"),
    /only on Mondays and Saturdays/);
});

test("the weekday is read at noon, not midnight", () => {
  // `new Date("2026-09-14")` is midnight UTC, which renders as the 13th west of
  // Greenwich — the same trap src/dates.js anchors around.
  assert.equal(weekdayOf("2026-09-14"), 1, "Monday");
  assert.equal(weekdayOf("2026-09-19"), 6, "Saturday");
  assert.equal(weekdayOf("not-a-date"), null);
});

test("an unreadable date is refused, not waved through", () => {
  assert.match(operatingDayError(CRUISE, "rubbish"), /could not be read/);
});

test("the label reads like the site's copy", () => {
  assert.equal(operatingDaysLabel([0]), "Sundays");
  assert.equal(operatingDaysLabel([1, 6]), "Mondays and Saturdays");
  assert.equal(operatingDaysLabel([1, 3, 5]), "Mondays, Wednesdays and Fridays");
  assert.equal(operatingDaysLabel([]), "");
});

test("out-of-range weekdays are dropped rather than printing undefined", () => {
  assert.deepEqual(operatingDaysOf({ operatingDays: [1, 9, -2, 6, "x"] }), [1, 6]);
});

// ---- both paths, one rule --------------------------------------------------

test("the ADMIN publish route now checks operating days", () => {
  const app = read("server/app.js");
  const route = app.slice(app.indexOf('app.post("/api/admin/departures"'));
  const body = route.slice(0, 3000);
  assert.match(body, /operatingDayError\(product, body\.date \|\| body\.startDate\)/,
    "the admin route can still publish a date the tour does not run on");
  assert.match(body, /throw new AppError\(422, dayProblem\)/);
});

test("the traveller route uses the same rule, not its own copy", () => {
  const app = read("server/app.js");
  assert.equal((app.match(/operatingDayError\(/g) || []).length, 2,
    "both paths must call it, and nothing else should");
  // The hand-written table and joiner are gone from the server.
  assert.ok(!/\["Sundays", "Mondays", "Tuesdays"/.test(app),
    "server/app.js still carries its own day table");
});

test("the date picker shares the label, so the two cannot disagree", () => {
  const ui = read("src/main.jsx");
  assert.match(ui, /operatingDaysLabel\(opDays\)/);
  assert.ok(!/\["Sundays", "Mondays", "Tuesdays"/.test(ui),
    "src/main.jsx still carries its own day table");
});
