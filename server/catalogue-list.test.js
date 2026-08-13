// The /itineraries body is built from a memoised, narrow query rather than
// SELECT * — Server-Timing had it at 981ms, the whole remaining cost of a cold
// render. These cover the seam that change created: the markup now takes rows
// directly, and passing it the query result instead of the rows is the mistake
// that is easy to make and impossible to see without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { catalogueListHtml } from "./seo.js";
import { tourPath } from "./slug.js";
// The glyph comes from the authority, not from a literal here. A test that
// hard-codes it is a fortieth copy of the currency, and it fails the day the
// site's currency changes for a reason that has nothing to do with this seam —
// which is exactly what happened when the site moved from dollars to euros.
import { CURRENCY_SYMBOL as C } from "../shared/currency.js";

const tour = {
  id: "tour_giza", type: "day_tour", title: "Giza Pyramids & Sphinx",
  city: "Cairo", duration: "8 hours", break_price: 55, published_rate: 70,
};
const pkg = {
  id: "pkg_nile", type: "package", title: "Nile Cruise",
  city: "Luxor", duration: "5 days", break_price: null, published_rate: 900,
};

test("rows render as links to the tour and package routes", () => {
  const html = catalogueListHtml([tour, pkg]);
  assert.match(html, /<a href="\/tour\/[^"]+">Giza Pyramids &amp; Sphinx<\/a>/);
  assert.match(html, /<a href="\/package\/[^"]+">Nile Cruise<\/a>/);
  assert.equal(html.match(/<li>/g).length, 2);
});

test("a query result is refused rather than silently rendering nothing", () => {
  // The exact slip this guards: catalogueRows() returns rows, and the caller
  // that kept saying `.rows` would have produced `undefined.map`.
  assert.throws(() => catalogueListHtml({ rows: [tour] }), TypeError);
  assert.throws(() => catalogueListHtml(undefined), TypeError);
});

test("the seven selected columns are enough to render a row", () => {
  // If the list ever needs an eighth field, this fails before the narrowed
  // SELECT quietly starts emitting blanks in production.
  const html = catalogueListHtml([tour]);
  assert.match(html, /Cairo/);
  assert.match(html, /8 hours/);
  assert.match(html, new RegExp(`from ${C}55/person`));
});

test("break_price wins over published_rate, and a missing one falls back", () => {
  assert.match(catalogueListHtml([tour]), new RegExp(`from ${C}55/person`));
  assert.match(catalogueListHtml([pkg]), new RegExp(`from ${C}900/person`));
});

test("forming dates are counted per product and pluralised", () => {
  const counts = new Map([["tour_giza", 1], ["pkg_nile", 3]]);
  const html = catalogueListHtml([tour, pkg], counts);
  assert.match(html, /1 date forming/);
  assert.match(html, /3 dates forming/);
});

test("a product with no forming dates says nothing about them", () => {
  assert.doesNotMatch(catalogueListHtml([tour]), /forming/);
});

test("operator-supplied titles are escaped", () => {
  const nasty = { ...tour, title: 'Giza <script>alert("x")</script>' };
  const html = catalogueListHtml([nasty]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("an empty catalogue renders an empty list, not a crash", () => {
  assert.equal(catalogueListHtml([]), "");
});

// The page warmer renders a list of product URLs on a timer so a visitor never
// lands on a cold tour page. That is only worth anything if the URLs it warms
// are the URLs the catalogue actually links to — warming /tour/x while the
// catalogue links to /tour/y is invisible in review and leaves every real page
// cold. Both now come from tourPath(); this is what stops them drifting apart.
test("the links the catalogue renders are exactly the paths tourPath produces", () => {
  const rows = [tour, pkg];
  const rendered = [...catalogueListHtml(rows).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rendered, rows.map(tourPath));
});

test("a title that slugifies to nothing still yields one usable path, not a broken link", () => {
  // An Arabic title, or one made entirely of stop-words. tourSlug has a
  // fallback for exactly this; the catalogue markup must use the same one.
  const odd = { id: "tour_x", type: "day_tour", title: "The And Of", city: "Cairo" };
  const [href] = [...catalogueListHtml([odd]).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(href, tourPath(odd));
  assert.match(href, /^\/tour\/[a-z0-9-]+$/, "must be a clean, linkable path");
});
