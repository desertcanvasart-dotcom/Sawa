// S06 — a Content Security Policy, in REPORT-ONLY mode.
//
// Helmet's CSP was switched off (`contentSecurityPolicy: false`), so the
// browser had no rule about where scripts, frames or connections may come
// from: an injected <script src> or an exfiltrating fetch would simply run.
//
// Report-only first, as the audit advised: the browser enforces nothing and
// POSTs what it WOULD have blocked to /api/csp-report, where it is logged.
// Once the logs are quiet on the live site, the header name switches to
// Content-Security-Policy (CSP_ENFORCE=true) — no other change.
//
// The source lists are what the site actually loads, inventoried 25 Sep 2026:
//   - scripts: this origin; Google Tag Manager / gtag (site/assets/gtm.js,
//     analytics.js); and the static pages' own inline <script>s, each allowed
//     by its SHA-256 hash (below). An injected inline script has no matching
//     hash, so it does not run. The data the server inlines (catalogue, blog
//     post) is a JSON block the browser never executes (inline-json.js
//     dataScript), and no page carries an inline event handler.
//     'unsafe-inline' is still listed, for one reason: a browser that
//     understands hashes IGNORES it when a hash is present (CSP level 2), so it
//     only affects browsers too old for hashes, which would otherwise run no
//     inline script at all.
//   - styles: this origin, inline style attributes (React and the static
//     pages use them throughout), Google Fonts' stylesheet.
//   - fonts: Google Fonts' files.
//   - images: this origin, data: (inline SVG backgrounds), blob:, the Supabase
//     storage bucket, and Google Analytics' measurement pixels.
//   - connections: this origin (the API), Supabase (auth), Google Analytics.
//   - frames: GTM's <noscript> frame only.
//   - never: plugins (object-src), a moved <base>, forms posting off-site
//     (mailto: kept for the contact form), and being framed by another site —
//     except /embed/*, which exists to be framed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE = "https://*.supabase.co";
const GOOGLE_ANALYTICS = ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com"];

// The inline scripts the site serves: every executable <script> without a src
// in site/**/*.html and the built SPA shell. Read from the files themselves at
// startup, so editing a page's script can never leave a stale hash behind; a
// deploy restarts the process. Data blocks (JSON, JSON-LD) are not scripts to
// the browser and need no hash.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;

export function inlineScripts(html) {
  const out = [];
  for (const m of String(html).matchAll(SCRIPT_RE)) {
    const attrs = m[1] || "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text\/javascript|module|application\/javascript)$/i.test(type)) continue;
    out.push(m[2]);
  }
  return out;
}

export const scriptHash = (body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

function htmlFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlFiles(full, out);
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

export function siteScriptHashes(files = [...htmlFiles(join(ROOT, "site")), join(ROOT, "dist", "index.html")]) {
  const hashes = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const body of inlineScripts(readFileSync(f, "utf8"))) hashes.add(scriptHash(body));
  }
  return [...hashes].sort();
}

let HASHES = null;
const hashes = () => (HASHES ??= siteScriptHashes());

export const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'", "https://www.googletagmanager.com"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
  "img-src": ["'self'", "data:", "blob:", SUPABASE, ...GOOGLE_ANALYTICS],
  "connect-src": ["'self'", SUPABASE, "wss://*.supabase.co", ...GOOGLE_ANALYTICS],
  "frame-src": ["https://www.googletagmanager.com"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'", "mailto:"],
  "frame-ancestors": ["'self'"],
};

export function cspHeader(path = "/") {
  const d = { ...CSP_DIRECTIVES, "script-src": [...CSP_DIRECTIVES["script-src"], ...hashes()] };
  // The widget: framed by partner sites by design (see the /embed middleware).
  if (/^\/embed(\/|$)/.test(path)) d["frame-ancestors"] = ["*"];
  const body = Object.entries(d).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
  return `${body}; report-uri /api/csp-report; report-to csp`;
}

export const cspEnforced = () => process.env.CSP_ENFORCE === "true";
export const cspHeaderName = () => (cspEnforced() ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only");

// One log line per distinct violation per process, so a page view that trips
// the same rule forty times — or a crawler hammering one page — logs once.
const seen = new Set();
const SEEN_MAX = 500;
export function describeViolation(body) {
  // Two shapes: the legacy report-uri body ({"csp-report": {...}}) and the
  // Reporting API's array of {type, body}.
  const items = Array.isArray(body)
    ? body.filter((r) => r?.type === "csp-violation").map((r) => r.body || {})
    : body?.["csp-report"] ? [body["csp-report"]] : [];
  return items.map((r) => {
    const directive = r["effective-directive"] || r.effectiveDirective || r["violated-directive"] || r.violatedDirective || "?";
    const blocked = r["blocked-uri"] || r.blockedURL || r.blockedUri || "?";
    let page = r["document-uri"] || r.documentURL || r.documentUri || "?";
    try { page = new URL(page).pathname; } catch { page = String(page).slice(0, 120); }
    return { directive: String(directive).slice(0, 60), blocked: String(blocked).slice(0, 200), page };
  });
}

export function firstSighting({ directive, blocked, page }) {
  const key = `${directive}|${blocked}|${page}`;
  if (seen.has(key)) return false;
  if (seen.size >= SEEN_MAX) return false;
  seen.add(key);
  return true;
}
