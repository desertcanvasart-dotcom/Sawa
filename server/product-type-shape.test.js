// A product's type, its duration, and the URL it lives at.
//
// "Full Day Minya Archaeological Tour from Cairo" was published as a `package`
// with a duration of "1 day · 15 hours". Nothing objected, and `type` is what
// the system acts on — so a fifteen-hour road trip carried a Nile cruise's
// deposit, balance timing, cancellation schedule and 30-day confirmation
// deadline. The only visible symptom was a duration string that read oddly.
//
// Three defects came out of that one row, and this covers all three.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  durationShapeError, DAY_TOUR_DURATION, PACKAGE_DURATION, EXTENDED_DAY_HOURS,
} from "../shared/booking-policy.js";
import { tourPath } from "./slug.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---- 1. the type/duration disagreement ------------------------------------

test("it fires — the exact row that shipped", () => {
  // A `nights >= 1` rule would NOT have caught this: the row said nights: 1.
  // The tell was a duration measured in hours on a product typed multi-day.
  const err = durationShapeError("package", "1 day · 15 hours");
  assert.ok(err, "the defect that started this went undetected");
  assert.match(err, /package/i);
});

test("both corrected values pass", () => {
  assert.equal(durationShapeError("day_tour", "Extended day · about 15 hours"), null);
  assert.equal(durationShapeError("package", "5 days · 4 nights"), null);
});

test("a day tour's duration on a package is named as such, not just rejected", () => {
  // The message has to tell an operator which of the two fields is wrong —
  // the type or the duration — because either could be the mistake.
  const err = durationShapeError("package", "Full day · about 5 hours");
  assert.match(err, /day tour's duration/);
  assert.match(err, /change the type/);
});

test("a package's duration on a day tour is caught too", () => {
  assert.match(durationShapeError("day_tour", "5 days · 4 nights"), /package's duration/);
});

test("over eight hours is an Extended day", () => {
  // The house rule, previously written down nowhere a machine could read.
  assert.equal(durationShapeError("day_tour", `Full day · about ${EXTENDED_DAY_HOURS} hours`), null);
  assert.match(durationShapeError("day_tour", "Full day · about 15 hours"), /Extended day/);
  assert.match(durationShapeError("day_tour", "Extended day · about 5 hours"), /Full day/);
});

test("a blank duration is left alone", () => {
  // An agency listing in draft has no duration yet. Refusing to save it would
  // push the work somewhere this rule cannot see.
  for (const v of ["", null, undefined, "   "]) {
    assert.equal(durationShapeError("day_tour", v), null);
    assert.equal(durationShapeError("package", v), null);
  }
});

test("every duration in the catalogue's own house format passes", () => {
  // The formats actually in use on the live site. If this rule rejected one of
  // them it would block editing a product that is already correct.
  const live = [
    ["day_tour", "Full day · about 5 hours"], ["day_tour", "Full day · about 6.5 hours"],
    ["day_tour", "Full day · about 8 hours"], ["day_tour", "Extended day · about 9 hours"],
    ["day_tour", "Extended day · about 9.5 hours"], ["day_tour", "Extended day · about 11 hours"],
    ["day_tour", "Extended day · about 15 hours"],
    ["package", "12 days · 11 nights"], ["package", "9 days · 8 nights"], ["package", "5 days · 4 nights"],
  ];
  assert.equal(live.length, 10);   // DIR-14
  for (const [type, d] of live) {
    assert.equal(durationShapeError(type, d), null, `${type} "${d}" was rejected`);
  }
});

test("it is enforced on write, not only exported", () => {
  const app = read("server/app.js");
  assert.match(app, /const durationProblem = durationShapeError\(type, body\.duration\)/);
  assert.match(app, /if \(durationProblem\) throw new AppError\(422, durationProblem\)/);
  // Beside the capacity check, i.e. before anything is written.
  assert.ok(app.indexOf("durationShapeError(type") < app.indexOf("INSERT INTO tour_products"),
    "the guard must run before the row is written");
});

// ---- 2. the URL that moved -------------------------------------------------

test("type decides the prefix, so retyping a product moves its URL", () => {
  // This is the mechanism behind the duplicate: it is not a Minya quirk.
  const base = { id: "p1", title: "Full Day Minya Archaeological Tour from Cairo", city: "Cairo" };
  const asPackage = tourPath({ ...base, type: "package" });
  const asDayTour = tourPath({ ...base, type: "day_tour" });
  assert.notEqual(asPackage, asDayTour);
  assert.match(asPackage, /^\/package\//);
  assert.match(asDayTour, /^\/tour\//);
});

test("a clean slug under the wrong prefix redirects to the canonical one", () => {
  const app = read("server/app.js");
  assert.match(app, /const canonical = await canonicalTourPath\(seg\)/);
  // The query rides along (F06): a ?date= link must not lose its date.
  assert.match(app, /return res\.redirect\(301, canonical \+ queryOf\(req\)\)/);
  // Never to itself — a 301 loop is cached by the browser and outlives the fix.
  assert.match(app, /if \(!canonical \|\| canonical === req\.path\) return next\(\)/);
});

test("the canonical path comes from tourPath, not a second expression", () => {
  const seo = read("server/seo.js");
  assert.match(seo, /export async function canonicalTourPath/);
  assert.match(seo, /return row \? tourPath\(row\) : null/,
    "the redirect target must be the same definition the sitemap and links use");
});

// ---- 3. sold out vs never offered ------------------------------------------

test("a tour with no published date is not described as full", () => {
  const src = read("src/main.jsx");
  assert.match(src, /!dep \? "No open dates" : remaining <= 0 \? "Date full"/,
    "with no departure the figures fall to zero and the CTA read 'Date full'");
});

test("the seats meter is not rendered without a departure", () => {
  // It read "0 of 4 joined · 0 seats left" on a tour that had never opened a
  // date. Sold out and never offered are opposite states.
  const src = read("src/main.jsx");
  assert.match(src, /\{!reqMode && dep && <div className="seats-block">/);
});
