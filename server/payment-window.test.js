// LLL4 / LLL1.2 — when payment is due.
//
// LLL1.1's finding is the reason this is a function and not a number: the
// 7-day figure is the DAY-TOUR default. Four of the sixteen live products are
// packages at T-30, and `confirm_deadline_days` can override either per
// listing. A hard-coded 7 is wrong for four products today.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { paymentDueAt, paymentWindow, PAYMENT_WINDOW_DAYS } from "../shared/payment-window.js";
import { confirmDeadlineAt, confirmDeadlineDaysFor,
  DEFAULT_PACKAGE_CONFIRM_DEADLINE_DAYS, DEFAULT_DAY_TOUR_CONFIRM_DEADLINE_DAYS } from "./domain.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 1);

test("the full window is three days when the confirm deadline is far away", () => {
  const w = paymentWindow(NOW, NOW + 40 * DAY);
  assert.equal(w.state, "full");
  assert.equal(w.boundBy, "window");
  assert.equal(w.hoursLeft, 72);
});

test("it fires — the confirm deadline cuts the window short", () => {
  const w = paymentWindow(NOW, NOW + 2 * DAY);
  assert.equal(w.state, "compressed");
  assert.equal(w.boundBy, "confirm-deadline");
  assert.equal(w.hoursLeft, 48);
  assert.equal(paymentDueAt(NOW, NOW + 2 * DAY), NOW + 2 * DAY, "whichever is SOONER");
});

test("a window can be hours, and that is not an error", () => {
  const w = paymentWindow(NOW, NOW + 6 * 3600000);
  assert.equal(w.hoursLeft, 6);
  assert.equal(w.state, "compressed");
});

test("already-closed is its own state, not a compressed one", () => {
  // A date confirmed manually after its own deadline. Telling this traveller
  // the window is "short" would tell them they have time when they have none.
  const w = paymentWindow(NOW, NOW - DAY);
  assert.equal(w.state, "already-closed");
  assert.equal(w.hoursLeft, 0);
  assert.ok(paymentDueAt(NOW, NOW - DAY) < NOW,
    "the instant must not be clamped forward — a deadline that moves itself is what storing it prevents");
});

test("an unusable deadline does not silently extend the window", () => {
  assert.equal(paymentDueAt(NOW, NaN), NOW + PAYMENT_WINDOW_DAYS * DAY);
  assert.equal(paymentWindow(NOW, NaN).boundBy, "window");
  assert.ok(Number.isNaN(paymentDueAt(NaN, NOW + DAY)), "no link-sent instant means no due date");
});

// ---------------------------------------------------------------------------
// LLL1.1 — the part a hard-coded 7 gets wrong.
test("a package and a day tour get different windows from the same rule", () => {
  const start = Date.UTC(2026, 10, 1);
  const dep = { startDate: "2026-11-01", type: "package" };
  const pkg = confirmDeadlineAt(dep, { type: "package" });
  const day = confirmDeadlineAt({ ...dep, type: "day_tour" }, { type: "day_tour" });
  assert.equal(confirmDeadlineDaysFor({ type: "package" }, dep), DEFAULT_PACKAGE_CONFIRM_DEADLINE_DAYS);
  assert.equal(confirmDeadlineDaysFor({ type: "day_tour" }, { ...dep, type: "day_tour" }),
    DEFAULT_DAY_TOUR_CONFIRM_DEADLINE_DAYS);
  assert.ok(pkg < day, "a package's deadline is earlier, so its window compresses sooner");

  // Confirmed 35 days out: inside the package's T-30 deadline, nowhere near the
  // day tour's T-7. The same instant produces two different answers, which is
  // exactly what "payment is due 7 days before departure" would have missed.
  const sent = start - 32 * DAY;
  assert.equal(paymentWindow(sent, pkg).state, "compressed", "the package window is cut by T-30");
  assert.equal(paymentWindow(sent, day).state, "full", "the day tour's is not");
});

test("a per-listing override moves the window, and the rule follows it", () => {
  const dep = { startDate: "2026-11-01", type: "day_tour" };
  const overridden = confirmDeadlineAt(dep, { type: "day_tour", confirmDeadlineDays: 45 });
  const dflt = confirmDeadlineAt(dep, { type: "day_tour" });
  assert.ok(overridden < dflt, "an override must actually move the deadline");
  const sent = Date.UTC(2026, 10, 1) - 46 * DAY;
  assert.equal(paymentWindow(sent, overridden).state, "compressed",
    "hard-coding 7 would have given this traveller three full days past their own deadline");
});

// ---------------------------------------------------------------------------
test("the proposed migration stores the window rather than deriving it", () => {
  // LLL4's load-bearing choice, pinned: an operator changing the deadline must
  // not retroactively move a date a traveller was already told in writing.
  const sql = readFileSync(join(ROOT, "server/db/schema_028_payment_window.sql"), "utf8");
  assert.match(sql, /payment_due_at\s+TIMESTAMPTZ/);
  assert.match(sql, /payment_link_sent_at\s+TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /ADD COLUMN IF NOT EXISTS overdue/,
    "`overdue` is derivable from payment_due_at and paid_at; a stored copy is BBBB4's shape");
  assert.doesNotMatch(sql, /hold_expires_at|in_hold/,
    "the departure-level hold fields depend on LLL2.2 and LLL3.3, both open with the client");
  assert.match(sql, /payment_state IS NULL OR payment_state IN/,
    "state must be nullable with no default — a default asserts a position nobody recorded");
});
