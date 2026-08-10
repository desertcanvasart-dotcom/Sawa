// DIR-13 — proving `audit:repo-truth` fires.
//
// The gate had a test asserting the repository is currently clean and nothing
// else. That assertion passes identically whether the scanner is working or
// matching nothing at all — the vacuous-pass class, in the check whose job is
// to stop the build claiming things that are not true.
//
// So: put statements in front of it that it MUST catch, and statements it MUST
// NOT, and assert both.
import test from "node:test";
import assert from "node:assert/strict";
import { collect, sourceFiles } from "../scripts/audit-repo-truth.js";

// A fixture file list with a stub reader — nothing touches the real tree.
const from = (text) => collect(["fixture.md"], () => text);

test("it fires — an internal statement about what the build does is collected", () => {
  const found = from("Payments are in log-mode for now — no processor is connected to this build.");
  assert.equal(found.length, 1, "a build-truth statement was not collected");
  assert.match(found[0].where, /^fixture\.md:1$/);
  assert.ok(found[0].id && found[0].id.length === 12, "every finding needs a stable id to register against");
});

test("the id is content-addressed, so moving a line does not re-open a reviewed verdict", () => {
  const claim = "Operator verification is stubbed: no licence is currently checked against the Ministry.";
  const [a] = from(claim);
  const [b] = from(`\n\n${claim}`);
  assert.equal(a.id, b.id, "the same sentence on a different line must keep its verdict");
  assert.equal(b.where, "fixture.md:3", "but the location must follow the line");
});

test("it stops — prose that is not a claim about the build is left alone", () => {
  // Long enough and comment-shaped, but says nothing about what the system does.
  assert.deepEqual(from("Cairo in August is hot enough that the afternoon tours start later."), []);
});

test("it refuses to report clean on an empty file list", () => {
  // A scanner that examined nothing must not render as a scanner that found
  // nothing. This is the guard that makes every other assertion here mean
  // something.
  assert.throws(() => collect([], () => ""), /refusing to report clean/);
});

test("and the real tree is genuinely scanned — not an empty list dressed as clean", () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, `only ${files.length} source files walked`);
  assert.ok(collect().length > 0, "the register would be trivially satisfiable");
});
