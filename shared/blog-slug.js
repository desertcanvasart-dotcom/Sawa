// DIR-7 — the blog slug, which is NOT the tour slug.
//
// A derived duplication catalogue found this declared twice: server/app.js and
// src/AdminDashboard.jsx, character-for-character identical except that the
// server appended `|| "post"` and the admin did not. So for a post whose title
// slugifies to nothing, the admin previewed an empty slug and the server stored
// "post" — the preview lied, quietly, about the URL the article would live at.
//
// Deliberately a SEPARATE rule from tourSlug rather than a reuse of it. A tour
// slug drops stop-words and appends the origin city, because it is a
// keyword-bearing landing page. A blog slug must round-trip an editor's chosen
// title, so it keeps every word and caps the length. Two rules that look alike
// and must not be merged; recorded here so nobody merges them later.
//
// In its own file rather than in shared/slug.js because site/assets/slug.js is
// GENERATED from that module and served to every visitor. Nothing on a public
// page writes a blog slug, and shipping admin-only logic to every reader is a
// cost with no benefit.
const BLOG_SLUG_MAX = 80;

export function blogSlug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BLOG_SLUG_MAX) || "post";
}
