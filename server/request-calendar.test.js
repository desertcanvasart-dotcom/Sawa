// The date picker for "start your own date".
//
// It was two different pickers that disagreed about what was reachable:
//
//   restricted tours    twelve chips from a loop capped at both twelve AND 90
//                       days — a Mon/Sat cruise showed about six weeks and
//                       October was simply not offered
//   unrestricted tours  a native <input type="date">, which shows a calendar but
//                       cannot grey out the days a tour does not run
//
// One grid now serves both. A closed day is SHOWN and disabled rather than
// omitted: absent reads as "not offered", greyed reads as "not possible", and
// only the second is true.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const ui = read("src/main.jsx");
// The component moved to its own module on 24 Sep 2026 so the operator
// dashboard's "Request a date" could use the same picker.
const calendar = read("src/RequestCalendar.jsx");

test("the chip list is gone, and with it its twelve-date cap", () => {
  // `for (let i = 3; i <= 90 && out.length < 12; i++)` — whichever bound hit
  // first ended the list, and on a two-day-a-week cruise it was always twelve.
  assert.ok(!/eligibleDates/.test(ui), "the capped chip list is still there");
  assert.ok(!/className="req-days"/.test(ui), "the chip container survives");
});

test("one picker serves restricted and unrestricted tours alike", () => {
  // The branch is gone: no `{opDays.length ? (chips) : (<input type=date>)}`.
  assert.match(ui, /<RequestCalendar/);
  assert.equal((ui.match(/<RequestCalendar/g) || []).length, 1, "rendered more than once");
  assert.ok(!/type="date" className="req-date"/.test(ui),
    "the native input branch survives, so the two paths can still diverge");
});

test("a closed day is disabled and says why", () => {
  const cmp = /function RequestCalendar\([\s\S]*?\n\}/.exec(calendar);
  assert.ok(cmp, "the calendar component is gone");
  for (const reason of ["too soon", "too far ahead", "doesn't run this day", "unavailable"]) {
    assert.ok(cmp[0].includes(reason), `no reason given for "${reason}"`);
  }
  assert.match(cmp[0], /disabled=\{c\.disabled\}/);
  assert.match(cmp[0], /title=\{c\.disabled \? c\.reason : undefined\}/,
    "a greyed square tells a visitor nothing about why");
});

test("every reason the calendar closes a day, the server also enforces", () => {
  // The calendar is a convenience, never the authority.
  const app = read("server/app.js");
  assert.match(app, /minLeadDaysFor\(product\)/, "lead time");
  assert.match(app, /maxHorizonDaysFor\(product\)/, "horizon");
  assert.match(app, /operatingDayError\(product, input\.date\)/, "operating day");
  assert.match(app, /blocked\.has\(input\.date\)/, "operator blackout");
});

test("the fences come from one authority, not a constant on each side", () => {
  // They were the bare 3 and 90 inlined on the client, with the server's own
  // copy in a third place. Both now resolve the PRODUCT's window through
  // shared/request-window.js, so the calendar cannot offer a day the request
  // route will refuse.
  assert.match(ui, /const REQUEST_MIN_LEAD_DAYS = minLeadDaysFor\(tour\);/);
  assert.match(ui, /const REQUEST_MAX_HORIZON_DAYS = maxHorizonDaysFor\(tour\);/);
  assert.match(ui, /from "\.\.\/shared\/request-window\.js"/);

  const app = read("server/app.js");
  assert.ok(!/const REQUEST_MIN_LEAD_DAYS = 3;/.test(app),
    "the server still carries its own copy of the fence");
  assert.ok(!/const REQUEST_MAX_HORIZON_DAYS = 90;/.test(app));
  assert.match(app, /from "\.\.\/shared\/request-window\.js"/);
});

test("month navigation stops at the fences rather than running forever", () => {
  const cmp = /function RequestCalendar\([\s\S]*?\n\}/.exec(calendar)[0];
  assert.match(cmp, /disabled=\{!withinMonth\(-1\)\}/);
  assert.match(cmp, /disabled=\{!withinMonth\(1\)\}/);
});

test("the grid opens on the first bookable month, not on today", () => {
  // On the 29th, today's month is nearly all past and the visitor would land on
  // a grid with almost nothing left in it.
  assert.match(ui, /const \[reqMonth, setReqMonth\] = useState\(\(\) => \{[\s\S]{0,220}getDate\(\) \+ 3\)/);
});

test("a disabled day is struck through, not only dimmed", () => {
  // Dimming alone is invisible at low contrast, and this is the difference
  // between a day a traveller can have and one they cannot.
  const css = read("src/redesign.css");
  assert.match(css, /\.req-cal-day:disabled\{[^}]*text-decoration:line-through/);
});

test("the dev fixture exercises the restricted path", () => {
  // Every package had operatingDays: [] locally, so the calendar rendered every
  // day open and the restriction was untestable without production.
  const fixture = JSON.parse(read("site/_dev_bootstrap.json"));
  const restricted = (fixture.tourProducts || []).filter((p) => (p.operatingDays || []).length);
  assert.ok(restricted.length >= 3, "no fixture product carries operating days");
});

test("the operator's request form uses the same picker and the same fences", () => {
  const agency = read("src/AgencyDashboard.jsx");
  assert.match(agency, /import \{ RequestCalendar \} from "\.\/RequestCalendar\.jsx"/);
  assert.match(agency, /minIso = isoIn\(minLeadDaysFor\(product\)\)/);
  assert.match(agency, /maxIso = isoIn\(maxHorizonDaysFor\(product\)\)/);
  assert.match(agency, /apiFetch\("\/public\/unavailable-dates"\)/, "operator blackouts must grey out here too");
});
