// Agencies: what's linked, Deactivate, and "Not assigned" on a tour.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorSelectable } from "./domain.js";
import { mapAgency } from "./db/mappers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const agency = (over = {}) => mapAgency({ id: "ag_1", name: "Some Operator", status: "active", public_listed: true, ...over });

test("a deactivated agency can't be chosen as a tour's operating company", () => {
  assert.equal(operatorSelectable(agency(), { status: "active" }), true);
  assert.equal(operatorSelectable(agency({ status: "inactive" }), { status: "active" }), false);
});

test("an inactive agency's team is not signed in; other agency statuses are untouched", () => {
  const auth = read("server", "auth.js");
  assert.match(auth, /LEFT JOIN agencies a ON a\.id = u\.agency_id/);
  assert.match(auth, /profile\.agency_id && profile\.agency_status === "inactive"\) return next\(\)/);
});

test('"Not assigned" clears the operating company; leaving the key out does not', () => {
  const app = read("server", "app.js");
  assert.match(app, /agency_id=CASE WHEN \$43::boolean THEN NULL ELSE COALESCE\(EXCLUDED\.agency_id, tour_products\.agency_id\) END/);
  assert.match(app, /clearAgency: Object\.hasOwn\(body, "agencyId"\) && !body\.agencyId/);
  assert.match(app, /review\.clearAgency === true,\n    \]/);
  // The agency's own listing route never clears its own operator.
  const agencyRoute = app.slice(app.indexOf('app.post("/api/agency/tour-products"'));
  assert.doesNotMatch(agencyRoute.slice(0, agencyRoute.indexOf("}));")), /clearAgency/);
});

test("the agencies screen lists what's linked and offers Deactivate", () => {
  const app = read("server", "app.js");
  for (const route of ['app.get("/api/admin/agencies/:id/links"', 'app.post("/api/admin/agencies/:id/tours/:tourId/unassign"', 'app.post("/api/admin/agencies/:id/status"']) {
    assert.ok(app.includes(route), route);
  }
  assert.match(app, /UPDATE tour_products SET agency_id = NULL WHERE id=\$1 AND agency_id=\$2/);
  const ui = read("src", "AdminDashboard.jsx");
  assert.match(ui, /if \(r\.status === 409\) \{ setLinks\(null\); await openLinks\(a\.id, j\.error\); return; \}/);
  assert.match(ui, /Deactivate instead/);
});
