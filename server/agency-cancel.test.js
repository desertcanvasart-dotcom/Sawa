// 25 Sep 2026 — an operator can cancel a booking it placed, from "My bookings".
//
// Before: the portal listed an agency's bookings with no way to cancel one.
// The only agency-reachable route was the old DELETE, which erases the row and
// stops only at supplier_confirmed. The portal's route follows the traveller's
// cancel link instead: marked cancelled, Terms §13 boundary, tenant-checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bookingLookupView } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
const ui = readFileSync(join(ROOT, "src", "AgencyDashboard.jsx"), "utf8");
const route = (sig) => {
  const f = app.indexOf(sig);
  assert.ok(f > 0, `route not found: ${sig}`);
  return app.slice(f, app.indexOf("\n}));", f));
};
const body = route('app.post("/api/agency/bookings/:pledgeId/cancel"');

test("agencies only, and only their own bookings", () => {
  assert.match(body, /requireRole\("agency_owner", "agency_agent"\)/);
  assert.match(body, /agency_id !== req\.user\.agencyId/);
});

test("the booking is marked cancelled, never deleted", () => {
  assert.match(body, /UPDATE pledges SET status='cancelled' WHERE id=\$1/);
  assert.doesNotMatch(body, /DELETE FROM pledges/);
  assert.match(body, /refreshStatus\(c, dep\.id\)/, "the released seat must be recounted");
  assert.match(body, /logAudit\(/);
});

test("the Terms boundary is the traveller's, decided by bookingLookupView", () => {
  assert.match(body, /bookingLookupView\(/);
  assert.match(body, /if \(!view\.canCancel\)/);
  const view = (departureStatus, seatsBooked) =>
    bookingLookupView({ departureStatus, pledgeStatus: "confirmed", seatsBooked, goAhead: 4 });
  assert.equal(view("open", 2).canCancel, true, "forming: free to cancel");
  assert.equal(view("pending_review", 1).canCancel, true, "a request under review can be withdrawn");
  assert.equal(view("minimum_reached", 4).canCancel, false, "after GoAhead §13.2 applies");
  assert.equal(view("supplier_confirmed", 4).canCancel, false);
});

test("the portal calls this route, not the erasing DELETE", () => {
  assert.match(ui, /\/agency\/bookings\/\$\{encodeURIComponent\(pledgeId\)\}\/cancel/);
  assert.doesNotMatch(ui, /method: "DELETE"/);
});
