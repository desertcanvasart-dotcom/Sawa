// 24 Sep 2026 — operators can request a new date from their dashboard.
//
// Before: a tour with no dates was greyed out on "Book seats", so an operator
// could only join what Sawa had published. The one server route that let an
// agency open a date (POST /api/departures) opened it straight to `open`, with
// a hard-coded date and placeholder prices, and no review. It is removed; the
// operator path now runs through the same createDateRequest as the traveller's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/never-connected";
const { opsNewBookingEmail } = await import("./email.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
const route = (sig) => {
  const f = app.indexOf(sig);
  assert.ok(f > 0, `route not found: ${sig}`);
  return app.slice(f, app.indexOf("\n}));", f));
};

test("the review-bypassing agency create route is gone", () => {
  assert.equal(app.indexOf('app.post("/api/departures",'), -1);
  assert.equal(app.indexOf("createDepartureSchema"), -1);
});

test("an operator request goes through the traveller's rules, as the operator", () => {
  const body = route('app.post("/api/agency/departure-requests"');
  assert.match(body, /requireRole\("agency_owner", "agency_agent"\)/);
  assert.match(body, /createDateRequest\(input, req, \{ agencyId: agency\.id, agencyName: agency\.name, userId: req\.user\.id \}\)/);
  assert.match(body, /code: "near_matches"/, "join-first must apply to operators too");
  assert.match(body, /notifyOps\([^;]*isRequest: true, bookedBy: agency\.name/);
  assert.match(body, /logAudit\(/);
  // Sawa does not email an operator's customer.
  assert.doesNotMatch(body, /departureRequestReceivedEmail/);
});

test("one implementation of a date request, for both callers", () => {
  const fn = app.slice(app.indexOf("async function createDateRequest("), app.indexOf('app.post("/api/public/departure-requests"'));
  // In review, with a pending booking, whoever asked.
  assert.match(fn, /'pending_review'/);
  assert.match(fn, /status: "pending"/);
  assert.match(fn, /requester\.agencyId \? "agency" : "traveler"/, "created_by must name who asked");
  assert.match(fn, /requester\.agencyId \? "agency_request" : "public_request"/);
  for (const rule of ["unavailableDates()", "minLeadDaysFor(product)", "maxHorizonDaysFor(product)", "operatingDayError(product, input.date)", "ignoreMatches"]) {
    assert.ok(fn.includes(rule), `the shared request path lost: ${rule}`);
  }
  assert.match(route('app.post("/api/public/departure-requests"'), /createDateRequest\(input, req\)/);
});

test("an operator sees only their own requests", () => {
  const body = route('app.get("/api/agency/departure-requests"');
  assert.match(body, /WHERE p\.agency_id = \$1 AND p\.source = 'agency_request'/);
  assert.match(body, /\[req\.user\.agencyId\]/);
});

test("the ops notice names the operator who asked", () => {
  const m = opsNewBookingEmail({ to: "hello@sawa.tours", isRequest: true, bookedBy: "El Agamy Travel",
    route: "Giza", dateLabel: "2026-10-10", seats: 3, customerName: "E-3-3" });
  assert.match(m.subject, /^New date request from El Agamy Travel — Giza on 2026-10-10 \(3 seats\)$/);
  assert.match(m.text, /the operator sees it as under review/);
  assert.equal(m.kind, "ops_new_request");
});
