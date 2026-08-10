// ZZ1.4 / ZZ2.1 — has this ever actually worked?
//
// The mirror was configured for the whole life of the feature and never once
// transmitted: `emitDepartureSync` called a function that does not exist, and
// the `.catch()` turned every ReferenceError into a `console.warn`. `/api/modes`
// reported `autoura: on`, which was true and useless — it answers "is this
// switched on", and it was read, by me and in the legal register, as "this is
// working".
//
// Two rules come out of that, and this module is both of them.
//
//   A non-fatal failure is not a silent one. It is still recorded and counted.
//   A mode reports EFFECT where effect and configuration can diverge.
//
// Deliberately in-memory and per-process. A durable store would be a better
// answer and a bigger change; what this has to beat is `console.warn`, and
// "last success: never, 14 failures" beats it from the first minute. Restarting
// clears the counters, which is why `succeeded` is a TIMESTAMP rather than a
// boolean: "never since boot" and "not for three days" are different claims.
const effects = new Map();

function entry(kind) {
  if (!effects.has(kind)) {
    effects.set(kind, {
      succeeded: null, failed: null, successes: 0, failures: 0, lastError: null,
      // CCC2.2 — "the code is wrong" and "the remote is flaky" call for
      // different people on different days, and a single counter cannot say
      // which is happening.
      programmerErrors: 0, lastProgrammerError: null,
    });
  }
  return effects.get(kind);
}

export function recordSuccess(kind) {
  const e = entry(kind);
  e.succeeded = new Date().toISOString();
  e.successes += 1;
}

// `why` is required. A recorded failure with no reason is the console.warn this
// exists to replace, one indirection further away.
export function recordFailure(kind, why) {
  const e = entry(kind);
  e.failed = new Date().toISOString();
  e.failures += 1;
  e.lastError = String(why || "unknown").slice(0, 300);
  console.error(`[${kind}] FAILED — ${e.lastError} (${e.failures} since boot, last success: ${e.succeeded || "never"})`);
}

// CCC2.2 — a failure that is this repository's fault.
//
// Counted SEPARATELY so the two questions stay apart: "is this feature
// working" and "is this feature's code correct". A run of failures against a
// flaky partner is an operations problem that may clear on its own; a run of
// ReferenceErrors is a build that cannot work until someone edits a file, and
// no amount of waiting helps.
//
// It also increments `failures`, deliberately. `neverWorked` must stay true for
// a feature whose ONLY failures are programmer errors — that is precisely the
// state the mirror was in, and excluding these from the count would hide it
// again one level down.
export function recordProgrammerError(kind, why) {
  const e = entry(kind);
  e.programmerErrors += 1;
  e.lastProgrammerError = String(why || "unknown").slice(0, 300);
  recordFailure(kind, why);
}

// What /api/modes reports. `succeeded: null` with `failures > 0` is the state
// that was invisible for the mirror's entire life.
export function effectReport() {
  const out = {};
  for (const [kind, e] of effects) {
    out[kind] = {
      lastSuccess: e.succeeded,
      lastFailure: e.failed,
      successes: e.successes,
      failures: e.failures,
      // The headline. Configured, tried, and never once worked.
      neverWorked: e.successes === 0 && e.failures > 0,
      // The second headline. Waiting will not fix this one.
      programmerErrors: e.programmerErrors,
      codeIsWrong: e.programmerErrors > 0,
      lastProgrammerError: e.lastProgrammerError,
      lastError: e.lastError,
    };
  }
  return out;
}

// Test seam. Never called in production — a count that production can clear is
// a count that means nothing.
export function __resetEffects() {
  effects.clear();
}
