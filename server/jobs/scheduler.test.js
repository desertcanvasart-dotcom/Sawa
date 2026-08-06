// Whether the in-process scheduler runs at all. Pure — no DB, no timers.
//
// This guard matters more than it looks: migrations and dry runs in this
// project are done by pointing a LOCAL process at the production database
// (`railway run node ...`). Without it, anyone starting the API that way would
// silently cancel live departures from their laptop a minute later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobSchedulerEnabled } from "./scheduler.js";

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
