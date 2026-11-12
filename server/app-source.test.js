// The route modules under server/routes/, and the one text the checks read.
//
// Moving routes out of app.js must not move them out of sight of the checks
// that read app.js. These tests hold the arrangement that prevents it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { appSource, routeLoads, routeModuleFiles, mainPartFiles, mainSource } from "./app-source.js";
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
    const text = readFileSync(file, "utf8");
    const routes = text.match(/^app\.(get|post|patch|put|delete)\("[^"]+"/gm) || [];
    // A module either registers routes or holds what other modules call and
    // hands it back (date-request-create.js). One that does neither is dead.
    assert.ok(routes.length || /^export /m.test(text), `${name}.js registers no routes and exports nothing`);
    for (const r of routes) assert.ok(src.includes(r), `${r} (${name}.js) is missing from the combined source`);
  }
  // Order is registration order: payments were, and are, before settlements.
  assert.ok(src.indexOf('"/api/admin/payments"') < src.indexOf('"/api/admin/settlements'), "the modules are not in the order app.js loads them");
});

test("the audit scan reads the route modules too", () => {
  assert.equal(routeSourceFiles().length, routeModuleFiles().length + 1);
  const routes = scanMutatingRoutes();
  const scanned = new Set(routes.map((r) => r.file));
  for (const name of ["payments", "settlements", "bookings", "public-bookings", "date-requests", "agencies-staff"]) {
    assert.ok(scanned.has(`server/routes/${name}.js`), `no mutating route scanned in ${name}.js`);
  }
  // The same routes, whether counted file by file or in the combined text.
  const combined = (appSource().match(/^app\.(post|patch|put|delete)\(\s*"/gm) || []).length;
  assert.equal(routes.length, combined);
});

// ---- src/main.jsx, split the same way -------------------------------------

test("every part of main.jsx is still part of the app, and none reaches back into it", () => {
  const parts = mainPartFiles();
  assert.ok(parts.length >= 10, `only ${parts.length} parts found — the header marker is not matching`);
  const all = [...parts.map((f) => readFileSync(f, "utf8")), readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8")];
  for (const file of parts) {
    const name = basename(file);
    // A part nothing imports is not in the bundle: the page it held is gone
    // while every check that reads the combined source still sees its code.
    assert.ok(all.some((src) => src.includes(`from "./${name}"`)), `${name} is imported by nothing`);
    // main.jsx is the entry and renders on load; importing it back would run
    // the whole app from inside one of its own parts.
    assert.doesNotMatch(readFileSync(file, "utf8"), /from "\.\/main(\.jsx)?"/, `${name} imports main.jsx`);
  }
});

test("the combined app source holds main.jsx and every part", () => {
  const src = mainSource();
  assert.match(src, /^function App\(\) \{/m);
  assert.match(src, /^createRoot\(/m);
  for (const marker of ["function TourDetailV2(", "function EmbedBook(", "function BookingLookupPage(", "function PublicSite(", "function Portal("]) {
    assert.ok(src.includes(marker), `${marker} is missing from the combined source`);
  }
});
