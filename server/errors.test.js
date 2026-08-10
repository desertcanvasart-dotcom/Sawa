// AAA2 — a programmer error must escape a handler written for the world being
// slow, because the two call for opposite responses.
//
// The finding this exists for, stated once: `emitDepartureSync` called
// `loadEnriched`, which has never existed. The resulting ReferenceError was
// caught by a handler written for a network failure, recorded as "emit failed",
// and retried. Every departure write, for the life of the feature, produced an
// identical failure that looked transient and was not. The mirror never
// transmitted anything and nothing said so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProgrammerError, rethrowIfProgrammerError, fireAndForget, surfaceProgrammerError } from "./errors.js";
import { effectReport, __resetEffects } from "./effect-log.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the three kinds Node throws when the code is wrong", () => {
  assert.equal(isProgrammerError(new ReferenceError("loadEnriched is not defined")), true);
  assert.equal(isProgrammerError(new TypeError("x.map is not a function")), true);
  assert.equal(isProgrammerError(new SyntaxError("Unexpected token")), true);
});

test("an operational failure is NOT one of them", () => {
  // Everything the retry loop, the fail-open capacity feed and sendEmail were
  // actually written for.
  assert.equal(isProgrammerError(new Error("upstream 503")), false);
  assert.equal(isProgrammerError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false);
});

test("RangeError is deliberately operational here", () => {
  // Not an oversight. `new Date(someStoredString)` and friends throw RangeError
  // on bad INPUT, and this application stores dates as free text — so a
  // RangeError is a bad row, which is a condition to handle, not a build error.
  // Written down because an unexplained omission from a list like this reads as
  // a mistake and gets "fixed" later.
  assert.equal(isProgrammerError(new RangeError("Invalid time value")), false);
});

test("rethrowIfProgrammerError passes an operational error through untouched", () => {
  assert.doesNotThrow(() => rethrowIfProgrammerError(new Error("upstream 500")));
});

test("rethrowIfProgrammerError rethrows THE SAME error, not a copy", () => {
  // The stack is the whole value of letting it escape. A wrapped or re-created
  // error points at this line instead of at the call that is wrong.
  const original = new ReferenceError("loadEnriched is not defined");
  try {
    rethrowIfProgrammerError(original);
    assert.fail("a ReferenceError did not escape");
  } catch (e) {
    assert.equal(e, original);
  }
});

test("severity has no default — an unstated choice is refused at the call site", () => {
  // CCC2.2. The first version rethrew for every caller, because that is what
  // the shared helper happened to do. One severity for every context is how the
  // page warmer came to be able to kill the web server. There is no default to
  // inherit now, and the refusal is synchronous so it cannot be missed.
  assert.throws(() => fireAndForget("x", Promise.resolve(), {}), /needs onProgrammerError/);
  assert.throws(() => fireAndForget("x", Promise.resolve()), /needs onProgrammerError/);
  assert.throws(() => fireAndForget("x", Promise.resolve(), { onProgrammerError: "warn" }), /needs onProgrammerError/);
});

test("fireAndForget records an operational failure and swallows it", async () => {
  __resetEffects();
  await fireAndForget("email", Promise.reject(new Error("Resend timed out")), { onProgrammerError: "surface" });

  const r = effectReport().email;
  assert.equal(r.failures, 1);
  assert.equal(r.programmerErrors, 0, "a timeout is not this repository's fault");
  assert.equal(r.codeIsWrong, false);
});

test("surface: a programmer error is counted separately and does NOT take the process down", async () => {
  // The decision, in one test. The request that triggered this has already
  // completed — the booking is committed and the traveller has been told it
  // succeeded. Dying protects no state and stops the site serving pages that
  // have nothing to do with email.
  __resetEffects();
  await fireAndForget("email", Promise.reject(new TypeError("esc is not a function")), { onProgrammerError: "surface" });

  const r = effectReport().email;
  assert.equal(r.programmerErrors, 1);
  assert.equal(r.codeIsWrong, true, "waiting will not fix this one, and the report must say so");
  assert.match(r.lastProgrammerError, /esc is not a function/);
});

test("a programmer error still counts toward failures, so neverWorked survives", async () => {
  // The trap in counting them separately. If programmer errors were EXCLUDED
  // from `failures`, a feature whose only failures are programmer errors would
  // report neverWorked: false — which is precisely the mirror's state, hidden
  // again one level down.
  __resetEffects();
  await fireAndForget("autouraSync", Promise.reject(new ReferenceError("loadEnriched is not defined")), { onProgrammerError: "surface" });

  const r = effectReport().autouraSync;
  assert.equal(r.neverWorked, true, "the mirror's state must still be reported as never having worked");
  assert.equal(r.codeIsWrong, true);
  assert.equal(r.failures, 1);
});

