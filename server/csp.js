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
//     analytics.js). 'unsafe-inline' stays for now: the static pages and the
//     inlined bootstrap payload are inline <script>s, and moving them to
//     nonces is the step after this one. Even with it, a script can no longer
//     be LOADED from anywhere else, which is the common injection payload.
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
const SUPABASE = "https://*.supabase.co";
const GOOGLE_ANALYTICS = ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com"];

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
  const d = { ...CSP_DIRECTIVES };
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
