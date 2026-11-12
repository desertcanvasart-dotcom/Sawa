// What server/app.js hands to the route modules under server/routes/.
//
// app.js was one 5,400-line file: every route, and every helper a route uses.
// The routes are being moved out a group at a time. A moved group still needs
// what app.js built for it — the Express app itself, the auth guards, the
// async wrapper, the loaders that lock a departure. Those are not importable
// (app.js is the entry point, and importing it back would be a cycle), so
// app.js provides them here immediately before loading each module:
//
//   provideRouteContext({ app, h, requireAuth, … });
//   await import("./routes/payments.js");
//
// and the module takes what it uses, once, at its top:
//
//   const { app, h, requireAuth } = routeContext();
//
// A name that was never provided fails at start-up, naming itself — not later,
// as `undefined is not a function` inside the first request to reach it.
const provided = {};

export function provideRouteContext(values) {
  Object.assign(provided, values);
}

export function routeContext() {
  return new Proxy(provided, {
    get(target, name) {
      if (typeof name === "symbol" || name in target) return target[name];
      throw new Error(`route context: "${String(name)}" was not provided by server/app.js before this module loaded`);
    },
  });
}
