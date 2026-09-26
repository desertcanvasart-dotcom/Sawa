// S06 — the Content Security Policy (server/csp.js), report-only until
// CSP_ENFORCE=true. Its source lists were checked in Chromium with the policy
// ENFORCED on 15 routes (static pages and SPA, cookies accepted so GTM loads):
// no violations, while a planted off-site <script> and fetch were both caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cspHeader, cspHeaderName, describeViolation, firstSighting, CSP_DIRECTIVES, inlineScripts, scriptHash, siteScriptHashes } from "./csp.js";
import { dataScript } from "./inline-json.js";
import { readInlineData } from "../src/inline-data.js";

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
const directive = (h, name) => h.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));

test("scripts and connections only from this site and the services it uses", () => {
  const h = cspHeader("/");
  assert.match(directive(h, "script-src"), /^script-src 'self' 'unsafe-inline' https:\/\/www\.googletagmanager\.com( 'sha256-[A-Za-z0-9+/]+=*')+$/,
    "sources, then only hashes: a browser that reads hashes ignores 'unsafe-inline'");
  assert.match(directive(h, "connect-src"), /^connect-src 'self' https:\/\/\*\.supabase\.co /);
  assert.equal(directive(h, "object-src"), "object-src 'none'");
  assert.equal(directive(h, "base-uri"), "base-uri 'self'");
  assert.equal(directive(h, "form-action"), "form-action 'self' mailto:", "the contact form's mailto: still works");
  assert.match(h, /report-uri \/api\/csp-report; report-to csp$/);
  assert.ok(!Object.values(CSP_DIRECTIVES).flat().includes("*"), "no wildcard source anywhere by default");
});

test("the portal may frame the site's own widget, and nothing else new", () => {
  assert.equal(directive(cspHeader("/portal/widget"), "frame-src"), "frame-src 'self' https://*.supabase.co https://www.googletagmanager.com");
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

// ---- inline scripts: hashes, not 'unsafe-inline' ----------------------------

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const sitePages = (dir = SITE, out = []) => {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) { if (!e.startsWith("_")) sitePages(f, out); } else if (e.endsWith(".html")) out.push(f);
  }
  return out;
};

test("every inline script a static page carries is allowed by its hash", () => {
  const h = directive(cspHeader("/"), "script-src");
  const pages = sitePages();
  assert.ok(pages.length > 15, "the static pages were found");
  let n = 0;
  for (const f of pages) {
    for (const body of inlineScripts(readFileSync(f, "utf8"))) {
      n += 1;
      assert.ok(h.includes(scriptHash(body)), `${f}: an inline script has no hash in the policy — the browser would refuse it`);
    }
  }
  assert.ok(n > 0, "inline scripts were found to check");
});

test("a hash covers exactly one script body", () => {
  // The value browsers compute: base64 SHA-256 of the text between the tags.
  assert.equal(scriptHash("alert(1)"), "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
  assert.notEqual(scriptHash("alert(1)"), scriptHash("alert(1) "));
  const hashes = siteScriptHashes([]);
  assert.deepEqual(hashes, [], "no files, no hashes — nothing is allowed by default");
});

test("data blocks, JSON-LD and external scripts are not treated as inline scripts", () => {
  const html = `<script src="/a.js"></script><script type="application/ld+json">{"a":1}</script>` +
    `${dataScript("x", { a: 1 })}<script>run()</script><script type="module">go()</script>`;
  assert.deepEqual(inlineScripts(html), ["run()", "go()"]);
});

test("no static page carries an inline event handler (the policy does not allow them)", () => {
  const pages = sitePages();
  assert.ok(pages.length > 0);
  for (const f of pages) {
    const html = readFileSync(f, "utf8").replace(/<script[\s\S]*?<\/script>/gi, (m) => m.replace(/on\w+=/g, ""));
    assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, f);
  }
  // Nor markup that a page's own script builds.
  for (const f of pages) assert.doesNotMatch(readFileSync(f, "utf8"), /['"]\s*on(click|error|load)=/, f);
});

test("the server's inlined data is a JSON block the page reads back intact", () => {
  const payload = { title: "Nasty </script><script>alert(1)</script>", n: 2 };
  const html = dataScript("sawa-bootstrap", payload);
  assert.match(html, /^<script type="application\/json" id="sawa-bootstrap">/);
  assert.equal(inlineScripts(html).length, 0, "never an executable script");
  const body = html.slice(html.indexOf(">") + 1, html.indexOf("</script>"));
  const doc = { getElementById: (id) => (id === "sawa-bootstrap" ? { textContent: body } : null) };
  assert.deepEqual(readInlineData("sawa-bootstrap", doc), payload);
  assert.equal(readInlineData("missing", doc), null);
  assert.equal(readInlineData("bad", { getElementById: () => ({ textContent: "{not json" }) }), null);
  assert.ok(!/window\.__SAWA_(BOOTSTRAP|BLOG_POST)__\s*=/.test(app), "the executable form is gone from the server");
});
