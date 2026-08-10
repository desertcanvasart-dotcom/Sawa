// DIR-20 — the payment-link alert, proved both ways.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { alertPayload, reportAlerts, GOAHEAD, GOAHEAD_ALERT } from "./goahead-alert.js";
import { goAheadPaymentLinkEmail } from "./email.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const departure = {
  id: 7, route: "Giza Pyramids & Sphinx", start_date: "2026-09-12", end_date: "2026-09-12",
  min_seats: 4, tour_product_id: "p1",
};
const pledges = [
  { seats: 2, customers: "A Traveller", customer_email: "a@b.c", status: "confirmed",
    booking_code: "SW-19", booking_total: 340, deposit_due: 102, balance_due: 238, balance_due_date: "2026-09-01" },
  { seats: 2, customers: "B Traveller", agency: "Nile Co", status: "confirmed",
    booking_total: 300, deposit_due: 90, balance_due: 210 },
  { seats: 3, customers: "Cancelled Person", customer_email: "c@d.e", status: "cancelled" },
];

// ---------------------------------------------------------------- 20.2
test("the alert carries everything needed to act without opening anything else", () => {
  const p = alertPayload({ departure, pledges, agency: { name: "Nile Co", phone: "+20 100" },
    portalBase: "https://sawa.tours" });
  assert.equal(p.route, "Giza Pyramids & Sphinx");
  assert.equal(p.date, "2026-09-12");
  assert.equal(p.operator, "Nile Co");
  assert.equal(p.operatorContact, "+20 100");
  assert.equal(p.seatsConfirmed, 4, "a cancelled pledge must not be counted as confirmed");
  assert.equal(p.travellers.length, 2, "a cancelled traveller must not be listed for payment");
  assert.equal(p.depositTotal, 192);
  assert.equal(p.portalLink, "https://sawa.tours/admin/departures/7");
  for (const t of p.travellers) {
    assert.ok(t.name && t.contact && t.seats, `a traveller row is incomplete: ${JSON.stringify(t)}`);
  }
});

// The regression the rehearsal found. String fixtures passed while the real
// thing put a host-timezone Date toString into an ops email subject line.
test("dates render as YYYY-MM-DD even though pg returns Date objects", () => {
  const asDb = { ...departure, start_date: new Date(2026, 8, 12), end_date: new Date(2026, 8, 12),
    date: new Date(2026, 8, 12) };
  const p = alertPayload({ departure: asDb, pledges: [], agency: null });
  assert.equal(p.date, "2026-09-12",
    "a Date object must not reach the reader, and a single-day departure is not a range");
  assert.doesNotMatch(goAheadPaymentLinkEmail({ to: "o@s.t", payload: p }).subject, /GMT|Summer Time/);
});

test("a multi-day departure states both ends of its date", () => {
  const p = alertPayload({ departure: { ...departure, end_date: new Date(2026, 8, 19) }, pledges: [], agency: null });
  assert.equal(p.date, "2026-09-12 – 2026-09-19");
});

test("amounts come from the row, not from a recomputation", () => {
  // 023 captured what the traveller was QUOTED. Recomputing here could put a
  // different number on the invoice from the one in their confirmation email.
  const p = alertPayload({ departure, pledges, agency: null });
  assert.equal(p.travellers[0].total, 340);
  assert.equal(p.travellers[0].balanceDueDate, "2026-09-01");
});

test("what is NOT known is stated, not rendered as nothing", () => {
  const p = alertPayload({
    departure, agency: null,
    pledges: [{ seats: 4, customers: "X", customer_email: "x@y.z", status: "confirmed", booking_total: null }],
  });
  assert.ok(p.unknowns.some((u) => /operator not recorded/.test(u)));
  assert.ok(p.unknowns.some((u) => /no captured total/.test(u)));
  const mail = goAheadPaymentLinkEmail({ to: "ops@sawa.tours", payload: p });
  assert.match(mail.text, /NOT RECORDED/, "a missing operator must be visible in the email");
  assert.match(mail.text, /⚠️/, "unknowns must reach the reader, not just the payload");
});

test("it stops — a complete departure raises no warnings", () => {
  const p = alertPayload({ departure, pledges: pledges.slice(0, 1), agency: { name: "Nile Co" } });
  assert.deepEqual(p.unknowns, []);
});

test("the alert is internal — it names no traveller-facing promise", () => {
  const p = alertPayload({ departure, pledges, agency: { name: "Nile Co" } });
  const mail = goAheadPaymentLinkEmail({ to: "ops@sawa.tours", payload: p });
  assert.equal(mail.kind, "goahead_payment_link");
  assert.doesNotMatch(mail.subject, /your booking|dear/i);
});

// ---------------------------------------------------------------- 20.4
test("it fires — a shortfall is an error, not a quiet success", () => {
  const errors = [];
  const ok = reportAlerts({ intended: 3, sent: 1, log: () => {}, error: (m) => errors.push(m) });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /SHORTFALL/);
  assert.match(errors[0], /2 confirmed departure\(s\) are waiting/);
});

test("it stops — a full send and an empty queue are both reported as success", () => {
  const errors = [];
  const cap = { log: () => {}, error: (m) => errors.push(m) };
  assert.equal(reportAlerts({ intended: 3, sent: 3, ...cap }), true);
  assert.equal(reportAlerts({ intended: 0, sent: 0, ...cap }), true);
  assert.deepEqual(errors, [], "a complete run must not produce an error line");
});

// ---------------------------------------------------------------- 20.1
test("the record is written in refreshStatus, not in a route handler", () => {
  const app = readFileSync(join(ROOT, "server/departure-status.js"), "utf8");
  const from = app.indexOf("export async function refreshStatus");
  const body = app.slice(from, app.indexOf("\n}", from));
  assert.match(body, /recordGoAhead\(c, departureId/,
    "refreshStatus no longer records the GoAhead — a route-level trigger fires for one path and no other");
  assert.match(body, /status === "minimum_reached" && row\.status !== "minimum_reached"/,
    "the record must be written on the TRANSITION, or every subsequent write re-queues the departure");
});

test("the queue is derived from two distinct actions, and they are not the same", () => {
  assert.notEqual(GOAHEAD, GOAHEAD_ALERT,
    "if confirming and alerting share an action name, every confirmation looks already-alerted");
});

test("nothing sends email from inside the transaction that confirms", () => {
  const app = readFileSync(join(ROOT, "server/departure-status.js"), "utf8");
  const from = app.indexOf("export async function refreshStatus");
  const body = app.slice(from, app.indexOf("\n}", from));
  assert.doesNotMatch(body, /sendEmail|Email\(/,
    "a send that succeeded before a rollback would announce a departure that never confirmed");
});
