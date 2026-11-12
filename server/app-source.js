// The server's route code as one text, for the checks that read it.
//
// A great many tests and two gate scripts assert things about server/app.js by
// reading it: "every mutating route is audited", "no route writes this column",
// "this handler takes the lock before it counts seats". They were written when
// every route was in that one file. Routes are now being moved to
// server/routes/, and a check that went on reading app.js alone would pass
// simply because the code it guards is no longer there to be read.
//
// appSource() gives those checks what they always read: app.js, with each
// route module put back at the line that loads it. Order is the order Express
// registers routes in, so checks about what comes before what still hold.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = dirname(fileURLToPath(import.meta.url));

// provideRouteContext({ … });  await import("./routes/NAME.js");
const LOAD = /^provideRouteContext\(\{\n([^}]*)\}\);\nawait import\("\.\/routes\/([\w-]+)\.js"\);$/gm;

export function routeModuleFiles() {
  return readdirSync(join(SERVER, "routes")).filter((f) => f.endsWith(".js")).sort()
    .map((f) => join(SERVER, "routes", f));
}

// Every load point in app.js: which module, and which names it was handed.
export function routeLoads(app = readFileSync(join(SERVER, "app.js"), "utf8")) {
  return [...app.matchAll(LOAD)].map((m) => ({
    name: m[2],
    file: join(SERVER, "routes", `${m[2]}.js`),
    provided: m[1].split(",").map((s) => s.trim()).filter(Boolean),
  }));
}

export function appSource() {
  const app = readFileSync(join(SERVER, "app.js"), "utf8");
  return app.replace(LOAD, (_all, _names, name) => readFileSync(join(SERVER, "routes", `${name}.js`), "utf8"));
}
