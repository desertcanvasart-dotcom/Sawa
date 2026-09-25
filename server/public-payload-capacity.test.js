// S03 + F02 + F03, from the 25 Sep 2026 audit.
//
// S03: the anonymous catalogue carried internal cost, staff notes and the
//      review trail of every listing.
// F02: a date request could seed more travelers than the date seats.
// F03: reinstating a cancelled booking took its seats back unchecked.
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/never-connects";
process.env.SUPABASE_URL ||= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "placeholder-anon-key";
process.env.APP_NO_LISTEN = "1";
process.env.PAGE_WARM_INTERVAL_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { presentProduct, presentDeparture } = await import("./app.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");

const product = {
  id: "p1", title: "Giza", agencyId: 7, baseCost: 35, publishedRate: 80,
  submittedAt: "2026-09-01", reviewedAt: "2026-09-02", rejectionReason: "photos",
};
const departure = {
  id: 1, baseCost: 35, notes: "driver: Ahmed, cash", publishedRate: 80,
  pledges: [{ id: "pl_1_x", agencyId: 7, seats: 2, status: "confirmed", customers: "A", createdAt: "t" }],
};
const staff = { role: "ops_staff" };
const agency = (agencyId) => ({ role: "agency_owner", agencyId });

test("S03: an anonymous visitor gets no cost, notes, review trail or booking ids", () => {
  const p = presentProduct(product, null);
  for (const k of ["baseCost", "submittedAt", "reviewedAt", "rejectionReason"]) assert.ok(!(k in p), `product.${k}`);
  assert.equal(p.publishedRate, 80, "the price a traveller pays stays");
  const d = presentDeparture(departure, null);
  for (const k of ["baseCost", "notes"]) assert.ok(!(k in d), `departure.${k}`);
  assert.deepEqual(d.pledges, [{ seats: 2, status: "confirmed" }]);
});

test("S03: staff see everything; an operator sees its own listing's review trail only", () => {
  assert.deepEqual(presentProduct(product, staff), product);
  assert.equal(presentProduct(product, agency(7)).rejectionReason, "photos");
  assert.ok(!("rejectionReason" in presentProduct(product, agency(8))));
  assert.ok(!("baseCost" in presentProduct(product, agency(8))));
  const d = presentDeparture(departure, agency(8));
  assert.ok(!("baseCost" in d));
  assert.equal(d.notes, departure.notes, "signed-in agencies keep the notes their preview falls back to");
});

test("S03: the bootstrap payload is built through the presenters", () => {
  assert.match(app, /tourProducts: mappedProducts\.map\(\(p\) => presentProduct\(p, user\)\)/);
});

const route = (sig) => {
  const f = app.indexOf(sig);
  assert.ok(f > 0, `not found: ${sig}`);
  return app.slice(f, app.indexOf("\n}));", f));
};

test("F02: a date request can't be bigger than the date it creates", () => {
  const fn = app.slice(app.indexOf("async function createDateRequest("), app.indexOf('app.post("/api/public/departure-requests"'));
  const check = fn.indexOf("input.seats > capacity");
  const insert = fn.indexOf("INSERT INTO departures");
  assert.ok(check > 0 && check < insert, "the size check runs before anything is written");
  assert.match(route('app.post("/api/admin/departure-requests/:id/approve"'), /seatsTotal\(dep\.pledges\) > dep\.maxSeats/,
    "an over-capacity request made before the check can't be opened");
});

test("F03: reinstating a booking locks the date and checks the seats", () => {
  const body = route('app.patch("/api/admin/bookings/:id"');
  const lock = body.indexOf("{ forUpdate: true }");
  const check = body.indexOf("taken + wanted > dep.maxSeats");
  const write = body.indexOf("UPDATE pledges SET status=$1");
  assert.ok(lock > 0 && lock < check && check < write, "lock, then check, then write");
  assert.match(body, /SELECT status, seats FROM pledges WHERE id=\$1 FOR UPDATE/, "the booking is re-read under the lock");
});
