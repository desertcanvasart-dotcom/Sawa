// DIR-8 — moved to shared/slug.js, which the browser and the generated static
// copy also read. Re-exported here because server/, src/ and the tests all
// import from this path, and a move that renames every call site is a move
// nobody reviews.
export { slugify, tourSlug, tourPath } from "../shared/slug.js";
