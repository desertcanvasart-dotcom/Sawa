// U01 polish — the traveller's emails name the partner running their date.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The pool is never queried here (every lookup is handed a stand-in), but
// importing it needs a URL; a closed port, as in email-contract.test.js.
process.env.DATABASE_URL ||= "postgres://nobody:nobody@127.0.0.1:1/none";
const { bookingConfirmationEmail, goAheadEmail } = await import("./email.js");
const { operatorFor } = await import("./operator-lookup.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const booking = {
  to: "a@b.c", route: "Giza", dateLabel: "2026-10-12", seats: 2,
  depositDue: 14, balanceDue: 112, balanceDueDate: "2026-10-01", bookingCode: "SAWA-ABCD2345",
};
const cts = { name: "Capital Travel Service", verified: true };

test("the booking confirmation names the operator, and says it can change until bookings close", () => {
  const mail = bookingConfirmationEmail({ ...booking, operator: cts });
  for (const part of [mail.html, mail.text]) {
    assert.match(part, /Run by:/);
    assert.match(part, /Capital Travel Service/);
    assert.match(part, /Until bookings close, the date is run by the partner with the most confirmed travellers/);
  }
  assert.match(mail.text, /\(verified operator\)/);
});

test("without an operator the confirmation reads as before", () => {
  const mail = bookingConfirmationEmail(booking);
  assert.ok(!/Run by:/.test(mail.html) && !/Run by:/.test(mail.text));
  assert.ok(!/most confirmed travellers on it/.test(mail.text));
});

test("the GoAhead email names the operator running it, and says it can still change until bookings close", () => {
  const mail = goAheadEmail({ to: "a@b.c", route: "Giza", dateLabel: "2026-10-12", operator: cts });
  for (const part of [mail.html, mail.text]) {
    assert.match(part, /Capital Travel Service \(verified operator\) is running this date/);
    assert.match(part, /Until bookings close, the date can pass to another partner/);
  }
  const plain = goAheadEmail({ to: "a@b.c", route: "Giza", dateLabel: "2026-10-12" });
  assert.match(plain.html, /Your operator has been notified/);
});

test("an operator name is escaped in the HTML", () => {
  const evil = { name: "<img src=x onerror=alert(1)>", verified: false };
  for (const mail of [bookingConfirmationEmail({ ...booking, operator: evil }), goAheadEmail({ to: "a@b.c", route: "Giza", dateLabel: "x", operator: evil })]) {
    assert.ok(!mail.html.includes("<img src=x"), mail.kind);
  }
});

// A stand-in for the pool: answers the queries operatorFor makes.
function fakeDb({ pledges, agencies, listing = null, fail = null }) {
  return {
    async query(sql) {
      if (fail) throw fail;
      if (/FROM departures/.test(sql)) return { rows: [{ id: 1, tour_product_id: "t1", min_seats: 4, max_seats: 12, status: "open" }] };
      if (/FROM pledges/.test(sql)) return { rows: pledges };
      if (/FROM tour_products/.test(sql)) return { rows: listing ? [{ agency_id: listing }] : [] };
      if (/FROM agencies/.test(sql)) return { rows: agencies };
      if (/FROM referrals/.test(sql)) return { rows: [] };
      if (/FROM booking_payments/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
const agencies = [
  { id: "ag_cts", name: "Capital Travel Service", verification_state: "verified" },
  { id: "ag_nile", name: "Nile Partners", verification_state: null },
];
const pledge = (agency_id, seats, at) => ({ id: `p${at}`, agency_id, seats, status: "confirmed", created_at: `2026-09-0${at}T10:00:00Z` });

test("operatorFor: the partner with the most travellers, public fields only", async () => {
  const op = await operatorFor(1, fakeDb({ agencies, listing: "ag_nile", pledges: [pledge("ag_nile", 1, 1), pledge(null, 2, 2)] }));
  assert.equal(op.name, "Capital Travel Service", "two direct seats beat one agency seat");
  assert.equal(op.verified, true);
  assert.deepEqual(Object.keys(op).sort(), ["etaaUrl", "licensedSince", "name", "verified", "verifiedAt"].sort());
});

test("operatorFor: a date with no bookings names the listing agency", async () => {
  const op = await operatorFor(1, fakeDb({ agencies, listing: "ag_nile", pledges: [] }));
  assert.equal(op.name, "Nile Partners");
});

test("operatorFor: a database failure leaves the name out rather than the email", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await operatorFor(1, fakeDb({ agencies, pledges: [], fail: new Error("connection reset") })), null);
  } finally {
    console.warn = warn;
  }
});

test("operatorFor: a programmer error is not swallowed", async () => {
  await assert.rejects(operatorFor(1, fakeDb({ agencies, pledges: [], fail: new TypeError("x is not a function") })), TypeError);
});

test("every traveller confirmation and GoAhead send passes the operator", () => {
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  const job = readFileSync(join(ROOT, "server", "jobs", "notify-goahead.js"), "utf8");
  const calls = [...app.matchAll(/(bookingConfirmationEmail|goAheadEmail)\(\{[\s\S]*?\}\)/g), ...job.matchAll(/goAheadEmail\(\{[\s\S]*?\}\)/g)];
  assert.ok(calls.length >= 4, `expected the four send sites, found ${calls.length}`);
  for (const [call] of calls) assert.match(call, /\boperator\b/, call.slice(0, 80));
});
