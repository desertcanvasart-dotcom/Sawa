// The sign-in check is remembered briefly (28 Sep 2026: every signed-in API
// request asked Supabase over the network). Proved both ways: a confirmed
// token is not asked again within the window; it is asked again after the
// window or the token's own expiry; a refused token is never remembered; the
// cache can be turned off. And the request timing header.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.SUPABASE_ANON_KEY ||= "x";
const { getAuthUser, clearAuthCache } = await import("./supabase.js");
const { requestTiming, addDb, addAuth } = await import("./request-timing.js");

const jwt = (expSec) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url")}.s`;
const counting = (user = { id: "u1" }) => {
  const f = async () => { f.calls += 1; return user ? { data: { user }, error: null } : { data: null, error: new Error("bad") }; };
  f.calls = 0;
  return f;
};

test("a confirmed token is asked once within the window, again after it", async () => {
  clearAuthCache();
  const now = Date.now();
  const token = jwt(Math.floor(now / 1000) + 3600);
  const fetchUser = counting();
  assert.equal((await getAuthUser(token, { now, fetchUser })).id, "u1");
  assert.equal((await getAuthUser(token, { now: now + 30_000, fetchUser })).id, "u1");
  assert.equal(fetchUser.calls, 1, "remembered for 60 seconds");
  await getAuthUser(token, { now: now + 61_000, fetchUser });
  assert.equal(fetchUser.calls, 2, "asked again after the window");
});

test("never remembered past the token's own expiry; a refused token is never remembered", async () => {
  clearAuthCache();
  const now = Date.now();
  const soon = jwt(Math.floor(now / 1000) + 10);
  const fetchUser = counting();
  await getAuthUser(soon, { now, fetchUser });
  await getAuthUser(soon, { now: now + 11_000, fetchUser });
  assert.equal(fetchUser.calls, 2);
  const refused = counting(null);
  const bad = jwt(Math.floor(now / 1000) + 3600);
  assert.equal(await getAuthUser(bad, { now, fetchUser: refused }), null);
  assert.equal(await getAuthUser(bad, { now, fetchUser: refused }), null);
  assert.equal(refused.calls, 2);
});

test("AUTH_CACHE_SECONDS=0 turns the cache off", async () => {
  clearAuthCache();
  process.env.AUTH_CACHE_SECONDS = "0";
  try {
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    const fetchUser = counting();
    await getAuthUser(token, { fetchUser });
    await getAuthUser(token, { fetchUser });
    assert.equal(fetchUser.calls, 2);
  } finally {
    delete process.env.AUTH_CACHE_SECONDS;
  }
});

test("an API request carries Server-Timing, and a slow one is logged with its parts", async () => {
  const logged = [];
  const mw = requestTiming({ slowMs: 0, log: (l) => logged.push(l) });
  const headers = {};
  const listeners = {};
  const res = {
    headersSent: false, statusCode: 200,
    setHeader: (k, v) => { headers[k] = v; },
    writeHead() { return this; },
    on: (ev, fn) => { listeners[ev] = fn; },
  };
  await new Promise((resolve) => mw({ path: "/api/x", method: "GET", originalUrl: "/api/x?y=1" }, res, () => {
    addAuth(12, false); addDb(30); addDb(5);
    resolve();
  }));
  res.writeHead(200);
  listeners.finish();
  assert.match(headers["Server-Timing"], /auth;dur=12, db;dur=35;desc="2 queries, summed", dbwait;dur=0, total;dur=\d+/);
  assert.match(logged[0], /^\[slow\] GET \/api\/x \d+ms · auth 12ms · db 2 queries 35ms summed \(wait 0ms\) · 200$/);
  // Not an API request: untouched.
  let called = false;
  mw({ path: "/tour/x" }, res, () => { called = true; });
  assert.ok(called);
});
