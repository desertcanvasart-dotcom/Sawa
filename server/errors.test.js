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
import { isProgrammerError, rethrowIfProgrammerError, fireAndForget } from "./errors.js";

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

test("fireAndForget records an operational failure and swallows it", async () => {
  const recorded = [];
  await fireAndForget("email", Promise.reject(new Error("Resend timed out")), {
    record: (kind, why) => recorded.push([kind, why]),
  });
  assert.deepEqual(recorded, [["email", "Resend timed out"]]);
});

test("fireAndForget records a programmer error AND rethrows it", async () => {
  const recorded = [];
  await assert.rejects(
    fireAndForget("email", Promise.reject(new TypeError("esc is not a function")), {
      record: (kind, why) => recorded.push([kind, why]),
    }),
    TypeError
  );
  assert.equal(recorded.length, 1, "a rethrown failure must still be recorded — it is not either/or");
});

test("a resolved promise is left alone", async () => {
  const recorded = [];
  await fireAndForget("email", Promise.resolve({ ok: true }), { record: () => recorded.push(1) });
  assert.equal(recorded.length, 0);
});

test("record is optional and its absence must not become a second failure", async () => {
  // A missing `record` used to be the shape of the original bug: the handler
  // itself throwing inside a catch. It resolves.
  await fireAndForget("x", Promise.reject(new Error("boom")));
});

test("the mirror's actual error would have escaped on the first call", async () => {
  // Not a paraphrase — the real message, from the real defect.
  const mirror = () => Promise.reject(new ReferenceError("loadEnriched is not defined"));
  await assert.rejects(fireAndForget("autouraSync", mirror()), ReferenceError);
});

test("the handler the mirror actually had is gone from autoura-sync.js", () => {
  // The three places in that module that caught the ReferenceError and called
  // it transient. Comments stripped first: this module's own header quotes the
  // defect, and matching a quotation is the shortcut-verification mistake this
  // project keeps rediscovering.
  const sync = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  const guards = sync.split(/rethrowIfProgrammerError\(|isProgrammerError\(/).length - 1;
  assert.ok(guards >= 3, `expected the retry loop, the emit and the capacity feed to be guarded; found ${guards}`);
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
