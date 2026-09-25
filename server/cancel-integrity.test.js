// S02 + F04, from the 25 Sep 2026 audit.
//
// S02: DELETE /api/public/departures/:id/bookings/:pledgeId took nothing but a
// pledge id, and the anonymous catalogue published every pledge id — anyone
// could cancel anyone's booking. It also erased the row and ignored GoAhead.
//
// F04: a date that had reached GoAhead and then lost a traveller (4 -> 3) read
// "Forming" on the booking page and made cancelling free again, although the
// stored status — the authority — still said minimum_reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bookingLookupView } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
const main = readFileSync(join(ROOT, "src", "main.jsx"), "utf8");

test("S02: the id-only public cancel route is gone", () => {
  assert.doesNotMatch(app, /app\.delete\("\/api\/public\/departures\/:id\/bookings\/:pledgeId"/);
  assert.doesNotMatch(main, /\/public\/departures\/\$\{[^}]+\}\/bookings\/\$\{[^}]+\}/,
    "the tour page must not call it either");
  assert.match(main, /\/public\/bookings\/\$\{encodeURIComponent\(publicBooking\.code\)\}\/cancel/,
    "the tour page cancels with the booking code");
});

test("S02: anonymous visitors get seat counts, never booking ids", () => {
  const fn = app.slice(app.indexOf("function viewPledges("), app.indexOf("function presentDeparture("));
  assert.match(fn, /if \(!user\) return pledges\.map\(\(p\) => \(\{ seats: p\.seats, status: p\.status \}\)\);/);
});

test("S02: agencies cancel through the Terms-aware route, not the erasing DELETE", () => {
  assert.match(app, /app\.delete\("\/api\/departures\/:id\/pledges\/:pledgeId", requireAuth, requireRole\("super_admin", "ops_staff"\)/);
  assert.match(main, /\/agency\/bookings\/\$\{encodeURIComponent\(pledgeId\)\}\/cancel/);
});

test("F04: a GoAhead date that drops below its minimum stays confirmed and not freely cancellable", () => {
  const v = bookingLookupView({ departureStatus: "minimum_reached", pledgeStatus: "confirmed", seatsBooked: 3, goAhead: 4 });
  assert.equal(v.state, "confirmed");
  assert.equal(v.canCancel, false, "a stored GoAhead keeps the Terms' §13.2 boundary");
});

test("F04: still forming below the minimum while the date is open", () => {
  const v = bookingLookupView({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 3, goAhead: 4 });
  assert.equal(v.state, "forming");
  assert.equal(v.canCancel, true);
});

test("F04: the tour page reads the date's state, not a fresh headcount", () => {
  assert.match(main, /const confirmed = !!dep && isGoAheadDeparture\(dep\);/);
  assert.doesNotMatch(main, /seats >= goAhead &&|>= goAheadSeatsFor\(/,
    "a recount of seats against the minimum is how a confirmed date read as forming");
});
