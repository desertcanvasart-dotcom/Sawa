// Canonical host redirect: www.sawatours.org -> sawatours.org.
//
// Both hostnames point at this app (the apex via an ALIAS record, www via a
// CNAME), so without this every page is reachable at two URLs. Search engines
// treat those as separate pages competing with each other, and the JSON-LD in
// seo.js hardcodes the apex in BRAND.url, so the two would disagree.
//
// This deliberately lives in the app rather than in the registrar's "URL
// Redirect" feature: that feature conflicts with the CNAME the host needs, and
// its HTTPS support is unreliable. Railway terminates TLS for both names, then
// this issues a real 301.
//
// Set CANONICAL_HOST to enable (e.g. "sawatours.org"). Unset — local dev,
// preview deploys, tests — nothing redirects.

// Returns the absolute URL to redirect to, or null to let the request through.
// `host` is the request's Host header (may include a port), `url` the full
// original path + query.
export function canonicalRedirect(host, url, canonicalHost = process.env.CANONICAL_HOST) {
  if (!canonicalHost) return null;
  const raw = String(host || "").trim().toLowerCase();
  if (!raw) return null;
  // Strip the port before comparing: "www.example.com:8080" must still match.
  const hostname = raw.replace(/:\d+$/, "");
  const target = String(canonicalHost).trim().toLowerCase().replace(/:\d+$/, "");
  if (!hostname.startsWith("www.")) return null;
  // Only redirect the www form OF THE CANONICAL HOST. A request arriving with
  // some other www hostname isn't ours to rewrite onto our domain.
  if (hostname.slice(4) !== target) return null;
  return `https://${target}${url || "/"}`;
}
