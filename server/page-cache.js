// When a rendered page may be reused, and when a visitor must wait for a new one.
//
// Split out of app.js so it can be tested without a database. The rule it
// encodes is the whole point of the change: a page that is merely old is still
// a good page, and making someone wait ~4s for the fresh one — which is what a
// cold render against Postgres costs — is worse than showing them the old one
// and refreshing behind them.

export const PAGE_TTL_MS = 60 * 1000;
export const PAGE_STALE_TTL_MS = 5 * 60 * 1000;

/**
 * "fresh"  serve as-is
 * "stale"  serve as-is AND rebuild in the background
 * "miss"   nothing usable; the caller has to wait for a build
 */
export function cacheState(entry, now = Date.now(), ttl = PAGE_TTL_MS, staleTtl = PAGE_STALE_TTL_MS) {
  if (!entry) return "miss";
  const age = now - entry.at;
  // A clock that jumps backwards would otherwise make an entry look
  // indefinitely fresh; treat anything from the future as due a rebuild.
  if (age < 0) return "stale";
  if (age < ttl) return "fresh";
  if (age < staleTtl) return "stale";
  return "miss";
}
