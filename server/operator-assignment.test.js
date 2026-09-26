// U01 — which company runs a date. The rule the client set on 26 Sep 2026
// (replacing 25 Sep's); see operatorForDeparture() in domain.js. Before U01,
// 18 of 19 live tours named no company at all, although the page promises one
// "before you book".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorForDeparture, directOperatorId } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const CTS = "ag_cts", A = "ag_a", B = "ag_b", LISTER = "ag_lister";
const T = (min) => new Date(Date.UTC(2026, 8, 1) + min * 60_000).toISOString();
let clock = 0;
// A booking: who, how many, and optionally when its deposit was paid.
const bk = (agencyId, seats, { status = "confirmed", paid = null, source = null, refCode = null, at = ++clock } = {}) =>
  ({ agencyId, seats, status, createdAt: T(at), ...(paid != null ? { depositPaidAt: T(paid) } : {}), ...(source ? { source } : {}), ...(refCode ? { refCode } : {}) });
const date = (...pledges) => ({ minSeats: 4, maxSeats: 12, status: "open", pledges });
const op = (d, o = {}) => operatorForDeparture(d, { directAgencyId: CTS, ...o });

test("nobody booked: the listing agency, else the direct-bookings operator", () => {
  assert.equal(op(date(), { listingAgencyId: LISTER }), LISTER);
  assert.equal(op(date()), CTS);
});

test("most passengers runs it — the client's worked examples", () => {
  // §1: 6 direct vs agency A's 3 → Capital Travel Service.
  assert.equal(op(date(bk(null, 6), bk(A, 3))), CTS);
  // §2: CTS 8, A 4, B 2 → CTS; A rises to 10 → A.
  assert.equal(op(date(bk(null, 8), bk(A, 4), bk(B, 2))), CTS);
  assert.equal(op(date(bk(null, 8), bk(A, 4), bk(B, 2), bk(A, 6))), A);
  // §4: CTS 5, A 3, B 8 → B; CTS rises to 10 → CTS.
  assert.equal(op(date(bk(null, 5), bk(A, 3), bk(B, 8))), B);
  assert.equal(op(date(bk(null, 5), bk(A, 3), bk(B, 8), bk(null, 5))), CTS);
});

test("it keeps following the passengers after GoAhead — no longer fixed at the minimum", () => {
  // The old rule locked A in once 4 seats were reached. Now B's later seats count.
  assert.equal(op(date(bk(A, 2), bk(B, 2), bk(B, 3))), B);
});

test("travellers booking directly count as the direct-bookings operator's", () => {
  assert.equal(op(date(bk(null, 3), bk(A, 1))), CTS, "3 direct vs 1 from A");
  assert.equal(op(date(bk(null, 1), bk(A, 2))), A);
  // What the booking routes actually store for a direct traveller.
  assert.equal(op(date(bk("direct_customer", 3), bk(A, 1))), CTS, "the stored direct marker counts as CTS");
  assert.equal(op(date(bk("direct_customer", 1), bk(null, 1), bk(A, 1))), CTS, "marker and null pool together");
});

test("a traveller who booked through an agency's widget counts for that agency", () => {
  const referralAgencies = new Map([["agency-a", A]]);
  const d = date(bk(null, 2), bk("direct_customer", 3, { refCode: "agency-a" }));
  assert.equal(op(d, { referralAgencies }), A, "3 widget seats for A beat 2 direct");
  assert.equal(op(d), CTS, "without the code map they are direct seats");
  // A code that belongs to no agency (an admin partner) stays direct.
  assert.equal(op(date(bk(null, 1), bk("direct_customer", 3, { refCode: "blogger" }), bk(A, 2)), { referralAgencies }), CTS);
});

