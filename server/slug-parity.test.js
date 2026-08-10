// DIR-8 — the file the browser loads, evaluated against the server authority.
//
// Nine hand copies existed. Five of them predated a 301-redirect-loop fix, and
// the only thing holding that closed was every live product title happening to
// slugify to something — an invariant nothing enforced.
//
// This test does not read the generated file. It EXECUTES it, the way a browser
// does, and compares its output to `shared/slug.js` case by case. A generated
// file that is byte-identical to a stale source would pass a diff; only running
// it can say the two agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, tourSlug, tourPath } from "../shared/slug.js";
import { generate } from "../scripts/sync-slug.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(ROOT, "site", "assets", "slug.js");

// Load it as a browser would: a script that assigns onto a global.
function loadBrowserCopy(source = readFileSync(GENERATED, "utf8")) {
  const global = {};
  new Function("window", `${source}\nreturn window.SawaSlug;`)(global);
  return global.SawaSlug;
}

const browser = loadBrowserCopy();

// The real catalogue's shapes, plus every edge case shared/slug.js documents —
// which is where all three divergences lived.
const CASES = [
  { title: "Giza Pyramids, Sphinx & the Grand Egyptian Museum", city: "Cairo", type: "day_tour", id: "tour_a" },
  { title: "Egypt in Depth — 9-Day Nile Cruise & Cairo", city: "Cairo", type: "package", id: "pkg_b" },
  { title: "Luxor to Aswan — Esna, Edfu & Kom Ombo Temple Road", city: "Luxor", type: "day_tour", id: "tour_c" },
  { title: "Cairo Museum Walk", city: "Cairo", type: "day_tour", id: "tour_d" },
  { title: "Desert Crossing", city: null, type: "day_tour", id: "tour_e" },
  { title: "Café Déjà Vu Tour", city: "Cairo", type: "day_tour", id: "tour_f" },
  { title: "Luxor & Karnak", city: "Luxor", type: "day_tour", id: "tour_g" },
  // The three that diverged. Each produced a malformed or id-shaped slug on the
  // five destination pages, and an id-shaped slug is a 301 loop.
  { title: "رحلة الأهرامات", city: "Cairo", type: "day_tour", id: "tour_abc123" },
  { title: "The and of a", city: "Luxor", type: "package", id: "pkg_xyz789" },
  { title: "", city: "Aswan", type: "day_tour", id: "tour_zzz" },
];

test("the browser copy agrees with the server on every case", () => {
  for (const p of CASES) {
    assert.equal(browser.tourSlug(p), tourSlug(p), `tourSlug disagreed on ${JSON.stringify(p.title)}`);
    assert.equal(browser.tourPath(p), tourPath(p), `tourPath disagreed on ${JSON.stringify(p.title)}`);
    assert.equal(browser.slugify(p.title), slugify(p.title), `slugify disagreed on ${JSON.stringify(p.title)}`);
  }
});

test("the three that used to diverge produce a usable slug", () => {
  // DIR-14 — a loop is a claim about every member and says nothing about
  // whether there are any. This test is worthless on an empty set.
  assert.equal(CASES.length, 10, "the case list changed — the last three are the divergent ones");
  // Not just "they agree" — they must agree on something that is not a 301 loop.
  // An id-shaped slug is rewritten by the legacy-URL redirect to itself.
  for (const p of CASES.slice(-3)) {
    const s = browser.tourSlug(p);
    assert.ok(s, "empty slug");
    assert.ok(!s.startsWith("-"), `malformed slug "${s}" — this is the -from-cairo shape`);
    assert.ok(!/^(tour|pkg)_/.test(s), `id-shaped slug "${s}" — the legacy redirect rewrites this to itself`);
  }
});

test("it fires on a planted divergence", () => {
  // NNN1. A parity test that has never been shown to fail is indistinguishable
  // from one that cannot fail. This plants the exact pre-fix fallback the five
  // destination pages carried.
  const stale = readFileSync(GENERATED, "utf8").replace(
    /const idPart = slugify\(String\(p\.id \|\| ""\)\.replace\(\/\^\(tour\|pkg\)_\/, ""\)\);[\s\S]*?return \[[^\]]*\][^;]*;/,
    'return String(p.id || "");'
  );
  const old = loadBrowserCopy(stale);
  assert.notEqual(old.tourSlug(CASES.at(-2)), tourSlug(CASES.at(-2)),
    "the planted pre-fix version was not detected — this test cannot fail");
});

test("the generated file is current", () => {
  // check:slug says the same thing in preflight; this says it at commit time.
  assert.equal(readFileSync(GENERATED, "utf8"), generate(),
    "site/assets/slug.js is stale — run npm run sync:slug");
});

test("no static page defines its own slug rule any more", () => {
  // The nine copies. Eight were in these files; a ninth returning would be
  // invisible to the parity test above, which only checks the generated file.
  const pages = ["index", "goahead", "departures"].map((n) => `site/${n}.html`)
    .concat(["cairo", "luxor", "aswan", "siwa", "abu-simbel"].map((n) => `site/destinations/${n}.html`));
  for (const rel of pages) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(!/function\s+slugify\s*\(/.test(src), `${rel} still declares its own slugify`);
    assert.ok(!/function\s+tourSlug\s*\(/.test(src), `${rel} still declares its own tourSlug`);
    assert.match(src, /<script src="\/assets\/slug\.js"><\/script>/, `${rel} does not load the generated copy`);
    assert.match(src, /window\.SawaSlug/, `${rel} does not bind the shared rule`);
  }
});
