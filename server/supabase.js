import "dotenv/config";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { addAuth } from "./request-timing.js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env");
}

// Anon client — used to validate user access tokens.
export const supabaseAnon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Service-role client — used by admin operations (creating users, invites).
// Only ever used server-side. NEVER expose the service key to the browser.
export const supabaseAdmin = serviceKey
  ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Validate a user access token and return the Supabase auth user (or null).
//
// Supabase checks the token over the network, and every signed-in API
// request asked it again: an admin action and the dashboard reload after it
// made six such calls (28 Sep 2026: "the whole app responds late"). A token
// Supabase has confirmed is now remembered for AUTH_CACHE_SECONDS (default
// 60; 0 turns it off), never past the token's own expiry. What this changes:
// a token revoked by signing out elsewhere keeps working for at most that
// long. What it doesn't: the account itself (role, agency, active or
// disabled) is still read from the database on every request (auth.js), so a
// disabled account is refused at once.
const cache = new Map();
const MAX_ENTRIES = 5000;
const tokenKey = (t) => createHash("sha256").update(t).digest("base64url");
const tokenExpiryMs = (t) => {
  try {
    const exp = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
};
export const authCacheMs = (env = process.env) => Math.max(0, Number(env.AUTH_CACHE_SECONDS ?? 60)) * 1000;

export async function getAuthUser(accessToken, { now = Date.now(), fetchUser = (t) => supabaseAnon.auth.getUser(t) } = {}) {
  if (!accessToken) return null;
  const t0 = performance.now();
  const ttl = authCacheMs();
  const key = ttl ? tokenKey(accessToken) : null;
  const hit = key ? cache.get(key) : null;
  if (hit && hit.until > now) { addAuth(performance.now() - t0, true); return hit.user; }
  if (hit) cache.delete(key);
  const { data, error } = await fetchUser(accessToken);
  addAuth(performance.now() - t0, false);
  if (error || !data?.user) return null;
  if (key) {
    const exp = tokenExpiryMs(accessToken);
    const until = Math.min(now + ttl, exp ?? now + ttl);
    if (until > now) {
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { user: data.user, until });
    }
  }
  return data.user;
}

export const clearAuthCache = () => cache.clear();
