import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPathRedirect } from "./path-canonical.js";

test("removes trailing slashes while preserving query parameters", () => {
  assert.equal(canonicalPathRedirect("/destinations/"), "/destinations");
  assert.equal(canonicalPathRedirect("/destinations/?ref=nav"), "/destinations?ref=nav");
  assert.equal(canonicalPathRedirect("/"), null);
});

test("removes the obsolete literal SearchAction placeholder", () => {
  assert.equal(
    canonicalPathRedirect("/itineraries?q=%7Bsearch_term_string%7D"),
    "/itineraries"
  );
  assert.equal(
    canonicalPathRedirect("/itineraries?q={search_term_string}&ref=google"),
    "/itineraries?ref=google"
  );
});

test("keeps real itinerary searches and canonical paths unchanged", () => {
  assert.equal(canonicalPathRedirect("/itineraries?q=luxor"), null);
  assert.equal(canonicalPathRedirect("/destinations"), null);
});
