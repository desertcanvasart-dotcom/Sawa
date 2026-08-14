// The date window, per product.
//
// The addendum specified it that way from the start — "Lead time: date must be
// >= minLeadDays out (per tour product, default 3)" and "Horizon: date must be
// <= maxHorizonDays out (default 90)". Only the defaults were built, as two
// constants in a route, so a Nile cruise could not be requested for January and
// a Cairo day tour carried a 90-day window it had no use for.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  minLeadDaysFor, maxHorizonDaysFor, requestWindowError,
  DEFAULT_MIN_LEAD_DAYS, DEFAULT_MAX_HORIZON_DAYS,
  MAX_LEAD_DAYS_ALLOWED, MAX_HORIZON_DAYS_ALLOWED,
} from "../shared/request-window.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("a product with no window gets the old behaviour exactly", () => {
  // Every existing product is in this state. Nothing may change for them.
  assert.equal(DEFAULT_MIN_LEAD_DAYS, 3);
  assert.equal(DEFAULT_MAX_HORIZON_DAYS, 90);
  assert.equal(minLeadDaysFor({}), 3);
  assert.equal(maxHorizonDaysFor({}), 90);
  assert.equal(minLeadDaysFor({ requestMinLeadDays: null }), 3);
  assert.equal(maxHorizonDaysFor({ requestMaxHorizonDays: null }), 90);
});

test("a product that sets one gets its own", () => {
  assert.equal(maxHorizonDaysFor({ requestMaxHorizonDays: 365 }), 365);
  assert.equal(minLeadDaysFor({ requestMinLeadDays: 21 }), 21);
});

test("zero notice is a choice, not an empty field", () => {
  // `|| DEFAULT` would turn a deliberate 0 into 3. Same-day requests are a
  // legitimate setting for a walk-up day tour.
  assert.equal(minLeadDaysFor({ requestMinLeadDays: 0 }), 0);
});

test("it reads a raw database row as well as a mapped product", () => {
  assert.equal(maxHorizonDaysFor({ request_max_horizon_days: 180 }), 180);
  assert.equal(minLeadDaysFor({ request_min_lead_days: 7 }), 7);
});

test("a window with no days in it is refused", () => {
  // Otherwise the product is bookable never, and the calendar renders an empty
  // month that everyone reads as a bug in the site.
  assert.match(requestWindowError(10, 10), /must be further out than/);
  assert.match(requestWindowError(10, 5), /must be further out than/);
  assert.equal(requestWindowError(3, 90), null);
});

test("one end set and the other left blank is a normal state", () => {
  // The fallback pair is known-good, so there is nothing to compare against.
  assert.equal(requestWindowError(null, 365), null);
  assert.equal(requestWindowError(7, null), null);
  assert.equal(requestWindowError("", ""), null);
});

test("a slipped digit is refused while the operator is still looking at it", () => {
  // 900 instead of 90 would offer dates two and a half years out, and nothing
  // downstream would question it.
  assert.match(requestWindowError(3, MAX_HORIZON_DAYS_ALLOWED + 1), /between 1 and/);
  assert.match(requestWindowError(MAX_LEAD_DAYS_ALLOWED + 1, 90), /between 0 and/);
  assert.match(requestWindowError(-1, 90), /between 0 and/);
  assert.match(requestWindowError(3, "abc"), /whole number/);
});

test("the code rule and the database constraint agree", () => {
  // The constraint cannot be bypassed; the function exists so the operator gets
  // a sentence instead of a constraint violation. They must say the same thing.
  const sql = read("server/db/schema_037_request_window.sql");
  assert.match(sql, new RegExp(`BETWEEN 0 AND ${MAX_LEAD_DAYS_ALLOWED}`));
  assert.match(sql, new RegExp(`BETWEEN 1 AND ${MAX_HORIZON_DAYS_ALLOWED}`));
  assert.match(sql, /request_max_horizon_days > request_min_lead_days/);
  // Nullable with no DEFAULT: "nobody set one" must stay distinguishable.
  assert.ok(!/request_min_lead_days\s+SMALLINT\s+DEFAULT/i.test(sql));
  assert.ok(!/request_max_horizon_days\s+SMALLINT\s+DEFAULT/i.test(sql));
});

test("the request route reads the product's window, not a constant", () => {
  const app = read("server/app.js");
  assert.match(app, /const minLead = minLeadDaysFor\(product\);/);
  assert.match(app, /const maxHorizon = maxHorizonDaysFor\(product\);/);
  // And it must run where the product exists — it used to run before the load.
  const route = app.slice(app.indexOf("publicDepartureRequestSchema, req.body"));
  assert.ok(route.indexOf("loadProduct") < route.indexOf("minLeadDaysFor(product)"),
    "the window is checked before the product is known");
});

test("the refusal names the tour and the number", () => {
  // "Requested dates can be at most 90 days out" told a traveller nothing about
  // which rule they hit on which trip.
  const app = read("server/app.js");
  assert.match(app, /\$\{product\.title\} needs at least \$\{minLead\}/);
  assert.match(app, /\$\{product\.title\} can be requested up to \$\{maxHorizon\} days ahead/);
});

test("the editor saves blank as NULL, never as the default", () => {
  // Writing 90 for a blank field would assert a deliberate window nobody chose,
  // and freeze that product if the default ever changes.
  const ui = read("src/AdminDashboard.jsx");
  assert.match(ui, /requestMinLeadDays: f\.requestMinLeadDays === "" \? null : Number/);
  assert.match(ui, /requestMaxHorizonDays: f\.requestMaxHorizonDays === "" \? null : Number/);
  // and the placeholder tells the operator what a blank falls back to
  assert.match(ui, /placeholder=\{String\(DEFAULT_MAX_HORIZON_DAYS\)\}/);
});

test("the upsert persists both ends", () => {
  const app = read("server/app.js");
  // [,)] not \): 038 appended booking_cutoff_unit after these two, and the pin
  // is that both columns are in the INSERT — not that they end it.
  assert.match(app, /request_min_lead_days, request_max_horizon_days[,)]/);
  assert.match(app, /request_max_horizon_days=EXCLUDED\.request_max_horizon_days/);
});

test("the mapper keeps NULL as NULL", () => {
  const m = read("server/db/mappers.js");
  assert.match(m, /requestMinLeadDays: r\.request_min_lead_days \?\? null/);
  assert.match(m, /requestMaxHorizonDays: r\.request_max_horizon_days \?\? null/);
});

test("037 is registered", () => {
  assert.match(read("server/db/migrate.js"), /schema_037_request_window\.sql/);
});
