// 24 Sep 2026 — nobody at Sawa was told about new demand. A date request or a
// direct booking emailed the traveller only; the team's one "request received"
// was a test made with their own address. Five real requests arrived unseen,
// one of them waiting 17 days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/never-connected";
const { opsNewBookingEmail, opsNewListingEmail, opsRecipient } = await import("./email.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");

const base = {
  to: "hello@sawa.tours", route: "Memphis, Saqqara & Dahshur", dateLabel: "2026-09-26",
  seats: 2, seatsNow: 2, minSeats: 4, customerName: "Mada", customerEmail: "m@example.com",
  customerPhone: "+20 100", bookingCode: "SAWA-ABCDE", portalLink: "https://sawa.tours/portal",
};

test("a request tells ops who, what, when, and where to decide", () => {
  const m = opsNewBookingEmail({ ...base, isRequest: true, note: "two adults" });
  assert.equal(m.kind, "ops_new_request");
  assert.equal(m.to, "hello@sawa.tours");
  assert.match(m.subject, /^New date request — Memphis, Saqqara & Dahshur on 2026-09-26 \(2 seats\)$/);
  for (const bit of ["Mada", "m@example.com", "+20 100", "SAWA-ABCDE", "two adults", "Date requests", "https://sawa.tours/portal"]) {
    assert.ok(m.text.includes(bit), `missing: ${bit}`);
  }
});

test("a booking says how close the date is to GoAhead", () => {
  const m = opsNewBookingEmail({ ...base, isRequest: false, seats: 1, seatsNow: 3 });
  assert.equal(m.kind, "ops_new_booking");
  assert.match(m.subject, /^New booking — .* \(1 seat\)$/);
  assert.match(m.text, /3 of 4 needed for GoAhead/);
});

test("the recipient is the ops inbox, overridable", () => {
  assert.equal(opsRecipient({ OPS_NOTIFY_TO: "ops@x.test", GOAHEAD_ALERT_TO: "g@x.test" }), "ops@x.test");
  assert.equal(opsRecipient({ GOAHEAD_ALERT_TO: "g@x.test" }), "g@x.test");
  assert.ok(opsRecipient({}).includes("@"));
});

test("both public routes that create demand notify ops", () => {
  const route = (sig) => {
    const from = app.indexOf(sig);
    assert.ok(from > 0, `route not found: ${sig}`);
    return app.slice(from, app.indexOf("\n}));", from));
  };
  assert.match(route('app.post("/api/public/departures/:id/bookings"'), /notifyOps\([^)]*isRequest: false/);
  assert.match(route('app.post("/api/public/departure-requests"'), /notifyOps\([^)]*isRequest: true/);
});

test("approving refuses a date that has already started, and never tells a withdrawn traveller it is live", () => {
  const from = app.indexOf('app.post("/api/admin/departure-requests/:id/approve"');
  const body = app.slice(from, app.indexOf("\n}));", from));
  assert.match(body, /if \(departureStarted\(dep\)\)[\s\S]{0,40}throw new AppError\(409/);
  assert.match(body, /seed\?\.customerEmail && seed\.status !== "cancelled"/);
});

test("an operator's booking names the operator", () => {
  const m = opsNewBookingEmail({ ...base, isRequest: false, bookedBy: "El Agamy Travel", customerName: "E-2-6" });
  assert.match(m.subject, /^New booking by El Agamy Travel — /);
  assert.match(m.text, /Booked by: El Agamy Travel \(operator dashboard\)/);
});

test("an operator's tour submission reaches ops, new or edited", () => {
  const n = opsNewListingEmail({ to: "hello@sawa.tours", title: "Giza at dawn", agencyName: "Capital Travel Service", portalLink: "https://sawa.tours/portal" });
  assert.equal(n.kind, "ops_new_listing");
  assert.match(n.subject, /^New tour listing to review — Giza at dawn$/);
  assert.match(n.text, /Capital Travel Service/);
  assert.match(n.text, /Listing requests/);
  assert.match(opsNewListingEmail({ title: "X", isEdit: true }).subject, /^Tour listing updated to review/);
});

test("the operator dashboard's booking and listing routes notify ops", () => {
  const route = (sig) => { const f = app.indexOf(sig); assert.ok(f > 0, sig); return app.slice(f, app.indexOf("\n}));", f)); };
  assert.match(route('app.post("/api/departures/:id/pledges"'), /notifyOps\([^;]*bookedBy/);
  assert.match(route('app.post("/api/agency/tour-products"'), /opsNewListingEmail\(/);
});
