// U06 — the public /widget and /operators pages told partners to load
// https://embed.sawatours.com/v1.js (a host that does not exist) with options
// (data-region, data-accent, data-limit, data-layout) nothing implements. The
// real widget is the iframe the dashboard's Promote section generates. The
// public snippet is now that same snippet, and this keeps the two identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const dashboard = read("src", "AgencyDashboard.jsx");
const EMBED_SCRIPT = /const EMBED_SCRIPT = `([\s\S]*?)`;/.exec(dashboard)[1].replace("<\\/script>", "</script>");

// The text a visitor copies: tags stripped, entities decoded.
const unescape = (s) => s.replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const snippet = (page, id) => {
  const s = read("site", page);
  const a = s.indexOf(`<span id="${id}">`);
  assert.ok(a > 0, `${page}: snippet block #${id} not found`);
  return unescape(s.slice(a, s.indexOf("</span></div>", a)));
};

const PAGES = [["widget.html", "snip2"], ["operators.html", "snippet"]];

test("the published snippet is the one the dashboard generates", () => {
  assert.match(dashboard, /const iframe = \(src\) => `<iframe src="\$\{SITE\}\$\{src\}" style="width:100%;border:0;border-radius:18px" loading="lazy" data-sawa-embed><\/iframe>`;/,
    "the dashboard's iframe shape changed — update the public pages to match");
  for (const [page, id] of PAGES) {
    const text = snippet(page, id);
    assert.ok(text.includes('<iframe src="https://sawa.tours/embed?ref=YOUR-CODE" style="width:100%;border:0;border-radius:18px" loading="lazy" data-sawa-embed></iframe>'), `${page}: iframe`);
    assert.ok(text.includes(EMBED_SCRIPT), `${page}: the resize/theme script differs from the dashboard's`);
  }
});

test("no page advertises the loader or options that do not exist", () => {
  for (const [page] of PAGES) {
    const s = read("site", page);
    for (const bad of ["sawatours.com", "v1.js", "data-region", "data-accent", "data-limit", "data-layout", "npm package"]) {
      assert.ok(!s.includes(bad), `${page} still mentions ${bad}`);
    }
  }
});
