// Canonical SEO/GEO-friendly slugs for tour products.
//
// The public URL for a tour is derived from its title (+ origin city), so both
// existing and future tours get clean, keyword-rich URLs with NO database change.
// The same logic is mirrored on the frontend (src/main.jsx) and in the static
// site scripts (site/index.html, site/departures.html) — keep them in sync.
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
  if (!isPkg && p.city) {
    const c = CITY_WORD[p.city] || slugify(p.city);
    if (c && slug.indexOf(c) < 0) slug += "-from-" + c;
  }
  return slug || String(p.id || "");
}

export function tourPath(p) {
  const kind = (p.type || "day_tour") === "package" ? "package" : "tour";
  return "/" + kind + "/" + tourSlug(p);
}
