// AAA1.3 — the browser's one honest objection to the ban, and its limit.
//
// Some browser failures are expected, unfixable AND continuous: postMessage to
// a parent frame runs on every resize, blocked storage throws on every attempt
// for a whole session. Logging each occurrence buries the console, and a
// console nobody can read is the argument the next person uses for deleting the
// logging entirely.
//
// Once is the answer. Once is still observably different from never.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { warnOnce, __resetWarnOnce } from "./warn-once.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function capture(fn) {
  const said = [];
  const real = console.warn;
  console.warn = (...args) => said.push(args.join(" "));
  try { fn(); } finally { console.warn = real; }
  return said;
}

test("it says it the first time", () => {
  __resetWarnOnce();
  const said = capture(() => warnOnce("embed-height", "[embed] height not posted —", "blocked"));
  assert.deepEqual(said, ["[embed] height not posted — blocked"]);
});

test("and not the next two hundred", () => {
  // The ResizeObserver case. Without this the embed logs on every frame.
  __resetWarnOnce();
  const said = capture(() => {
    for (let i = 0; i < 200; i += 1) warnOnce("embed-height", "[embed] height not posted");
  });
  assert.equal(said.length, 1);
});

test("a different failure is a different line", () => {
  // Keyed, not global. "The embed cannot resize" and "partner attribution is
  // not persisting" are different problems and collapsing them would hide the
  // second behind the first.
  __resetWarnOnce();
  const said = capture(() => {
    warnOnce("embed-height", "height");
    warnOnce("referral-store", "storage");
  });
  assert.equal(said.length, 2);
});

test("it reports whether it actually said anything", () => {
  __resetWarnOnce();
  assert.equal(warnOnce("k", ""), true);
  assert.equal(warnOnce("k", ""), false);
});

test("every browser handler that used to be empty now uses it", () => {
  // The five sites in main.jsx: the tour detail fetch, the referral beacon, the
  // referral store, and the two embed postMessage calls. Comments stripped, so
  // this counts calls rather than the paragraphs explaining them.
  const main = readFileSync(join(ROOT, "src", "main.jsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  const calls = main.split("warnOnce(").length - 1;
  assert.ok(calls >= 5, `expected the five converted handlers to call warnOnce; found ${calls}`);
});
