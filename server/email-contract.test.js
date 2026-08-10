// AAA1.2 — sendEmail's contract, asserted instead of assumed.
//
// Thirteen call sites wrote `sendEmail(...).catch(() => {})`. Nobody had
// established that sendEmail throws. It does not, on an operational failure —
// so the handler was defending against an event that could not happen, while
// being the exact expression that would have discarded it if it ever did. A
// contract that exists only in the callers' imagination is not a contract, and
// this file is the difference.
//
// Two environment facts, set before the module loads and stated because a check
// whose result depends on an unstated condition is not a verdict:
//
//   RESEND_API_KEY  forced on, so `emailMode` is "live" and the branch under
//                   test is the branch that runs in production. In "log" mode
//                   sendEmail returns before reaching any of this.
//
//   DATABASE_URL    pointed at a closed port. email_log is best-effort and
//                   swallows its own failure by design (that IS its contract),
//                   so the operational test below prints one
//                   "email_log insert failed" line. That line is expected.
//                   The programmer-error path never reaches it — which is
//                   itself one of the assertions.
process.env.RESEND_API_KEY = "test-key-never-used-a-stub-answers";
process.env.EMAIL_FROM = "Sawa Tours <test@example.com>";
process.env.DATABASE_URL = "postgres://nobody:nobody@127.0.0.1:1/none";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { sendEmail, sendEmailInBackground, emailMode } = await import("./email.js");

const realFetch = globalThis.fetch;
const withFetch = async (stub, fn) => {
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
};
const message = { to: "traveller@example.com", subject: "Your booking", text: "hello", kind: "test" };

test("the branch under test is the branch that runs in production", () => {
  // Without this the three tests below would pass against the log-mode early
  // return and prove nothing — a green run that tested nothing, which is the
  // failure this project keeps finding in its own checks.
  assert.equal(emailMode, "live");
});

test("an OPERATIONAL failure returns { ok: false } and never throws", async () => {
  const r = await withFetch(
    async () => { throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }); },
    () => sendEmail(message)
  );
  assert.deepEqual(r, { ok: false, mode: "live" });
});

test("an upstream rejection is operational too", async () => {
  const r = await withFetch(
    async () => ({ ok: false, status: 422, text: async () => "invalid to address" }),
    () => sendEmail(message)
  );
  assert.deepEqual(r, { ok: false, mode: "live" });
});

test("a PROGRAMMER error is not reported as a mail outage", async () => {
  // The distinction the thirteen handlers could not draw. A broken template
  // returning { ok: false } sends someone to check Resend's status page for a
  // fault that is in this repository.
  await withFetch(
    async () => { throw new TypeError("esc is not a function"); },
    () => assert.rejects(() => sendEmail(message), TypeError)
  );
});

test("a programmer error writes no 'failed' row and no failure count", async () => {
  // It escapes BEFORE recordEmail and recordFailure. Otherwise the email_log
  // and /api/modes would both carry a delivery failure that never happened, and
  // ZZ2's neverWorked would start describing a template bug.
  const src = readFileSync(join(ROOT, "server", "email.js"), "utf8");
  const guard = src.indexOf("rethrowIfProgrammerError(e)");
  const logged = src.indexOf('status: "failed", error: e.message');
  const counted = src.indexOf('recordFailure("email", e.message)');
  assert.ok(guard > -1 && logged > -1 && counted > -1, "the catch no longer has the shape this asserts");
  assert.ok(guard < logged && guard < counted, "the programmer-error guard must come first in the catch");
});

test("sendEmailInBackground swallows an operational failure", async () => {
  // What the callers wanted all along: a booking must not fail because a
  // receipt did not send.
  await withFetch(
    async () => { throw new Error("Resend timed out"); },
    () => sendEmailInBackground(message)
  );
});

test("sendEmailInBackground rethrows a programmer error", async () => {
  // Nobody awaits this in production, so the rejection is unhandled and Node
  // treats it as fatal. That is the deliberate cost recorded in errors.js: a
  // broken template takes the process down instead of being absorbed thirteen
  // times a day for years.
  await withFetch(
    async () => { throw new ReferenceError("bookingCode is not defined"); },
    () => assert.rejects(() => sendEmailInBackground(message), ReferenceError)
  );
});

test("no caller discards a sendEmail result any more", () => {
  // The thirteen are gone. The one remaining direct call is the cancellation
  // loop, which awaits the result because it counts how many travellers were
  // actually reached (PP2.1).
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

  const direct = [...app.matchAll(/(await\s+)?sendEmail\(/g)];
  assert.equal(direct.length, 1, `expected exactly one direct sendEmail() call in app.js, found ${direct.length}`);
  assert.ok(direct[0][1], "the one direct call must be awaited — its result is the notified count");

  assert.ok(!/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(app), "an empty rejection handler is back in app.js");
  assert.ok(app.includes("sendEmailInBackground("), "the fire-and-forget sends no longer go through the wrapper");
});
