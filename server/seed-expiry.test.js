// EEEE3.1 — the four claims the seed ends, proved both ways.
//
// One INSERT into `pledges` ends four separate claims at the same instant,
// silently. E-2 already said "when the seed happens, all four need revisiting
// in the same commit" — a promise kept by memory, which is what this project
// replaces.
import test from "node:test";
import assert from "node:assert/strict";
import { verdict, auditRestatements, RESTS_ON_E2, RESTATED } from "../scripts/check-seed-expiry.js";

const stale = RESTS_ON_E2.map((e) => ({ ...e, state: "stale", on: null }));
const restated = (on = "2026-09-01") => RESTS_ON_E2.map((e) => ({ ...e, state: "restated", on }));

test("it stops — while `pledges` is empty, the four claims stand", () => {
  const v = verdict({ pledgeCount: 0, restatements: stale });
  assert.equal(v.state, "still-true");
  assert.equal(v.pass, true);
});

test("it fires — one row ends E-2, and unrestated claims are named", () => {
  const v = verdict({ pledgeCount: 1, restatements: stale });
  assert.equal(v.state, "ENDED");
  assert.equal(v.pass, false);
  for (const e of RESTS_ON_E2) assert.match(v.line, new RegExp(e.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `${e.file} is not named in the failure`);
  assert.match(v.line, /1 row\(s\)/);
});

test("it clears once all four are restated with one date", () => {
  const v = verdict({ pledgeCount: 12, restatements: restated() });
  assert.equal(v.pass, true);
  assert.match(v.line, /bounded 2026-09-01/);
});

test("four different dates is a failure — one INSERT ended them at one instant", () => {
  const mixed = restated();
  mixed[2] = { ...mixed[2], on: "2026-09-04" };
  const v = verdict({ pledgeCount: 12, restatements: mixed });
  assert.equal(v.pass, false);
  assert.match(v.line, /different dates/);
});

test("restating before the seed is its own failure", () => {
  // A claim marked historical while the thing it describes is still true is not
  // a smaller error than the reverse — it is a false record of when something
  // changed, which is harder to notice later.
  const v = verdict({ pledgeCount: 0, restatements: restated() });
  assert.equal(v.state, "premature");
  assert.equal(v.pass, false);
});

test("no credentials is NOT a pass for the claims, and says so", () => {
  const v = verdict({ pledgeCount: null, restatements: stale });
  assert.equal(v.state, "not-checked");
  assert.match(v.line, /NOT a pass/);
});

test("the four dependents are the four E-2 names, and each is findable today", () => {
  assert.equal(RESTS_ON_E2.length, 4);
  const found = auditRestatements();
  const unreadable = found.filter((f) => f.state === "unreadable").map((f) => f.file);
  assert.deepEqual(unreadable, [], "a dependent names a file that is not there");
  // Every `stale` pattern must currently MATCH — otherwise the check is
  // watching for a sentence that has already been reworded, and would report
  // "restated" the day the seed lands without anyone having restated anything.
  const notMatching = found.filter((f) => f.state !== "stale").map((f) => f.file);
  assert.deepEqual(notMatching, [],
    "a dependent's stale-pattern no longer matches its file — the watch is pointed at nothing");
});

test("the restatement marker requires a date, not a word", () => {
  assert.ok(RESTATED.test("E-2 ENDED 2026-09-01"));
  assert.ok(!RESTATED.test("E-2 ENDED"), "‘restated’ must not be claimable by editing a word");
  assert.ok(!RESTATED.test("E-2 ended soon"));
});
