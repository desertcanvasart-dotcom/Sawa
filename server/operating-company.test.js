// The "Operating company" choice: only an active, publicly listed operator.
// Capital Travel Service is pending and unlisted, so it can never be picked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorSelectable } from "./domain.js";
import { mapAgency } from "./db/mappers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const agency = (over = {}) => mapAgency({ id: "ag_1", name: "Some Operator", public_listed: true, ...over });

test("an active, listed operator can be selected", () => {
  assert.equal(operatorSelectable(agency(), { status: "active" }), true);
});

test("Capital Travel Service (pending and unlisted) can't be selected", () => {
  const cts = agency({ name: "Capital Travel Service", public_listed: false });
  assert.equal(operatorSelectable(cts, { status: "pending" }), false);
});

test("pending, suspended, removed, unlisted or operator-less companies can't be selected", () => {
  for (const status of ["pending", "suspended", "removed"]) assert.equal(operatorSelectable(agency(), { status }), false, status);
  assert.equal(operatorSelectable(agency({ public_listed: false }), { status: "active" }), false, "active but unlisted");
  assert.equal(operatorSelectable(agency(), null), false, "no operator record");
  assert.equal(operatorSelectable(null, { status: "active" }), false);
});

test("the server refuses an ineligible company and the dropdown filters on the same flag", () => {
  const app = read("server", "app.js");
  assert.match(app, /operatorSelectable\(a && mapAgency\(a\), o\)\)\s*throw new AppError\(422/);
  assert.match(app, /operatorSelectable: operatorSelectable\(a, ops\.get\(a\.id\)\)/);
  assert.match(read("src", "AdminDashboard.jsx"), /filter\(\(a\) => a\.operatorSelectable \|\|/);
});
