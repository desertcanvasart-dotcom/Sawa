// buildBody() injects a plain-HTML copy of each SPA route inside #root so
// crawlers that never run JavaScript still read /itineraries, every tour page
// and every blog post in full. React clears it on mount — but the bundle is a
// deferred module, so for the few hundred milliseconds before that, the browser
// had already painted it: visitors opening /itineraries saw an unstyled wall of
// blue links flash past before the real page arrived.
//
// The shell hides it behind a class only script can set. That balance is easy
// to break in either direction and neither break is visible in review: drop the
// <script> and the flash returns, drop the `.js` scope and every non-JS crawler
// stops seeing the content this whole mechanism exists to serve. These are the
// assertions that make both loud.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = readFileSync(join(root, "index.html"), "utf8");

test("the SPA shell hides the server-rendered crawler body from browsers", () => {
  assert.match(
    shell,
    /\.js\s+\[data-server-rendered\]\s*\{\s*display:\s*none\s*\}/,
    "index.html must hide [data-server-rendered] once the `js` class is set — without it the crawler body flashes before React mounts"
  );
  assert.match(
    shell,
    /document\.documentElement\.classList\.add\(["']js["']\)/,
    "index.html must set the `js` class, or the hiding rule never applies"
  );
});

test("the rule stays scoped to the class, so a non-JS crawler still sees the body", () => {
  // An unscoped `[data-server-rendered] { display: none }` would read as an
  // equivalent tidy-up and would hide the content from exactly the readers it
  // was written for. Checked rule by rule rather than by one regex over the
  // file, so the comment above — which names the attribute — can't satisfy it.
  const css = [...shell.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hiding = rules.filter(([, sel, body]) => sel.includes("data-server-rendered") && /display:\s*none/.test(body));
  assert.ok(hiding.length, "no rule hides [data-server-rendered] — the crawler body will flash before React mounts");
  for (const [, sel] of hiding) {
    assert.match(sel, /\.js\b/, `\`${sel.trim()}\` hides the crawler body unconditionally, which hides it from non-JS crawlers too`);
  }
});

test("the class is set inside <head>, so the crawler body never paints", () => {
  // A parser-blocking script in the head runs before the body is parsed. Move
  // it after the head and the rule lands after the paint it exists to prevent.
  const script = shell.indexOf("classList.add");
  const headClose = shell.indexOf("</head>");
  assert.notEqual(script, -1);
  assert.ok(script < headClose, "the `js` class must be set in the head, ahead of the body");
  assert.ok(!/<script[^>]*\b(defer|async)\b[^>]*>[^<]*classList\.add\(["']js["']\)/.test(shell),
    "the class-setting script must be parser-blocking — defer/async lets the body paint first");
});
