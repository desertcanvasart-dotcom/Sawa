// AAA1.3 — an observable result for a browser failure that genuinely repeats.
//
// The ban on empty handlers has one honest objection, and it only arises in
// browser code: a few failures here are expected, unfixable, AND continuous.
// `postMessage` to a parent frame runs on every resize; a blocked localStorage
// throws on every attempt for the whole of a private-mode session. Logging each
// occurrence buries the console, and a console nobody can read is how the next
// person justifies deleting the logging altogether.
//
// So it is said the first time and not again. That is still an observable
// difference between a run in which the failure happened and one in which it
// did not, which is the entire requirement. `catch (e) { /* ignore */ }` is not:
// the two runs are identical, and the second is what shipped.
//
// Deliberately per page load, and deliberately not persisted. The question this
// answers is "is this happening to this visitor, now" — the same reason
// effect-log.js on the server is per process rather than durable.
const said = new Set();

export function warnOnce(key, ...args) {
  if (said.has(key)) return false;
  said.add(key);
  console.warn(...args);
  return true;
}

// Test seam. Not called by the application — a record the application can clear
// is a record that means nothing.
export function __resetWarnOnce() {
  said.clear();
}
