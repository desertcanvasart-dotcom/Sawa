// U01 — which company runs a date. The rule the client set on 25 Sep 2026; see
// operatorForDeparture() in domain.js. Before this, 18 of 19 live tours named
// no company at all, although the page promises one "before you book".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorForDeparture, directOperatorId } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const CTS = "ag_cts", A = "ag_a", B = "ag_b", LISTER = "ag_lister";
let clock = 0;
const bk = (agencyId, seats, status = "confirmed") =>
  ({ agencyId, seats, status, createdAt: new Date(Date.UTC(2026, 8, 1) + ++clock * 60_000).toISOString() });
const date = (...pledges) => ({ minSeats: 4, maxSeats: 12, status: "open", pledges });
const op = (d, o = {}) => operatorForDeparture(d, { directAgencyId: CTS, ...o });

test("nobody booked: the listing agency, else the direct-bookings operator", () => {
  assert.equal(op(date(), { listingAgencyId: LISTER }), LISTER);
  assert.equal(op(date()), CTS);
});

test("the first booker runs it; a tie does not take it away", () => {
  assert.equal(op(date(bk(A, 1))), A);
  assert.equal(op(date(bk(A, 1), bk(B, 1))), A, "1 vs 1 stays with the first");
  assert.equal(op(date(bk(A, 1), bk(B, 2))), B, "strictly more takes over");
});

test("travellers booking directly count as the direct-bookings operator's", () => {
  assert.equal(op(date(bk(null, 3), bk(A, 1))), CTS, "3 direct vs 1 from A");
  assert.equal(op(date(bk(null, 1), bk(A, 2))), A);
});

test("fixed at GoAhead: bookings after the minimum don't change it", () => {
  // A 2 + B 2 reaches the minimum of 4 with A still leading (tie). B then adds
  // three more — B has most seats, but the date was already confirmed under A.
  assert.equal(op(date(bk(A, 2), bk(B, 2), bk(B, 3))), A);
  // Before GoAhead the same overtaking does change it.
  assert.equal(op(date(bk(A, 1), bk(B, 2))), B);
});

test("cancelled bookings don't count", () => {
  assert.equal(op(date(bk(A, 3, "cancelled"), bk(B, 1))), B);
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
  const at = app.indexOf("enriched.operatorAgencyId = operatorForDeparture(enriched,");
  assert.ok(at > 0 && at < app.indexOf("return presentDeparture(enriched, user);", at));
  assert.match(app, /operatorAgencyId: p\.agencyId \|\| directAgencyId \|\| null/);
  assert.match(read("src", "main.jsx"),
    /operatorsByProduct\[dep\?\.operatorAgencyId \|\| tour\.operatorAgencyId \|\| tour\.agencyId\]/,
    "the tour page names the selected date's operator");
});
