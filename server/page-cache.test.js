import test from "node:test";
import assert from "node:assert/strict";
import { cacheState, PAGE_TTL_MS, PAGE_STALE_TTL_MS } from "./page-cache.js";

const at = (age) => ({ at: 1_000_000 - age });
const now = 1_000_000;

test("an empty cache makes the visitor wait", () => {
  assert.equal(cacheState(undefined, now), "miss");
  assert.equal(cacheState(null, now), "miss");
});

test("inside the TTL the page is served as it is", () => {
  assert.equal(cacheState(at(0), now), "fresh");
  assert.equal(cacheState(at(PAGE_TTL_MS - 1), now), "fresh");
});

test("past the TTL the page is still served, and refreshed behind the request", () => {
  // The change this file exists for: at 61 seconds the old behaviour made the
  // visitor wait about four seconds for a fresh render. It is one millisecond
  // older than fresh, not worthless.
  assert.equal(cacheState(at(PAGE_TTL_MS), now), "stale");
  assert.equal(cacheState(at(PAGE_STALE_TTL_MS - 1), now), "stale");
});

test("eventually it is too old to show at all", () => {
  assert.equal(cacheState(at(PAGE_STALE_TTL_MS), now), "miss");
  assert.equal(cacheState(at(PAGE_STALE_TTL_MS * 10), now), "miss");
});

test("an entry stamped in the future is rebuilt rather than trusted forever", () => {
  assert.equal(cacheState({ at: now + 60_000 }, now), "stale");
});

test("the windows are ordered, so no age falls through them", () => {
  let seen = [];
  for (let age = 0; age < PAGE_STALE_TTL_MS + 2000; age += 977) seen.push(cacheState(at(age), now));
  // fresh, then stale, then miss — each state contiguous, never interleaved.
  const collapsed = seen.filter((s, i) => s !== seen[i - 1]);
  assert.deepEqual(collapsed, ["fresh", "stale", "miss"]);
});
