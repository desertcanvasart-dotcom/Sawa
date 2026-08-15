// The sanitizer learned three tags for the blog (15 Aug 2026): img, figure,
// figcaption. These pin the boundary that made that safe to allow.
//
// Rich-text HTML is written by semi-trusted roles and rendered with
// dangerouslySetInnerHTML in staff and public browsers. An <img> is the one
// new tag with a side effect: its src is a request every reader's browser
// makes. So the rule is not "images are allowed" — it is "OUR images are
// allowed": a site-relative /images/ path, and nothing else. A remote URL is
// a tracking pixel anyone with a listing editor could plant.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanHtml } from "./sanitize.js";

test("a captioned local image survives sanitization intact", () => {
  const html = cleanHtml(
    `<figure><img src="/images/blog/meidum-pyramid.jpg" alt="The stepped core of the Meidum pyramid" title="Meidum" loading="lazy" width="1800" height="906"><figcaption>Meidum, the false pyramid.</figcaption></figure>`);
  assert.match(html, /<figure>/);
  assert.match(html, /src="\/images\/blog\/meidum-pyramid\.jpg"/);
  assert.match(html, /alt="The stepped core of the Meidum pyramid"/);
  assert.match(html, /<figcaption>Meidum, the false pyramid\.<\/figcaption>/);
});

test("a remote image is dropped whole, not partially", () => {
  for (const src of ["https://evil.example/pixel.gif", "http://x.test/a.jpg",
    "//evil.example/pixel.gif", "javascript:alert(1)", "data:image/png;base64,AAAA",
    "/images/../secrets.txt notquite", ""]) {
    const html = cleanHtml(`<p>before</p><img src="${src}" alt="x"><p>after</p>`);
    assert.ok(!html.includes("<img"), `img with src=${JSON.stringify(src)} survived`);
    assert.match(html, /before/);
    assert.match(html, /after/);
  }
});

test("an image cannot carry handlers or scripts", () => {
  const html = cleanHtml(`<img src="/images/blog/x.jpg" alt="x" onerror="alert(1)" style="position:fixed">`);
  assert.ok(!html.includes("onerror"), "event handler survived");
  assert.ok(!html.includes("style"), "style attribute survived");
});
