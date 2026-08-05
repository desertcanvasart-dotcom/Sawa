// Unit tests for the public URL slugs. Pure functions — no DB. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, tourSlug, tourPath } from "./slug.js";

test("slugify: lowercases, strips accents, drops stop-words, hyphenates", () => {
  assert.equal(slugify("Giza Pyramids & the Sphinx"), "giza-pyramids-sphinx");
  assert.equal(slugify("Café Déjà Vu Tour"), "cafe-deja-vu-tour");
  assert.equal(slugify("  Valley  of  the  Kings  "), "valley-kings");
});

test("slugify: yields empty for input with no latin word characters", () => {
  // Not a defect — callers must handle it (see tourSlug below).
  assert.equal(slugify("رحلة الأهرامات"), "");
  assert.equal(slugify("The A Of An"), "");
  assert.equal(slugify("★★★"), "");
});

test("tourSlug: day tours gain a -from-<city> qualifier, packages don't", () => {
  assert.equal(
    tourSlug({ id: "tour_1", title: "Grand Egyptian Museum", city: "Cairo", type: "day_tour" }),
    "grand-egyptian-museum-from-cairo"
  );
  assert.equal(
    tourSlug({ id: "pkg_1", title: "Egypt In Depth 9 Day", city: "Cairo", type: "package" }),
    "egypt-in-depth-9-day"
  );
});

test("tourSlug: doesn't repeat a city already present in the title", () => {
  assert.equal(
    tourSlug({ id: "tour_2", title: "Cairo Highlights", city: "Cairo", type: "day_tour" }),
    "cairo-highlights"
  );
});

test("tourSlug: an unslugifiable title never yields a bare -from-<city>", () => {
  // Regression: `slug += "-from-cairo"` on an empty slug produced the malformed
  // "/tour/-from-cairo", and the `|| p.id` fallback never fired because the
  // leading-hyphen string is truthy.
  const slug = tourSlug({ id: "tour_arabic_x1", title: "رحلة الأهرامات", city: "Cairo", type: "day_tour" });
  assert.ok(!slug.startsWith("-"), `slug must not start with a hyphen, got ${slug}`);
  assert.ok(slug.includes("cairo"));
});

test("tourSlug: never returns an id-shaped slug (301 redirect loop)", () => {
  // Regression: returning the raw id gave /package/pkg_x, which the legacy-URL
  // redirect in app.js rewrites to /package/<tourSlug> — the same URL. Browsers
  // cache a 301, so the page broke permanently for anyone who hit it once.
  for (const p of [
    { id: "pkg_stopwords", title: "The Of And", city: "Cairo", type: "package" },
    { id: "tour_arabic_x1", title: "رحلة الأهرامات", city: "Cairo", type: "day_tour" },
    { id: "tour_blank", title: "", city: "", type: "day_tour" },
  ]) {
    const slug = tourSlug(p);
    assert.doesNotMatch(slug, /^(tour|pkg)_/, `slug must not look like an id, got ${slug}`);
    assert.ok(slug.length > 0, "slug must never be empty");
    assert.notEqual(slug, p.id);
  }
});

test("tourSlug: output is always URL-safe", () => {
  for (const p of [
    { id: "tour_1", title: "Giza & the Sphinx!", city: "Cairo", type: "day_tour" },
    { id: "tour_2", title: "رحلة", city: "Luxor", type: "day_tour" },
    { id: "pkg_3", title: "★", city: "", type: "package" },
  ]) {
    const slug = tourSlug(p);
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `unsafe slug: ${slug}`);
    assert.equal(encodeURIComponent(slug), slug);
  }
});

test("tourPath: routes packages and day tours to their own prefixes", () => {
  assert.equal(tourPath({ id: "pkg_1", title: "Nile Cruise", type: "package" }), "/package/nile-cruise");
  assert.equal(tourPath({ id: "tour_1", title: "Saqqara", city: "Cairo", type: "day_tour" }), "/tour/saqqara-from-cairo");
});
