// Collapse crawler-only URL variants onto the public canonical path.
// Returns a relative redirect target, or null when the request is already
// canonical. Keeping this pure makes the redirect rules easy to verify.
export function canonicalPathRedirect(originalUrl = "/") {
  let url;
  try {
    url = new URL(originalUrl, "https://sawa.tours");
  } catch {
    return null;
  }

  let changed = false;
  const html = /^\/([a-z0-9][a-z0-9\-/]*)\.html$/i.exec(url.pathname);
  if (html) {
    const raw = html[1].toLowerCase();
    const aliases = {
      index: "/",
      tour: "/itineraries",
      pricing: "/operators",
      trust: "/goahead-promise",
    };
    if (aliases[raw]) {
      url.pathname = aliases[raw];
    } else if (raw.endsWith("/index")) {
      url.pathname = `/${raw.slice(0, -"/index".length)}`;
    } else {
      url.pathname = `/${raw}`;
    }
    changed = true;
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
    changed = true;
  }

  // Older WebSite/SearchAction markup advertised this template. Some crawlers
  // requested the placeholder literally and indexed it as an alternate page.
  // Real visitor searches remain query-driven; only the template value is
  // discarded.
  if (url.pathname === "/itineraries" && url.searchParams.get("q") === "{search_term_string}") {
    url.searchParams.delete("q");
    changed = true;
  }

  return changed ? `${url.pathname}${url.search}` : null;
}
