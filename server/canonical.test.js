// Unit tests for the canonical-host redirect. Pure — no DB, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRedirect } from "./canonical.js";

const HOST = "sawatours.org";

test("redirects www to the apex, preserving path and query", () => {
  assert.equal(canonicalRedirect("www.sawatours.org", "/", HOST), "https://sawatours.org/");
  assert.equal(
    canonicalRedirect("www.sawatours.org", "/tour/giza-pyramids-from-cairo", HOST),
    "https://sawatours.org/tour/giza-pyramids-from-cairo"
  );
  assert.equal(
    canonicalRedirect("www.sawatours.org", "/tours?q=luxor&sort=price", HOST),
    "https://sawatours.org/tours?q=luxor&sort=price"
  );
});

test("leaves the apex alone — no redirect loop", () => {
  // The apex must never redirect to itself; a cached 301 loop is unrecoverable
  // from the browser's side.
  assert.equal(canonicalRedirect("sawatours.org", "/", HOST), null);
  assert.equal(canonicalRedirect("sawatours.org", "/tours", HOST), null);
});

test("is a no-op when CANONICAL_HOST is unset", () => {
  // Local dev, preview deploys and tests must not be redirected to production.
  assert.equal(canonicalRedirect("www.sawatours.org", "/", undefined), null);
  assert.equal(canonicalRedirect("www.sawatours.org", "/", ""), null);
});

test("ignores ports and case in the Host header", () => {
  assert.equal(canonicalRedirect("WWW.SawaTours.org", "/", HOST), "https://sawatours.org/");
  assert.equal(canonicalRedirect("www.sawatours.org:8080", "/", HOST), "https://sawatours.org/");
  assert.equal(canonicalRedirect("localhost:5173", "/", HOST), null);
});

test("only rewrites the www form of our own host", () => {
  // A Host header we don't own must not be bounced onto our domain — that would
  // turn the app into an open redirect for anyone who can set Host.
  assert.equal(canonicalRedirect("www.evil.example", "/", HOST), null);
  assert.equal(canonicalRedirect("www.sawatours.org.evil.example", "/", HOST), null);
  assert.equal(canonicalRedirect("wwwsawatours.org", "/", HOST), null);
});

test("tolerates a missing or empty host", () => {
  assert.equal(canonicalRedirect(undefined, "/", HOST), null);
  assert.equal(canonicalRedirect("", "/", HOST), null);
});

test("defaults an empty url to the site root", () => {
  assert.equal(canonicalRedirect("www.sawatours.org", "", HOST), "https://sawatours.org/");
});
