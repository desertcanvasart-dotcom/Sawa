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

/**
 * The same rule applied to a single memoised value rather than a map of pages.
 *
 * The anonymous bootstrap payload is the most expensive thing a cold render
 * does — measured on the live site at 1774ms of a 3769ms render — and it was
 * memoised behind a hard 30-second TTL. On a site as quiet as this one that
 * meant almost every visitor arrived just after it had been thrown away and
 * paid to rebuild it, over and over, for a catalogue that had not changed.
 *
 * Serving stale is safe here for the same reason it is safe for pages: every
 * write calls invalidate(), which drops the value outright and reads as a miss.
 * The stale window only ever covers a stretch where nothing changed.
 *
 * Lives here, next to cacheState, so it can be tested without a database —
 * which is the whole reason this module was split out of app.js.
 */
export function staleWhileRevalidate({ ttl, staleTtl, build, onError, now = Date.now }) {
  let entry = null;      // { at, value }
  let inFlight = null;   // so a burst against a cold value rebuilds once, not N times

  const rebuild = () => {
    if (inFlight) return inFlight;
    // build() is called synchronously, not deferred behind a microtask: the
    // point of inFlight is that the SECOND caller in the same tick finds a
    // build already running, and a deferred start leaves a window where it
    // doesn't. A synchronous throw becomes a rejection like any other failure.
    let started;
    try { started = Promise.resolve(build()); } catch (e) { return Promise.reject(e); }
    inFlight = started
      .then((value) => { entry = { at: now(), value }; return value; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    get() {
      const state = cacheState(entry, now(), ttl, staleTtl);
      if (state === "fresh") return Promise.resolve(entry.value);
      if (state === "stale") {
        // Refresh behind the caller. A rejected refresh must not become an
        // unhandled rejection — the good value has already gone out.
        rebuild().catch((e) => onError?.(e));
        return Promise.resolve(entry.value);
      }
      return rebuild();
    },
    invalidate() { entry = null; },
    // For assertions and logging; never for serving.
    peek: () => entry,
  };
}
