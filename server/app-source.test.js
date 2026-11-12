// The route modules under server/routes/, and the one text the checks read.
//
// Moving routes out of app.js must not move them out of sight of the checks
// that read app.js. These tests hold the arrangement that prevents it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { appSource, routeLoads, routeModuleFiles } from "./app-source.js";
import { routeSourceFiles, scanMutatingRoutes } from "../scripts/audit-coverage.js";
import { provideRouteContext, routeContext } from "./route-context.js";

const loads = routeLoads();

test("every module under server/routes/ is loaded by app.js, once", () => {
  assert.ok(loads.length >= 6, `only ${loads.length} load points found in app.js — the matcher is broken, not the code`);
  const loaded = loads.map((l) => `${l.name}.js`).sort();
  const onDisk = routeModuleFiles().map((f) => basename(f)).sort();
  // A file nobody loads registers no routes: the endpoints 404 in production
  // while every check that reads the file still sees them.
  assert.deepEqual(loaded, onDisk, "a route module exists that app.js does not load, or is loaded twice");
});

test("a module is handed every name it takes from the route context", () => {
  assert.ok(loads.length > 0, "no load points found — this would assert nothing");
  for (const { name, file, provided } of loads) {
    const src = readFileSync(file, "utf8");
    const taken = /const \{\n([^}]*)\} = routeContext\(\);/.exec(src);
    assert.ok(taken, `${name}.js does not take its dependencies from routeContext()`);
    const names = taken[1].split(",").map((s) => s.trim()).filter(Boolean);
    assert.ok(names.includes("app"), `${name}.js does not take the Express app`);
    const missing = names.filter((n) => !provided.includes(n));
    assert.deepEqual(missing, [], `app.js loads ${name}.js without providing these`);
  }
});

test("a name that was never provided fails loudly, by name", () => {
  provideRouteContext({ somethingReal: 1 });
  assert.equal(routeContext().somethingReal, 1);
  assert.throws(() => routeContext().neverProvided, /"neverProvided" was not provided/);
});

test("the combined source holds every moved route, where it used to stand", () => {
  const src = appSource();
  assert.doesNotMatch(src, /await import\("\.\/routes\//, "a load point was left in the combined source instead of the module");
  for (const { name, file } of loads) {
    const routes = readFileSync(file, "utf8").match(/^app\.(get|post|patch|put|delete)\("[^"]+"/gm) || [];
    assert.ok(routes.length, `${name}.js registers no routes`);
    for (const r of routes) assert.ok(src.includes(r), `${r} (${name}.js) is missing from the combined source`);
  }
  // Order is registration order: payments were, and are, before settlements.
  assert.ok(src.indexOf('"/api/admin/payments"') < src.indexOf('"/api/admin/settlements'), "the modules are not in the order app.js loads them");
});

test("the audit scan reads the route modules too", () => {
  assert.equal(routeSourceFiles().length, routeModuleFiles().length + 1);
  const routes = scanMutatingRoutes();
  for (const { name } of loads) {
    assert.ok(routes.some((r) => r.file === `server/routes/${name}.js`), `no mutating route scanned in ${name}.js`);
  }
  // The same routes, whether counted file by file or in the combined text.
  const combined = (appSource().match(/^app\.(post|patch|put|delete)\(\s*"/gm) || []).length;
  assert.equal(routes.length, combined);
});
