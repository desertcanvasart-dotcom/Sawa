// Whether the in-process scheduler runs at all. Pure — no DB, no timers.
//
// This guard matters more than it looks: migrations and dry runs in this
// project are done by pointing a LOCAL process at the production database
// (`railway run node ...`). Without it, anyone starting the API that way would
// silently cancel live departures from their laptop a minute later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobSchedulerEnabled, cancelJobDryRun } from "./scheduler.js";

test("runs in production", () => {
  assert.equal(jobSchedulerEnabled({ NODE_ENV: "production" }), true);
});
test("stays off everywhere else by default", () => {
  assert.equal(jobSchedulerEnabled({}), false);
  assert.equal(jobSchedulerEnabled({ NODE_ENV: "development" }), false);
  assert.equal(jobSchedulerEnabled({ NODE_ENV: "test" }), false);
  // The dangerous case: a local server holding production credentials.
  assert.equal(jobSchedulerEnabled({ DATABASE_URL: "postgres://prod" }), false);
});
test("can be turned on deliberately outside production", () => {
  assert.equal(jobSchedulerEnabled({ ENABLE_JOB_SCHEDULER: "1" }), true);
});
test("the kill switch beats everything, including production", () => {
  // The lever to pull if the job ever misbehaves against live data, without
  // needing a code change or a rollback.
  assert.equal(jobSchedulerEnabled({ NODE_ENV: "production", DISABLE_JOB_SCHEDULER: "1" }), false);
  assert.equal(jobSchedulerEnabled({ ENABLE_JOB_SCHEDULER: "1", DISABLE_JOB_SCHEDULER: "1" }), false);
});

// BB3 — the scheduled tick is dry by default.
//
// Production is confirmed running this job (`scheduler: on`) with live email
// (`email: live`), and it is the only path that mails a traveller with no human
// action. The failure modes are not symmetric: a dry run that should have been
// live leaves stale departures on the board, visible and fixable; a live run
// that should have been dry sends mail that cannot be recalled.
test("the scheduled cancel job is DRY unless explicitly set live", () => {
  assert.equal(cancelJobDryRun({}), true, "unset means dry");
  assert.equal(cancelJobDryRun({ CANCEL_JOB_DRY_RUN: "1" }), true);
  assert.equal(cancelJobDryRun({ CANCEL_JOB_DRY_RUN: "" }), true);
  assert.equal(cancelJobDryRun({ CANCEL_JOB_DRY_RUN: "false" }), true, "only an exact 0 goes live");
  assert.equal(cancelJobDryRun({ CANCEL_JOB_DRY_RUN: "true" }), true);
  assert.equal(cancelJobDryRun({ NODE_ENV: "production" }), true, "production is not an opt-in to live");
});

test("going live requires the exact opt-in", () => {
  assert.equal(cancelJobDryRun({ CANCEL_JOB_DRY_RUN: "0" }), false);
});
