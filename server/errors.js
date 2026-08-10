// AAA2 — programmer errors escape every handler not written for them.
//
// What killed the Autoura mirror was not a send failing. It was a
// `ReferenceError` — `emitDepartureSync` called a function that has never
// existed — caught by a handler written for network failures. The handler could
// not tell the two apart, so it treated a permanently broken feature as a
// transient hiccup, on every departure write, for the life of the feature.
//
// The categories differ in kind, not in degree:
//
//   OPERATIONAL   expected, transient, and continuing is correct.
//                 A timeout, a remote 5xx, a refused connection.
//
//   PROGRAMMER    the code is wrong. Continuing is NEVER correct, because the
//                 feature cannot work until someone changes the code, and every
//                 retry is the same failure again.
//
// A handler written for the first will silence the second, and the second is
// exactly the kind that never fixes itself.
//
// This is the general form of the fix rather than the thirteen edits: it would
// have surfaced the mirror on the day it was written, and it applies to every
// handler written after today.

import { recordFailure, recordProgrammerError } from "./effect-log.js";

// Node throws these when the code is wrong, not when the world is.
//
// RangeError is deliberately NOT here: `new Date(...)` and friends throw it on
// bad INPUT, which is an operational condition in a system that stores dates as
// free text.
const PROGRAMMER_ERRORS = [ReferenceError, TypeError, SyntaxError];

export function isProgrammerError(e) {
  return PROGRAMMER_ERRORS.some((Kind) => e instanceof Kind);
}

// Use inside a catch that was written for operational failure:
//
//   } catch (e) {
//     rethrowIfProgrammerError(e);
//     console.warn("upstream unavailable:", e.message);
//   }
//
// The mirror's handler, with this line in it, would have thrown on the first
// call in the first deploy.
export function rethrowIfProgrammerError(e) {
  if (isProgrammerError(e)) throw e;
}

// For a promise nobody awaits — a fire-and-forget email, a mirror emit, a page
// warm on a timer.
//
// CCC2.2 — SEVERITY IS A DECISION PER CALL SITE, NOT A PROPERTY OF THIS HELPER.
//
// The first version rethrew every programmer error, which becomes an unhandled
// rejection, which Node treats as fatal. That was one severity applied to every
// caller because it was what the shared helper happened to do — and it was
// wrong for most of them:
//
//   The request has ALREADY COMPLETED. A fire-and-forget email rejects after
//   res.json() has gone out. There is no inconsistent state to protect by
//   dying, and the client has already been told the booking succeeded.
//
//   The blast radius is unrelated to the fault. A typo in one email template
//   stopped the site serving pages that have nothing to do with email. The
//   page warmer was worse: a caching optimisation could kill the web server.
//
//   Railway gives up after ten restarts, so a cosmetic template bug could take
//   the site down until a human noticed.
//
// The mirror was bad because it was INVISIBLE, not because it was survivable.
// effect-log.js is what fixes invisibility — console.error, a counter, a
// separate `programmerErrors` count and `codeIsWrong` in /api/modes. Dying adds
// nothing to that; it only adds damage.
//
// So `onProgrammerError` is REQUIRED and has no default. A default is exactly
// how the wrong severity shipped last time.
//
//   "surface"   record it, count it separately, log it loudly, keep serving.
//               Correct for anything reached from a request handler or a timer
//               inside the web process.
//
//   "crash"     record it and rethrow, so an unattended job or a CLI stops
//               rather than reporting a run it did not do. DECLARED AND
//               CURRENTLY UNWRITTEN — no site needs it today. It exists so the
//               choice is visible at both kinds of call site rather than
//               implied by which one the helper was written for.
// Recording is no longer an injectable option. It was `{ record }`, optional,
// which meant a call site that forgot it recorded nothing at all — a silent
// hole in the very helper written to close silent holes. Tests assert through
// effectReport() instead of a stub, which is the more honest check anyway.
const MODES = new Set(["surface", "crash"]);

export function fireAndForget(kind, promise, { onProgrammerError } = {}) {
  if (!MODES.has(onProgrammerError)) {
    // Thrown at the call site, synchronously, rather than defaulted. An
    // unstated severity is the defect this parameter exists to prevent.
    throw new Error(
      `fireAndForget("${kind}") needs onProgrammerError: "surface" | "crash" — got ${JSON.stringify(onProgrammerError)}`
    );
  }
  return Promise.resolve(promise).catch((e) => {
    if (!isProgrammerError(e)) {
      recordFailure(kind, e.message);
      return;
    }
    recordProgrammerError(kind, e.message);
    console.error(
      `[${kind}] PROGRAMMER ERROR — ${e.name}: ${e.message}\n`
      + "This is not a transient failure. The code is wrong and this feature "
      + "cannot work until it is changed. It is counted separately from "
      + "operational failures; see codeIsWrong in /api/modes.\n"
      + (e.stack || "")
    );
    if (onProgrammerError === "crash") throw e;
  });
}

// CCC2.2 — the same decision for a handler that is not fire-and-forget: a
// `catch` in a timer callback, or anywhere the alternative would be an
// unhandled rejection. Records, counts, logs, and CONTINUES.
//
// Distinct from rethrowIfProgrammerError, which is right when something is
// awaiting: there the throw reaches a request's error handler and becomes one
// 500, which is a proportionate blast radius. Nothing awaits a timer.
export function surfaceProgrammerError(kind, e) {
  if (!isProgrammerError(e)) return false;
  recordProgrammerError(kind, `${e.name}: ${e.message}`);
  console.error(`[${kind}] PROGRAMMER ERROR — ${e.name}: ${e.message}\n${e.stack || ""}`);
  return true;
}