test("a tie goes to the agency that created the departure", () => {
  // §5: A opened the date; A 5, B 5 → A. B reaches 6 → B.
  const opened = bk(A, 2, { source: "agency_request" });
  assert.equal(op(date(bk(B, 5), opened, bk(A, 3))), A, "tie, and A is the creator — even though B booked first");
  assert.equal(op(date(bk(B, 5), opened, bk(A, 3), bk(B, 1))), B, "strictly more takes it");
  // A traveller-requested date is Capital Travel Service's…
  assert.equal(op(date(bk(A, 2), bk(null, 2, { source: "public_request" }))), CTS);
  // …unless the traveller came through an agency's widget.
  const referralAgencies = new Map([["agency-b", B]]);
  assert.equal(op(date(bk(A, 2), bk(null, 2, { source: "public_request", refCode: "agency-b" })), { referralAgencies }), B);
  // A date Sawa published belongs to the listing agency, else to CTS.
  assert.equal(op(date(bk(A, 2), bk(LISTER, 2)), { listingAgencyId: LISTER }), LISTER);
  assert.equal(op(date(bk(A, 2), bk(null, 2))), CTS);
});

test("the creator keeps the tie even after withdrawing its opening booking", () => {
  const opened = bk(A, 2, { source: "agency_request", status: "cancelled" });
  assert.equal(op(date(opened, bk(B, 3), bk(A, 3))), A);
});

test("tied without the creator: whoever booked first", () => {
  assert.equal(op(date(bk(B, 2), bk(A, 2)), { listingAgencyId: LISTER }), B);
  assert.equal(op(date(bk(A, 2), bk(B, 2)), { listingAgencyId: LISTER }), A);
});

test("once anyone has paid a deposit, only paid passengers count", () => {
  // A has more seats, but only B's are paid.
  assert.equal(op(date(bk(A, 5), bk(B, 2, { paid: 100 }))), B);
  assert.equal(op(date(bk(A, 5, { paid: 101 }), bk(B, 2, { paid: 100 }))), A);
  // Nobody paid yet: every live booking counts (a provisional operator).
  assert.equal(op(date(bk(A, 5), bk(B, 2))), A);
});

test("fixed when bookings close: nothing booked or paid after the cutoff counts", () => {
  const lockAtMs = Date.parse(T(500));
  const d = date(bk(A, 3, { at: 100 }), bk(B, 2, { at: 200 }), bk(B, 4, { at: 600 }));
  assert.equal(op(d, { lockAtMs, nowMs: lockAtMs - 1 }), B, "before the cutoff B's later seats count");
  assert.equal(op(d, { lockAtMs, nowMs: lockAtMs + 1 }), A, "after it, B's post-cutoff seats don't");
  const paidLate = date(bk(A, 3, { at: 100, paid: 400 }), bk(B, 5, { at: 200, paid: 700 }));
  assert.equal(op(paidLate, { lockAtMs, nowMs: lockAtMs + 1 }), A, "a deposit paid after the cutoff doesn't count");
});

test("cancelled bookings don't count", () => {
  assert.equal(op(date(bk(A, 3, { status: "cancelled" }), bk(B, 1))), B);
});

test("no direct-bookings operator on record: direct seats name nobody, agencies still do", () => {
  assert.equal(operatorForDeparture(date(bk(null, 3)), { listingAgencyId: LISTER }), LISTER);
  assert.equal(operatorForDeparture(date(bk(null, 3), bk(A, 1))), A);
  assert.equal(operatorForDeparture(date(bk(null, 3))), null);
});

test("the direct-bookings operator is found by name, exactly", () => {
  const agencies = [{ id: "ag_1", name: "Someone Else" }, { id: CTS, name: " capital travel service " }];
  assert.equal(directOperatorId(agencies, "Capital Travel Service"), CTS);
  assert.equal(directOperatorId(agencies, "Capital Travel"), null, "no partial matches");
  assert.equal(directOperatorId([], "Capital Travel Service"), null);
});

test("every date and listing carries its operator, computed before pledges are stripped", () => {
  const app = read("server", "app.js");
  const at = app.indexOf("enriched.operatorAgencyId = operatorForDeparture(");
  assert.ok(at > 0 && at < app.indexOf("return presentDeparture(enriched, user);", at));
  assert.match(app, /operatorAgencyId: p\.agencyId \|\| directAgencyId \|\| null/);
  assert.match(read("src", "main.jsx"),
    /operatorsByProduct\[dep\?\.operatorAgencyId \|\| tour\.operatorAgencyId \|\| tour\.agencyId\]/,
    "the tour page names the selected date's operator");
});
