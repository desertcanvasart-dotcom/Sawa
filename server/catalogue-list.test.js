// The /itineraries body is built from a memoised, narrow query rather than
// SELECT * — Server-Timing had it at 981ms, the whole remaining cost of a cold
// render. These cover the seam that change created: the markup now takes rows
// directly, and passing it the query result instead of the rows is the mistake
// that is easy to make and impossible to see without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { catalogueListHtml } from "./seo.js";

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
  assert.match(html, /from \$55\/person/);
});

test("break_price wins over published_rate, and a missing one falls back", () => {
  assert.match(catalogueListHtml([tour]), /from \$55\/person/);
  assert.match(catalogueListHtml([pkg]), /from \$900\/person/);
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
