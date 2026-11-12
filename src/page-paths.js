// Which page a path is, and whether that page shows the catalogue
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.


// Which routes actually resolve to tour cards? Only these earn the catalogue
// skeleton while the bootstrap loads — everything else (legal pages, the contact
// page, a mistyped URL heading for the 404) gets a page-neutral loader.
function showsCatalogue(p) {
  const clean = (p || "/").replace(/\/+$/, "") || "/";
  return clean === "/" || clean === "/itineraries" || clean === "/tours" || clean === "/packages"
    || clean.startsWith("/tour/") || clean.startsWith("/package/");
}

function pageFromPath(p) {
  const clean = (p || "/").replace(/\/+$/, "") || "/";
  // /itineraries is the canonical catalogue URL; /tours and /packages are
  // legacy aliases the server 301s, kept here so a client-side hit still lands.
  if (clean === "/itineraries" || clean === "/tours" || clean === "/packages") return "tours";
  if (clean === "/how-it-works") return "how";
  if (clean === "/about") return "about";
  if (clean === "/contact") return "contact";
  if (clean === "/faq") return "faq";
  if (clean === "/privacy") return "privacy";
  if (clean === "/terms") return "terms";
  if (clean === "/booking" || clean.startsWith("/booking/")) return "booking";
  if (clean === "/blog") return "blog";
  if (clean.startsWith("/blog/")) return "blogpost";
  if (clean === "/partners") return "partners";
  if (clean === "/") return "home";
  return "404";
}

export {
  showsCatalogue, pageFromPath,
};
