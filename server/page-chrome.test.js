// U03 + U05 + E01, from the 25 Sep 2026 audit.
//
// U03: a "Save" button on every tour page did nothing.
// U05: the Cookie settings link was missing from the React pages' footer.
// E01: after in-app navigation the title and canonical still described the
//      first page the visitor landed on.
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/never-connects";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { buildHead } = await import("./seo.js");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const main = read("src", "main.jsx");
const app = read("server", "app.js");

test("U03: no Save button without a saved list", () => {
  assert.doesNotMatch(main, /aria-label="Save"/);
});

test("U05: the React footer offers Cookie settings, opening the consent dialog", () => {
  assert.match(main, /className="ck-link" onClick=\{\(e\) => \{ e\.preventDefault\(\); window\.sawaConsent\?\.open\?\.\(\); \}\}>Cookie settings<\/a>/);
  assert.match(read("site", "assets", "consent.js"), /open: function \(\) \{ render\(true\); \}/, "the API it calls exists");
  assert.match(read("site", "assets", "consent.js"), /querySelector\("\.ck-link"\)/, "consent.js skips footers that already have one");
});

test("E01: buildHead returns the facts the SPA applies, for a page that needs no database", async () => {
  const r = await buildHead("/itineraries");
  assert.ok(r.meta, "buildHead must return meta");
  assert.equal(r.meta.title, r.title);
  assert.equal(r.meta.canonical, "https://sawa.tours/itineraries");
  assert.ok(r.meta.description.length > 20);
  const nf = await buildHead("/definitely-not-a-page");
  assert.equal(nf.notFound, true);
  assert.equal(nf.meta.noindex, true);
});

test("E01: the SPA fetches and applies them on every client-side navigation", () => {
  assert.match(app, /app\.get\("\/api\/public\/route-head"/);
  assert.match(main, /fetch\(`\$\{API_BASE\}\/public\/route-head\?path=\$\{encodeURIComponent\(path\)\}`/);
  assert.match(main, /\.then\(applyRouteHead\)/);
  const fn = main.slice(main.indexOf("function applyRouteHead(m)"), main.indexOf("// ---- Blog: SEO + GEO meta injection ----"));
  for (const want of ["document.title = m.title", '"description", m.description', 'rel="canonical"', '"og:url", m.canonical']) {
    assert.ok(fn.includes(want), `applyRouteHead doesn't set ${want}`);
  }
});

test("U02: 'Almost full' only when it is — two seats or fewer", () => {
  const home = read("site", "index.html");
  assert.match(home, /var ALMOST_FULL=2;/);
  assert.match(home, /seatsLeft===0\?'Full':seatsLeft<=ALMOST_FULL\?'Almost full':'Confirmed · seats left'/);
  assert.doesNotMatch(home, /seatsLeft>0\?'Almost full'/);
});
