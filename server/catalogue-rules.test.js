// The catalogue's calendar and status rules (shared/catalogue.js), with no
// database: every function takes its clock and its dates as arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  datesForRule, plannedDates, nextStatus, canRunBelowMinimum, publicDateLabel, publiclyListed,
  specGaps, publishBlockers, activeSpec, windowDaysFor, weekdayOf, shiftDate,
} from "../shared/catalogue.js";

const HOUR = 3600000;

test("a weekday rule yields exactly those weekdays inside its window", () => {
  const rule = { kind: "weekdays", weekdays: [1, 3, 5], activeFrom: "2026-10-01" };
  const dates = datesForRule(rule, "2026-09-27", "2026-10-11");
  assert.deepEqual(dates, ["2026-10-02", "2026-10-05", "2026-10-07", "2026-10-09"]);
  assert.ok(dates.every((d) => [1, 3, 5].includes(weekdayOf(d))));
});

test("active-to ends a rule, inclusive", () => {
  const rule = { kind: "weekdays", weekdays: [0, 1, 2, 3, 4, 5, 6], activeFrom: "2026-10-01", activeTo: "2026-10-03" };
  assert.deepEqual(datesForRule(rule, "2026-09-01", "2026-12-31"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
});

test("a fortnightly rule counts whole weeks from its anchor", () => {
  const rule = { kind: "weekdays", weekdays: [5], intervalWeeks: 2, anchorDate: "2026-11-13", activeFrom: "2026-10-01" };
  const dates = datesForRule(rule, "2026-10-01", "2026-12-31");
  assert.deepEqual(dates, ["2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11", "2026-12-25"]);
});

test("an explicit-dates rule (ship sailing days) returns its dates in range, sorted and de-duplicated", () => {
  const rule = { kind: "dates", dates: ["2026-12-01", "2026-10-20", "2026-10-20", "2027-06-01", "not-a-date"], activeFrom: "2026-10-01" };
  assert.deepEqual(datesForRule(rule, "2026-09-27", "2027-01-31"), ["2026-10-20", "2026-12-01"]);
});

test("held and retired products plan no departures; windows are 90 and 365 days", () => {
  const rules = [{ kind: "weekdays", weekdays: [0, 1, 2, 3, 4, 5, 6], activeFrom: "2026-01-01" }];
  assert.equal(plannedDates({ status: "held", type: "day_tour" }, rules, "2026-09-27").length, 0);
  assert.equal(plannedDates({ status: "retired", type: "day_tour" }, rules, "2026-09-27").length, 0);
  assert.equal(plannedDates({ status: "active", type: "day_tour" }, rules, "2026-09-27").length, 91);
  assert.equal(windowDaysFor("cruise"), 365);
  assert.equal(windowDaysFor("multi_day"), 365);
  assert.equal(windowDaysFor("one_way_road_tour"), 90);
  const last = plannedDates({ status: "active", type: "multi_day" }, rules, "2026-09-27").pop();
  assert.equal(last, shiftDate("2026-09-27", 365));
});

// ---------------------------------------------------------------- statuses
const t0 = Date.parse("2026-10-10T06:00:00Z");   // departure start
const dayTour = (over = {}) => ({
  status: "open", seatsSold: 2, goaheadMin: 4, type: "day_tour", origin: "generated",
  startsAt: t0, cutoffAt: t0 - 48 * HOUR, deadlineAt: NaN, endsAt: t0 + 18 * HOUR, ...over,
});

test("a day tour below the minimum is cancelled at the cut-off, not before", () => {
  assert.equal(nextStatus(dayTour(), t0 - 49 * HOUR).status, "open");
  const at = nextStatus(dayTour(), t0 - 48 * HOUR);
  assert.deepEqual(at, { status: "cancelled_below_minimum", reason: "cutoff" });
});

test("a one-way road tour follows the cut-off rule too", () => {
  assert.equal(nextStatus(dayTour({ type: "one_way_road_tour" }), t0 - 47 * HOUR).status, "cancelled_below_minimum");
});

test("reaching the minimum means GoAhead, and GoAhead is sticky", () => {
  assert.deepEqual(nextStatus(dayTour({ seatsSold: 4 }), t0 - 100 * HOUR), { status: "go_ahead", reason: "minimum_reached" });
  // Cancellations after the GoAhead take it below the minimum: it still runs.
  assert.equal(nextStatus(dayTour({ status: "go_ahead", seatsSold: 1 }), t0 - 1 * HOUR).status, "go_ahead");
  assert.equal(nextStatus(dayTour({ status: "go_ahead", seatsSold: 1 }), t0 + 19 * HOUR).status, "completed");
});

test("cruises and multi-day decide at the GoAhead deadline, not the cut-off", () => {
  const cruise = dayTour({ type: "cruise", deadlineAt: t0 - 30 * 24 * HOUR });
  assert.equal(nextStatus(cruise, t0 - 31 * 24 * HOUR).status, "open");
  assert.deepEqual(nextStatus(cruise, t0 - 30 * 24 * HOUR), { status: "cancelled_below_minimum", reason: "deadline" });
  // Past the deadline but with the minimum reached: it goes ahead.
  assert.equal(nextStatus({ ...cruise, seatsSold: 4 }, t0 - 29 * 24 * HOUR).status, "go_ahead");
  assert.equal(nextStatus(dayTour({ type: "multi_day", deadlineAt: t0 - 30 * 24 * HOUR }), t0 - 30 * 24 * HOUR).status, "cancelled_below_minimum");
});

test("the admin override runs a departure below its minimum instead of cancelling it", () => {
  assert.deepEqual(nextStatus(dayTour({ runBelowMinimum: true }), t0 - 47 * HOUR), { status: "go_ahead", reason: "admin_override" });
  assert.equal(canRunBelowMinimum(dayTour(), t0 - 50 * HOUR), true);
  assert.equal(canRunBelowMinimum(dayTour({ status: "cancelled_below_minimum" }), t0 - 10 * HOUR), true);
  assert.equal(canRunBelowMinimum(dayTour({ status: "go_ahead" }), t0 - 50 * HOUR), false, "already going ahead");
  assert.equal(canRunBelowMinimum(dayTour(), t0 + 1), false, "already started");
});

test("an adopted departure keeps the old rules: never cancelled here", () => {
  assert.equal(nextStatus(dayTour({ origin: "adopted" }), t0 - 1 * HOUR).status, "open");
  assert.equal(nextStatus(dayTour({ origin: "adopted", seatsSold: 5 }), t0 - 1 * HOUR).status, "go_ahead");
});

test("terminal statuses stay put", () => {
  for (const status of ["cancelled_below_minimum", "completed"]) {
    assert.equal(nextStatus(dayTour({ status, seatsSold: 9 }), t0 + 99 * HOUR).status, status);
  }
});

test("the date picker says 'X of 4 needed' or 'Going ahead', and hides past the cut-off", () => {
  assert.equal(publicDateLabel({ status: "open", seatsSold: 0, goaheadMin: 4 }), "4 of 4 needed");
  assert.equal(publicDateLabel({ status: "open", seatsSold: 3, goaheadMin: 4 }), "1 of 4 needed");
  assert.equal(publicDateLabel({ status: "go_ahead", seatsSold: 2, goaheadMin: 4 }), "Going ahead");
  assert.equal(publiclyListed({ status: "open", cutoffAt: t0 - 48 * HOUR }, t0 - 49 * HOUR), true);
  assert.equal(publiclyListed({ status: "open", cutoffAt: t0 - 48 * HOUR }, t0 - 48 * HOUR), false);
  assert.equal(publiclyListed({ status: "cancelled_below_minimum", cutoffAt: t0 }, 0), false);
});

// ---------------------------------------------------------------- specs
test("an empty specification is 'to complete' in every field; rooms only for cruises and multi-day", () => {
  const dayGaps = specGaps({}, "day_tour");
  assert.ok(dayGaps.includes("inclusions") && dayGaps.includes("guideLanguages") && dayGaps.includes("addons"));
  assert.ok(!dayGaps.includes("roomCategories"));
  assert.ok(specGaps({}, "cruise").includes("roomCategories"));
  // "No add-ons" is an answer, and so is a filled band.
  const gaps = specGaps({ addons: [], noAddons: true, vehicleByBand: { "4-6": "Van", "7-9": null } }, "day_tour");
  assert.ok(!gaps.includes("addons") && !gaps.includes("vehicleByBand"));
});

test("a spec can't be published without inclusions and exclusions", () => {
  assert.deepEqual(publishBlockers({}), ["inclusions", "exclusions"]);
  assert.deepEqual(publishBlockers({ inclusions: ["Guide"], exclusions: ["  "] }), ["exclusions"]);
  assert.deepEqual(publishBlockers({ inclusions: ["Guide"], exclusions: ["Tips"] }), []);
});

test("the active version is the latest published one already in effect", () => {
  const v = (version, state, effectiveFrom) => ({ version, state, effectiveFrom });
  const versions = [v(1, "published", "2026-09-01"), v(2, "published", "2026-11-01"), v(3, "draft", null)];
  assert.equal(activeSpec(versions, "2026-10-15").version, 1);
  assert.equal(activeSpec(versions, "2026-11-01").version, 2);
  assert.equal(activeSpec([v(1, "draft", null)], "2026-10-15"), null);
});
