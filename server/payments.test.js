// 043 — the payment-link rules, without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linkDueAt, paymentSummary, defaultAmount, paidTotal, cleanLinkUrl,
  MIN_WINDOW_HOURS, BALANCE_LINK_LEAD_DAYS, isMissingPaymentsTable,
} from "./payments.js";

const H = 3600000;
const D = 24 * H;
const T0 = Date.parse("2026-10-01T09:00:00Z");

const pledge = (over = {}) => ({
  id: "pl_1", status: "confirmed", bookingTotal: 1000, depositDue: 250, balanceDue: 750,
  balanceDueDate: "2026-11-01", ...over,
});
const pay = (over = {}) => ({
  id: 1, kind: "deposit", amount: 250, state: "link_sent",
  linkUrl: "https://pay.tab.travel/x", dueAt: new Date(T0 + 3 * D).toISOString(), ...over,
});

// ---- when a link falls due

test("a deposit link gets 3 days when the confirm deadline is further away", () => {
  const departure = { date: "2026-12-01", time: "08:00", type: "day_tour" };
  const { dueAt, boundBy } = linkDueAt({ kind: "deposit", sentAtMs: T0, departure, product: { type: "day_tour" } });
  assert.equal(dueAt, T0 + 3 * D);
  assert.equal(boundBy, "window");
});

test("a deposit link is cut to the confirm deadline when that comes first", () => {
  // Day tours confirm 7 days out by default: 9 days away leaves about 2.
  const departure = { date: "2026-10-10", time: "09:00", type: "day_tour" };
  const { dueAt, boundBy } = linkDueAt({ kind: "deposit", sentAtMs: T0, departure, product: { type: "day_tour" } });
  assert.equal(boundBy, "confirm-deadline");
  assert.ok(dueAt < T0 + 3 * D && dueAt >= T0 + MIN_WINDOW_HOURS * H, new Date(dueAt).toISOString());
});

test("no link is ever due in less than the minimum window", () => {
  // Confirm deadline already behind us.
  const departure = { date: "2026-10-03", time: "09:00", type: "day_tour" };
  const { dueAt, boundBy } = linkDueAt({ kind: "deposit", sentAtMs: T0, departure, product: { type: "day_tour" } });
  assert.equal(boundBy, "minimum");
  assert.equal(dueAt, T0 + MIN_WINDOW_HOURS * H);
});

test("a balance link is due on the balance due date the traveller was quoted", () => {
  const { dueAt, boundBy } = linkDueAt({ kind: "balance", sentAtMs: T0, balanceDueDate: "2026-10-20" });
  assert.equal(boundBy, "balance-due-date");
  // End of that day in Cairo (UTC+3 in October 2026 → 20:59Z).
  assert.equal(new Date(dueAt).toISOString(), "2026-10-20T20:59:00.000Z");
});

test("a late balance link still gets the minimum window", () => {
  const { dueAt, boundBy } = linkDueAt({ kind: "balance", sentAtMs: T0, balanceDueDate: "2026-10-01" });
  assert.equal(boundBy, "minimum");
  assert.equal(dueAt, T0 + MIN_WINDOW_HOURS * H);
});

// ---- amounts

test("paid total counts paid links only — not open, void or refunded ones", () => {
  const rows = [
    pay({ state: "paid", amount: 250 }), pay({ id: 2, state: "void", amount: 999 }),
    pay({ id: 3, state: "refunded", amount: 100 }), pay({ id: 4, state: "link_sent", amount: 750 }),
  ];
  assert.equal(paidTotal(rows), 250);
});

test("default amounts: the quoted deposit, then whatever is left", () => {
  assert.equal(defaultAmount("deposit", pledge()), 250);
  assert.equal(defaultAmount("full", pledge()), 1000);
  assert.equal(defaultAmount("balance", pledge(), [pay({ state: "paid" })]), 750);
  // A deposit link never asks for more than is outstanding.
  assert.equal(defaultAmount("deposit", pledge(), [pay({ state: "paid", amount: 900 })]), 100);
});

// ---- where a booking stands

const stage = (args) => paymentSummary({ nowMs: T0, ...args }).stage;

test("nothing is due before GoAhead", () => {
  assert.equal(stage({ pledge: pledge(), goAhead: false }), "not_due");
});

test("at GoAhead the queue asks for a deposit link", () => {
  const s = paymentSummary({ pledge: pledge(), goAhead: true, nowMs: T0 });
  assert.equal(s.stage, "deposit_link_needed");
  assert.equal(s.action, "send_deposit_link");
  assert.equal(s.outstanding, 1000);
});

test("an open link is 'link sent', then 'overdue' once its time passes", () => {
  const rows = [pay()];
  assert.equal(stage({ pledge: pledge(), payments: rows, goAhead: true }), "link_sent");
  const late = paymentSummary({ pledge: pledge(), payments: rows, goAhead: true, nowMs: T0 + 4 * D });
  assert.equal(late.stage, "overdue");
  assert.equal(late.action, "chase");
  assert.equal(late.open.overdue, true);
});

test("deposit paid: quiet until a week before the balance due date, then asks for the balance link", () => {
  const rows = [pay({ state: "paid" })];
  assert.equal(stage({ pledge: pledge(), payments: rows, goAhead: true }), "deposit_paid");
  const weekBefore = Date.parse("2026-11-01T00:00:00Z") - BALANCE_LINK_LEAD_DAYS * D;
  const s = paymentSummary({ pledge: pledge(), payments: rows, goAhead: true, nowMs: weekBefore });
  assert.equal(s.stage, "balance_link_needed");
  assert.equal(s.action, "send_balance_link");
  assert.equal(s.outstanding, 750);
});

test("paid in full once everything is received", () => {
  const rows = [pay({ state: "paid" }), pay({ id: 2, kind: "balance", amount: 750, state: "paid" })];
  const s = paymentSummary({ pledge: pledge(), payments: rows, goAhead: true, nowMs: T0 });
  assert.equal(s.stage, "paid_in_full");
  assert.equal(s.outstanding, 0);
  assert.equal(s.action, null);
});

test("a void link does not hold the booking in 'link sent'", () => {
  const rows = [pay({ state: "void" })];
  assert.equal(stage({ pledge: pledge(), payments: rows, goAhead: true }), "deposit_link_needed");
});

test("a cancelled booking with money received asks for a refund", () => {
  const s = paymentSummary({ pledge: pledge({ status: "cancelled" }), payments: [pay({ state: "paid" })], goAhead: true, nowMs: T0 });
  assert.equal(s.stage, "cancelled");
  assert.equal(s.action, "refund");
  assert.equal(paymentSummary({ pledge: pledge({ status: "cancelled" }), goAhead: true, nowMs: T0 }).action, null);
});

// ---- input

test("only https links are accepted", () => {
  assert.equal(cleanLinkUrl("https://pay.tab.travel/abc"), "https://pay.tab.travel/abc");
  for (const bad of ["", "http://pay.tab.travel/abc", "javascript:alert(1)", "not a url", `https://x.com/${"a".repeat(1000)}`]) {
    assert.equal(cleanLinkUrl(bad), null, bad);
  }
});

test("the missing-table check matches only this table's error", () => {
  assert.equal(isMissingPaymentsTable({ code: "42P01", message: 'relation "booking_payments" does not exist' }), true);
  assert.equal(isMissingPaymentsTable({ code: "42P01", message: 'relation "other" does not exist' }), false);
  assert.equal(isMissingPaymentsTable({ code: "23505", message: "booking_payments" }), false);
});
