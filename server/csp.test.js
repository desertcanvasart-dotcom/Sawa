// S06 — the Content Security Policy (server/csp.js), report-only until
// CSP_ENFORCE=true. Its source lists were checked in Chromium with the policy
// ENFORCED on 15 routes (static pages and SPA, cookies accepted so GTM loads):
// no violations, while a planted off-site <script> and fetch were both caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cspHeader, cspHeaderName, describeViolation, firstSighting, CSP_DIRECTIVES } from "./csp.js";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
const directive = (h, name) => h.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));

test("scripts and connections only from this site and the services it uses", () => {
  const h = cspHeader("/");
  assert.equal(directive(h, "script-src"), "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com");
  assert.match(directive(h, "connect-src"), /^connect-src 'self' https:\/\/\*\.supabase\.co /);
  assert.equal(directive(h, "object-src"), "object-src 'none'");
  assert.equal(directive(h, "base-uri"), "base-uri 'self'");
  assert.equal(directive(h, "form-action"), "form-action 'self' mailto:", "the contact form's mailto: still works");
  assert.match(h, /report-uri \/api\/csp-report; report-to csp$/);
  assert.ok(!Object.values(CSP_DIRECTIVES).flat().includes("*"), "no wildcard source anywhere by default");
});

test("only the widget may be framed by other sites", () => {
  assert.equal(directive(cspHeader("/"), "frame-ancestors"), "frame-ancestors 'self'");
  assert.equal(directive(cspHeader("/tour/x"), "frame-ancestors"), "frame-ancestors 'self'");
  assert.equal(directive(cspHeader("/embed/tour/x"), "frame-ancestors"), "frame-ancestors *");
  assert.equal(directive(cspHeader("/embedded-page"), "frame-ancestors"), "frame-ancestors 'self'", "a prefix is not /embed");
});

test("report-only until CSP_ENFORCE=true", () => {
  delete process.env.CSP_ENFORCE;
  assert.equal(cspHeaderName(), "Content-Security-Policy-Report-Only");
  process.env.CSP_ENFORCE = "true";
  try { assert.equal(cspHeaderName(), "Content-Security-Policy"); } finally { delete process.env.CSP_ENFORCE; }
});

test("both report formats are read; each distinct violation is logged once", () => {
  const legacy = { "csp-report": { "document-uri": "https://sawa.tours/tour/x?date=1", "violated-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js" } };
  const modern = [{ type: "csp-violation", body: { documentURL: "https://sawa.tours/", effectiveDirective: "connect-src", blockedURL: "https://evil.example/s" } }, { type: "deprecation", body: {} }];
  const [a] = describeViolation(legacy);
  assert.deepEqual(a, { directive: "script-src-elem", blocked: "https://evil.example/x.js", page: "/tour/x" });
  const m = describeViolation(modern);
  assert.equal(m.length, 1, "non-CSP reports are ignored");
  assert.deepEqual(m[0], { directive: "connect-src", blocked: "https://evil.example/s", page: "/" });
  assert.deepEqual(describeViolation({ junk: true }), []);
  assert.equal(firstSighting(a), true);
  assert.equal(firstSighting(a), false, "the same violation again is not logged again");
});

test("every page response carries the policy; the API doesn't; reports are received", () => {
  assert.match(app, /if \(!req\.path\.startsWith\("\/api\/"\)\) \{\s*res\.setHeader\(cspHeaderName\(\), cspHeader\(req\.path\)\);/);
  assert.match(app, /app\.post\("\/api\/csp-report",/);
  // Set after the /embed middleware, so an enforced policy keeps the embed's frame-ancestors.
  assert.ok(app.indexOf('res.setHeader("Content-Security-Policy", "frame-ancestors *;")') < app.indexOf("res.setHeader(cspHeaderName(), cspHeader(req.path))"));
});
