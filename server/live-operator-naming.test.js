// 27 Sep 2026: Capital Travel Service is not involved in Sawa. What a traveler
// reads where it used to be named, and the switch that takes a record off the
// public surfaces (054).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publicOperator } from "./domain.js";
import { mapAgency } from "./db/mappers.js";
import { UNNAMED_OPERATOR } from "../shared/operator-label.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the direct-bookings operator has no default", () => {
  const env = { ...process.env };
  delete env.DIRECT_BOOKINGS_OPERATOR;
  const out = execFileSync(process.execPath, ["-e", 'import("./server/brand.js").then((m) => process.stdout.write(JSON.stringify(m.DIRECT_BOOKINGS_OPERATOR)))'], { cwd: ROOT, env });
  assert.equal(String(out), '""');
});

test("an unlisted record is never named; a missing column reads as listed", () => {
  const row = { id: "ag_1", name: "Some Operator", verification_state: "verified" };
  assert.equal(publicOperator(mapAgency(row))?.name, "Some Operator", "054 not applied yet: still shown");
  assert.equal(publicOperator(mapAgency({ ...row, public_listed: true }))?.name, "Some Operator");
  assert.equal(publicOperator(mapAgency({ ...row, public_listed: false })), null);
});

test("the unnamed wording", () => {
  assert.equal(UNNAMED_OPERATOR, "a licensed Sawa partner");
});
