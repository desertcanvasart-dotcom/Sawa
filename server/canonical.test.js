// Unit tests for the canonical-host redirect. Pure — no DB, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRedirect } from "./canonical.js";

const HOST = "sawa.tours";
const LEGACY = "sawatours.org";

test("redirects www to the apex, preserving path and query", () => {
  assert.equal(canonicalRedirect("www.sawa.tours", "/", HOST), "https://sawa.tours/");
  assert.equal(
    canonicalRedirect("www.sawa.tours", "/tour/giza-pyramids-from-cairo", HOST),
    "https://sawa.tours/tour/giza-pyramids-from-cairo"
  );
  assert.equal(
    canonicalRedirect("www.sawa.tours", "/tours?q=luxor&sort=price", HOST),
    "https://sawa.tours/tours?q=luxor&sort=price"
  );
});

test("redirects the retired domain, preserving path and query", () => {
  // The whole point of the migration: every old URL lands on its counterpart,
  // not on the homepage. Sending them all to "/" would drop the rankings of
  // every page except the front one.
  assert.equal(canonicalRedirect("sawatours.org", "/", HOST, LEGACY), "https://sawa.tours/");
  assert.equal(
    canonicalRedirect("sawatours.org", "/departures", HOST, LEGACY),
    "https://sawa.tours/departures"
  );
  assert.equal(
    canonicalRedirect("sawatours.org", "/tour/giza-pyramids-from-cairo?ref=partner", HOST, LEGACY),
    "https://sawa.tours/tour/giza-pyramids-from-cairo?ref=partner"
  );
});

test("redirects the retired domain's www form too", () => {
  // Listing only the apex in LEGACY_HOSTS must still catch www — otherwise the
  // fourth hostname keeps serving a competing copy of every page.
  assert.equal(
    canonicalRedirect("www.sawatours.org", "/faq", HOST, LEGACY),
    "https://sawa.tours/faq"
  );
});

test("accepts several retired domains", () => {
  const legacy = "sawatours.org, oldsawa.example";
  assert.equal(canonicalRedirect("oldsawa.example", "/x", HOST, legacy), "https://sawa.tours/x");
  assert.equal(canonicalRedirect("www.oldsawa.example", "/x", HOST, legacy), "https://sawa.tours/x");
  assert.equal(canonicalRedirect("sawatours.org", "/x", HOST, legacy), "https://sawa.tours/x");
});

test("leaves the canonical host alone — no redirect loop", () => {
  // The canonical host must never redirect to itself; a cached 301 loop is
  // unrecoverable from the browser's side.
  assert.equal(canonicalRedirect("sawa.tours", "/", HOST, LEGACY), null);
  assert.equal(canonicalRedirect("sawa.tours", "/tours", HOST, LEGACY), null);
});

test("is a no-op when CANONICAL_HOST is unset", () => {
  // Local dev, preview deploys and tests must not be redirected to production.
  assert.equal(canonicalRedirect("www.sawa.tours", "/", undefined), null);
  assert.equal(canonicalRedirect("www.sawa.tours", "/", ""), null);
  assert.equal(canonicalRedirect("sawatours.org", "/", undefined, LEGACY), null);
});

test("ignores ports and case in the Host header", () => {
  assert.equal(canonicalRedirect("WWW.Sawa.Tours", "/", HOST), "https://sawa.tours/");
  assert.equal(canonicalRedirect("www.sawa.tours:8080", "/", HOST), "https://sawa.tours/");
  assert.equal(canonicalRedirect("SawaTours.ORG:443", "/", HOST, LEGACY), "https://sawa.tours/");
  assert.equal(canonicalRedirect("localhost:5173", "/", HOST, LEGACY), null);
});

test("only rewrites hostnames we've claimed", () => {
  // A Host header we don't own must not be bounced onto our domain — that would
  // turn the app into an open redirect for anyone who can set Host.
  assert.equal(canonicalRedirect("www.evil.example", "/", HOST, LEGACY), null);
  assert.equal(canonicalRedirect("sawa.tours.evil.example", "/", HOST, LEGACY), null);
  assert.equal(canonicalRedirect("www.sawatours.org.evil.example", "/", HOST, LEGACY), null);
  assert.equal(canonicalRedirect("wwwsawa.tours", "/", HOST, LEGACY), null);
});

test("lets Railway's healthcheck host through", () => {
  // The platform probes /api/health on *.up.railway.app. A 301 there fails the
  // healthcheck and the deploy never goes live.
  assert.equal(canonicalRedirect("jfzqycwr.up.railway.app", "/api/health", HOST, LEGACY), null);
});

test("tolerates a missing or empty host", () => {
  assert.equal(canonicalRedirect(undefined, "/", HOST, LEGACY), null);
  assert.equal(canonicalRedirect("", "/", HOST, LEGACY), null);
});

test("defaults an empty url to the site root", () => {
  assert.equal(canonicalRedirect("www.sawa.tours", "", HOST), "https://sawa.tours/");
  assert.equal(canonicalRedirect("sawatours.org", "", HOST, LEGACY), "https://sawa.tours/");
});
