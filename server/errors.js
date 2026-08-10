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

// For a promise nobody awaits — a fire-and-forget email, a mirror emit.
//
// An operational failure is recorded and swallowed, which is what
// fire-and-forget is for. A programmer error is recorded and RETHROWN, which
// becomes an unhandled rejection, which Node treats as fatal.
//
// That is deliberate and it has a cost worth stating plainly: a typo in an email
// template now takes the process down rather than being absorbed silently
// thirteen times a day. Railway restarts on failure and gives up after ten
// attempts, so the service goes down loudly instead of appearing to work while
// doing nothing.
//
// The alternative is what produced the current state: absorbing it, and finding
// out years later by running the feature by hand.
export function fireAndForget(kind, promise, { record } = {}) {
  return Promise.resolve(promise).catch((e) => {
    record?.(kind, e.message);
    if (isProgrammerError(e)) {
      console.error(
        `[${kind}] PROGRAMMER ERROR — ${e.name}: ${e.message}\n`
        + "This is not a transient failure. The code is wrong and this feature "
        + "cannot work until it is changed. Rethrowing rather than absorbing it, "
        + "because absorbing exactly this is how the Autoura mirror ran for years "
        + "without ever transmitting anything."
      );
      throw e;
    }
  });
}
