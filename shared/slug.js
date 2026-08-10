// DIR-8 — the one definition of a tour's public URL.
//
// The public URL for a tour is derived from its title (+ origin city), so both
// existing and future tours get clean, keyword-rich URLs with NO database change.
//
// This header used to read: "The same logic is mirrored on the frontend
// (src/main.jsx) and in the static site scripts (site/index.html,
// site/departures.html) — keep them in sync."
//
// Both halves were wrong by the time anyone read it. src/main.jsx had stopped
// mirroring and started importing. And there were EIGHT static copies, not two —
// the three board pages and all five destination pages, in two different naming
// conventions, because they were copied at different times by hand.
//
// The five destination pages carried the PRE-FIX version: for a title that
// slugifies to nothing they emitted "-from-cairo", or a raw id-shaped slug that
// the legacy-URL redirect rewrites to itself. A 301 loop, which browsers cache
// permanently. Masked only by every live title happening to contain a
// non-stop-word ASCII token, which nothing enforces.
//
// So there is no "keep them in sync" any more. The static pages load
// site/assets/slug.js, generated from this file by scripts/sync-slug.js, and
// check:slug fails if it is stale.
//
//   /tour/giza-pyramids-sphinx-grand-egyptian-museum-from-cairo
//   /package/egypt-in-depth-9-day-nile-cruise-cairo

const STOP = new Set(["the", "a", "an", "of", "and", "or"]);
const CITY_WORD = { Cairo: "cairo", Luxor: "luxor", Aswan: "aswan" };

// Lowercase, strip accents, drop small stop-words, hyphenate.
export function slugify(s) {
  return String(s || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join("-");
}

// Full slug for a product row/object. Accepts either DB rows (title, city, type)
// or mapped products (title, city, type) — both expose the same fields.
export function tourSlug(p) {
  const isPkg = (p.type || "day_tour") === "package";
  let slug = slugify(p.title);
  // Qualify only a slug that actually exists. Appending to an empty one gives
  // the malformed "-from-cairo" for any title that slugifies to nothing —
  // an Arabic title, or one made entirely of stop-words.
  if (slug && !isPkg && p.city) {
    const c = CITY_WORD[p.city] || slugify(p.city);
    if (c && slug.indexOf(c) < 0) slug += "-from-" + c;
  }
  if (slug) return slug;
  // Falling back to the raw id emitted an id-shaped slug (tour_… / pkg_…), and
  // the legacy-URL redirect in app.js rewrites exactly those to their slug —
  // i.e. to themselves. That is a 301 loop, which browsers cache permanently.
  // Every part below goes through slugify, which drops underscores, so the
  // result can never be mistaken for an id again.
  const idPart = slugify(String(p.id || "").replace(/^(tour|pkg)_/, ""));
  return [slugify(p.city), isPkg ? "package" : "tour", idPart].filter(Boolean).join("-") || "tour";
}

export function tourPath(p) {
  const kind = (p.type || "day_tour") === "package" ? "package" : "tour";
  return "/" + kind + "/" + tourSlug(p);
}
