import test from "node:test";
import assert from "node:assert/strict";
import { cacheState, staleWhileRevalidate, PAGE_TTL_MS, PAGE_STALE_TTL_MS } from "./page-cache.js";

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

// ---- staleWhileRevalidate -------------------------------------------------
// The bootstrap payload is the most expensive thing a cold render does. These
// pin the property that makes it cheap: after the first build, nobody waits.

// Lets any already-started background work settle. A macrotask rather than a
// counted number of microtask awaits, so these don't break when the number of
// .then() links in the chain changes.
const settle = () => new Promise((r) => setImmediate(r));

// A clock the test moves by hand, so none of this depends on real timers.
const harness = (opts = {}) => {
  let clock = 1_000_000;
  let builds = 0;
  let resolveNext;
  const errors = [];
  const cache = staleWhileRevalidate({
    ttl: 1000,
    staleTtl: 5000,
    now: () => clock,
    onError: (e) => errors.push(e),
    build: () => { builds++; return opts.manual ? new Promise((r) => { resolveNext = r; }) : `v${builds}`; },
    ...opts,
  });
  return { cache, tick: (ms) => { clock += ms; }, builds: () => builds, errors, release: (v) => resolveNext(v) };
};

test("the first caller waits for the build; the next one does not", async () => {
  const h = harness();
  assert.equal(await h.cache.get(), "v1");
  assert.equal(await h.cache.get(), "v1");
  assert.equal(h.builds(), 1);
});

test("a stale value is served immediately and refreshed behind the caller", async () => {
  const h = harness();
  await h.cache.get();
  h.tick(1500); // past ttl, inside staleTtl

  // The caller still gets the old value — that is the whole point, nobody waits.
  assert.equal(await h.cache.get(), "v1");
  await settle();
  assert.equal(h.builds(), 2, "the refresh should have been started behind the request");
  assert.equal(await h.cache.get(), "v2", "and the next caller gets the refreshed value");
});

test("past the stale window the caller waits again rather than being served something ancient", async () => {
  const h = harness();
  await h.cache.get();
  h.tick(6000);
  assert.equal(await h.cache.get(), "v2");
  assert.equal(h.builds(), 2);
});

test("a burst against a cold value builds once, not once per caller", async () => {
  const h = harness({ manual: true });
  const callers = [h.cache.get(), h.cache.get(), h.cache.get()];
  assert.equal(h.builds(), 1, "three concurrent callers must share one build");
  h.release("shared");
  assert.deepEqual(await Promise.all(callers), ["shared", "shared", "shared"]);
});

test("a failed background refresh is reported, not thrown at the visitor", async () => {
  let calls = 0;
  const h = harness({
    build: () => { calls++; return calls > 1 ? Promise.reject(new Error("db down")) : "good"; },
  });
  await h.cache.get();
  h.tick(1500);
  assert.equal(await h.cache.get(), "good", "the visitor still gets the good value");
  await settle();
  assert.equal(h.errors.length, 1, "and the failure is surfaced to the log, not swallowed");
  // The failed build must not have poisoned the entry.
  assert.equal(await h.cache.get(), "good");
});

test("a failed first build rejects, so the caller can fall back", async () => {
  let calls = 0;
  const h = harness({ build: () => { calls++; return Promise.reject(new Error("db down")); } });
  await assert.rejects(() => h.cache.get(), /db down/);
  // And it does not wedge: the next call tries again rather than reusing a
  // dead in-flight promise.
  await assert.rejects(() => h.cache.get(), /db down/);
  assert.equal(calls, 2, "each caller after a failure gets a fresh attempt");
});

test("a build that throws synchronously is a rejection, not a crash", async () => {
  const h = harness({ build: () => { throw new Error("bad config"); } });
  await assert.rejects(() => h.cache.get(), /bad config/);
  // And it left nothing wedged behind it.
  await assert.rejects(() => h.cache.get(), /bad config/);
});

test("invalidate makes the next caller wait for fresh data", async () => {
  // This is what every write does, and it is the reason serving stale is safe:
  // a stale value can only ever be data nothing has changed.
  const h = harness();
  await h.cache.get();
  h.cache.invalidate();
  assert.equal(h.cache.peek(), null);
  assert.equal(await h.cache.get(), "v2", "must rebuild rather than serve the pre-write value");
});
