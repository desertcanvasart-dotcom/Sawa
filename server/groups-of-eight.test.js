// 29 Sep 2026, LIVE: the maximum group is 8, and a party above it is not booked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_GROUP_SIZE, GROUP_MAX_WORD } from "../shared/group-size.js";
import { capacityError } from "./domain.js";
import { priceFromTiers } from "../shared/pricing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

test("the maximum group is 8 and 12 is refused", () => {
  assert.equal(MAX_GROUP_SIZE, 8);
  assert.equal(GROUP_MAX_WORD, "eight");
  assert.equal(capacityError(4, 8), null);
  assert.match(capacityError(4, 12), /Maximum group size is 8/);
});

test("no live path defaults a tour to 12 seats", () => {
  const app = read("server", "app.js");
  assert.doesNotMatch(app, /maxSeats \|\| 12/);
  assert.match(app, /Number\(body\.maxSeats \|\| MAX_GROUP_SIZE\)/);
  for (const f of ["src/AdminDashboard.jsx", "src/AgencyDashboard.jsx", "server/seo.js", "server/autoura-sync.js"]) {
    assert.doesNotMatch(read(...f.split("/")), /maxSeats \|\| 12|max_seats\) \|\| 12|product\.maxSeats \|\| 12/, f);
  }
  const editor = read("src", "AdminDashboard.jsx");
  assert.match(editor, /min="1" max=\{MAX_GROUP_SIZE\} value=\{f\.maxSeats\}/);
});

test("the price grid shows sizes 4 to 8 only (it runs from the minimum to the maximum)", () => {
  const editor = read("src", "AdminDashboard.jsx");
  assert.match(editor, /for \(let s = minSeats; s <= maxSeats; s \+= 1\) sizes\.push\(s\)/);
  // A grid trimmed to 4..8 prices a party of 8 at its last row, and never reads a size-12 row.
  const tiers = [{ seats: 4, price: 100 }, { seats: 8, price: 80 }];
  assert.equal(priceFromTiers(tiers, 8), 80);
  assert.equal(priceFromTiers(tiers, 12), 80);
});

test("migration 062 changes only what it says, guarded so a second run changes nothing", () => {
  const sql = read("server", "db", "schema_062_groups_of_eight.sql").replace(/--[^\n]*/g, "");
  assert.match(sql, /UPDATE tour_products SET max_seats = 8 WHERE max_seats > 8/);
  assert.doesNotMatch(sql, /UPDATE pledges|DELETE FROM pledges|UPDATE booking/, "an existing booking is never touched");
  assert.match(sql, /UPDATE departures d SET max_seats = LEAST\(d\.max_seats, GREATEST\(8,/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(read("server", "db", "migrate.js"), /062_groups_of_eight/);
});

test("a party above 8 gets the special-arrangement form, not a booking, on the tour page and the widget", () => {
  const main = read("src", "main.jsx");
  assert.match(main, /tooManyTravelers\(seats\) && <GroupRequestForm/);
  assert.match(main, /tooManyTravelers\(nSeats\) && <GroupRequestForm/);
  assert.match(main, /if \(tooManyTravelers\(seats\)\) return setErr\(GROUP_REQUEST_TITLE\)/, "the tour page stops before it books");
  assert.match(main, /if \(tooManyTravelers\(nSeats\)\) return setErr\(GROUP_REQUEST_TITLE\)/, "the widget stops before it books");
  const form = read("src", "GroupRequest.jsx");
  assert.match(form, /Groups of more than \$\{MAX_GROUP_SIZE\}: request a special arrangement/);
  for (const field of ["Your name", "Email", "Group size", "Date", "Tour"]) assert.ok(form.includes(field), field);
});

test("the tour editor opens a tour still stored above 8 at 8, and drops price rows above it", () => {
  const editor = read("src", "AdminDashboard.jsx");
  assert.match(editor, /maxSeats: Math\.min\(existing\?\.maxSeats \|\| MAX_GROUP_SIZE, MAX_GROUP_SIZE\)/);
  assert.match(editor, /useState\(\(existing\?\.priceTiers \|\| \[\]\)\.filter\(\(t\) => Number\(t\.seats\) <= MAX_GROUP_SIZE\)\)/);
  assert.match(editor, /Stored as \$\{existing\.maxSeats\}\. The maximum group is/, "the admin is told why it changed");
});
