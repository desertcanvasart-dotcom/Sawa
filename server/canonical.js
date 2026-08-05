// Canonical host redirect.
//
// Several hostnames resolve to this same app — the canonical domain, its www
// form, and the previous domain the site lived on (with its own www form). Left
// alone, every page is reachable at four URLs. Search engines treat those as
// separate pages competing with each other, and the JSON-LD in seo.js hardcodes
// one host in BRAND.url, so the site would contradict itself about which URL is
// real. This collapses them onto one host with a 301.
//
// This deliberately lives in the app rather than in the registrar's "URL
// Redirect" feature: that feature conflicts with the CNAME the host needs, and
// its HTTPS support is unreliable. Railway terminates TLS for every name, then
// this issues a real 301.
//
// Configuration, both optional — unset means nothing redirects, which is what
// local dev, tests and preview deploys want:
//   CANONICAL_HOST  the one true host, e.g. "sawa.tours"
//   LEGACY_HOSTS    comma-separated hosts to retire, e.g. "sawatours.org"
//
// The www form of each configured host is handled automatically; listing it
// separately is harmless but unnecessary.

const clean = (h) => String(h || "").trim().toLowerCase().replace(/:\d+$/, "");
const bare = (h) => (h.startsWith("www.") ? h.slice(4) : h);

// Returns the absolute URL to redirect to, or null to let the request through.
// `host` is the request's Host header (may include a port), `url` the full
// original path + query.
export function canonicalRedirect(
  host,
  url,
  canonicalHost = process.env.CANONICAL_HOST,
  legacyHosts = process.env.LEGACY_HOSTS
) {
  if (!canonicalHost) return null;
  const hostname = clean(host);
  const target = clean(canonicalHost);
  if (!hostname || !target) return null;

  // Already where it should be.
  if (hostname === target) return null;

  const known = new Set([target, ...String(legacyHosts || "")
    .split(",")
    .map(clean)
    .filter(Boolean)]);

  // Only rewrite hostnames we've actually claimed — the canonical host's www
  // form, or a retired domain of ours. A request arriving on some other
  // hostname isn't ours to drag onto our domain, and Railway's own
  // *.up.railway.app healthcheck host must pass through untouched: 301-ing the
  // healthcheck would fail the deploy.
  if (!known.has(bare(hostname))) return null;

  // Path-preserving. Redirecting every old URL to the homepage instead is the
  // classic way to lose the rankings of every page except the front one.
  return `https://${target}${url || "/"}`;
}
