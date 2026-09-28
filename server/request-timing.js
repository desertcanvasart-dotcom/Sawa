// Where a request's time goes (28 Sep 2026: "the whole app responds late").
//
// Every API request is timed in three parts: the Supabase sign-in check, the
// database (queries, and time spent waiting for a free connection), and the
// rest. The browser sees them in a Server-Timing header (DevTools → Network →
// Timing); a request slower than REQUEST_SLOW_MS (default 1000) is logged:
//
//   [slow] GET /api/bootstrap 1840ms · auth 420ms · db 9 queries 1210ms summed (wait 0ms) · 200
//
// "summed": queries that run in parallel add up, so db can exceed the total.
//
// Nothing is stored; it costs a few counters per request.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();
export const current = () => store.getStore() || null;

export function addDb(ms) { const s = current(); if (s) { s.dbCount += 1; s.dbMs += ms; } }
export function addWait(ms) { const s = current(); if (s) s.waitMs += ms; }
export function addAuth(ms, cached) { const s = current(); if (s) { s.authMs += ms; s.authCached = cached; } }

const round = (n) => Math.round(n);

export function requestTiming({ slowMs = Number(process.env.REQUEST_SLOW_MS || 1000), log = console.log } = {}) {
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const s = { start: performance.now(), dbCount: 0, dbMs: 0, waitMs: 0, authMs: 0, authCached: null };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const total = performance.now() - s.start;
      if (!res.headersSent) {
        res.setHeader("Server-Timing", [
          `auth;dur=${round(s.authMs)}${s.authCached ? ";desc=\"cached\"" : ""}`,
          `db;dur=${round(s.dbMs)};desc="${s.dbCount} queries, summed"`,
          `dbwait;dur=${round(s.waitMs)}`,
          `total;dur=${round(total)}`,
        ].join(", "));
      }
      return writeHead.apply(this, args);
    };
    res.on("finish", () => {
      const total = performance.now() - s.start;
      if (total >= slowMs) {
        log(`[slow] ${req.method} ${req.originalUrl.split("?")[0]} ${round(total)}ms · auth ${round(s.authMs)}ms${s.authCached ? " (cached)" : ""} · db ${s.dbCount} queries ${round(s.dbMs)}ms summed (wait ${round(s.waitMs)}ms) · ${res.statusCode}`);
      }
    });
    store.run(s, next);
  };
}