test("crash: declared, unwritten, and still asserted", async () => {
  // No site chooses this today. It exists so an unattended job or a CLI can
  // stop rather than report a run it did not do — and it is tested so that the
  // day one needs it, it is not being written for the first time.
  __resetEffects();
  await assert.rejects(
    fireAndForget("job", Promise.reject(new TypeError("x is not a function")), { onProgrammerError: "crash" }),
    TypeError
  );
  assert.equal(effectReport().job.programmerErrors, 1, "crashing does not excuse it from being recorded");
});

test("crash mode leaves an operational failure alone", async () => {
  __resetEffects();
  await fireAndForget("job", Promise.reject(new Error("upstream 503")), { onProgrammerError: "crash" });
  assert.equal(effectReport().job.failures, 1);
});

test("a resolved promise is left alone", async () => {
  __resetEffects();
  await fireAndForget("email", Promise.resolve({ ok: true }), { onProgrammerError: "surface" });
  assert.deepEqual(effectReport(), {});
});

test("surfaceProgrammerError reports whether it handled the error", async () => {
  // The timer callbacks branch on this: a programmer error is recorded here, an
  // operational one keeps its existing console.warn.
  __resetEffects();
  assert.equal(surfaceProgrammerError("pageWarm", new TypeError("buildHead is not a function")), true);
  assert.equal(surfaceProgrammerError("pageWarm", new Error("ETIMEDOUT")), false);
  assert.equal(effectReport().pageWarm.programmerErrors, 1);
  assert.equal(effectReport().pageWarm.failures, 1, "the operational one was NOT recorded here — the caller warns");
});

test("the mirror's actual error is counted on the first call", async () => {
  // Not a paraphrase — the real message, from the real defect. What the mirror
  // needed was to be VISIBLE from call one, which is what this asserts. It did
  // not need to take the site down.
  __resetEffects();
  const mirror = () => Promise.reject(new ReferenceError("loadEnriched is not defined"));
  await fireAndForget("autouraSync", mirror(), { onProgrammerError: "surface" });
  assert.equal(effectReport().autouraSync.codeIsWrong, true);
});

test("the handler the mirror actually had is gone from autoura-sync.js", () => {
  // The three places in that module that caught the ReferenceError and called
  // it transient. Comments stripped first: this module's own header quotes the
  // defect, and matching a quotation is the shortcut-verification mistake this
  // project keeps rediscovering.
  const sync = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  const guards = sync.split(/rethrowIfProgrammerError\(|surfaceProgrammerError\(/).length - 1;
  assert.ok(guards >= 3, `expected the retry loop, the emit and the capacity feed to be guarded; found ${guards}`);
});

// The whole call, by balancing parentheses rather than by a non-greedy regex.
// The regex version stopped at the first `)` — which is inside the argument —
// and reported a violation that was not one. A matcher that reads only part of
// what it is judging is the same class as the checker that read a comment as
// code.
function callsTo(src, name) {
  const out = [];
  for (let i = src.indexOf(`${name}(`); i !== -1; i = src.indexOf(`${name}(`, i + 1)) {
    let depth = 0;
    for (let j = i + name.length; j < src.length; j += 1) {
      if (src[j] === "(") depth += 1;
      else if (src[j] === ")") {
        depth -= 1;
        if (depth === 0) { out.push(src.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

test("no fire-and-forget site in the repository leaves severity to a default", () => {
  // CCC2.2 — the check on the decision itself. Every call must name its
  // severity; the helper refuses at run time, and this catches it at commit.
  let found = 0;
  for (const file of ["app.js", "autoura-sync.js", "email.js", "seo.js"]) {
    const src = readFileSync(join(ROOT, "server", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    for (const call of callsTo(src, "fireAndForget")) {
      found += 1;
      assert.match(call, /onProgrammerError:\s*"(surface|crash)"/, `${file}: ${call.slice(0, 90)}`);
    }
  }
  // A matcher that finds nothing passes vacuously, which reads exactly like a
  // clean repository. Same lesson as the empty test run.
  assert.ok(found >= 1, "found no fireAndForget call sites at all — the matcher is broken, not the code");
});

test("nothing in the web process chooses to die on a programmer error", () => {
  // The blast-radius rule, asserted where it applies: a request handler and a
  // timer inside the web process surface. `crash` is for a job or a CLI, and
  // nothing there needs it yet.
  for (const file of ["app.js", "autoura-sync.js", "email.js", "seo.js"]) {
    const src = readFileSync(join(ROOT, "server", file), "utf8");
    assert.ok(!/onProgrammerError:\s*"crash"/.test(src),
      `${file} would take the whole web process down; the request it belongs to has already completed`);
  }
});

test("every handler written for the world is guarded where it matters", () => {
  // The four modules the sweep ranked as exercised. A new one is not caught by
  // this test, which is what scripts/check-catch-handlers.js is for.
  for (const file of ["app.js", "autoura-sync.js", "email.js", "seo.js"]) {
    const src = readFileSync(join(ROOT, "server", file), "utf8");
    assert.match(src, /rethrowIfProgrammerError|isProgrammerError|fireAndForget/,
      `${file} catches failures and never distinguishes a broken build from a slow network`);
  }
});
