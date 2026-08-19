// The footer, its stylesheet and the scroll reveal each used to exist in nine
// to twenty copies. Consolidating them is only worth anything if they stay
// consolidated, and drift here is silent: a page keeps rendering perfectly
// while quietly missing the link, rule or fix that every other page got.
//
// These are the assertions that make that loud.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pages, partial, checkPage } from "../scripts/sync-partials.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = (f) => relative(root, f);
const read = (f) => readFileSync(f, "utf8");

test("every page carries the footer exactly as site/_partials/footer.html has it", () => {
  const footer = partial("footer");
  const drifted = pages().filter((f) => !checkPage(read(f), footer).ok).map(name);
  assert.deepEqual(drifted, [], `run \`node scripts/sync-partials.js\` — drifted: ${drifted.join(", ")}`);
});

test("every page loads the shared stylesheet, ahead of its own styles", () => {
  for (const file of pages()) {
    const html = read(file);
    const shared = html.indexOf("/assets/shared.css");
    assert.notEqual(shared, -1, `${name(file)} does not load /assets/shared.css`);

    // Later rules of equal specificity win, so a page's own styles must come
    // after the shared ones or it cannot override them.
    const own = html.indexOf("<style>");
    if (own !== -1) assert.ok(shared < own, `${name(file)} loads shared.css after its own <style>`);
    const sawa = html.indexOf("/assets/sawa.css");
    if (sawa !== -1) assert.ok(shared < sawa, `${name(file)} loads shared.css after sawa.css`);
  }
});

test("the footer and reveal rules are defined once, in shared.css", () => {
  // DIR-14 — a loop is a claim about every member and says nothing about
  // whether there are any. This test is worthless on an empty set.
  assert.ok(pages().length > 10, `only ${pages().length} pages`);
  // One rule from each group is enough to catch a copy coming back.
  const owned = [".fbot{", ".fcol a{", ".socials{", ".rv{"];
  const shared = read(join(root, "site/assets/shared.css"));
  for (const rule of owned) assert.ok(shared.includes(rule), `shared.css is missing ${rule}`);

  // sawa.css in full; the pages only inside their own <style> blocks, so a
  // class name appearing in the markup is not mistaken for a rule.
  const sawa = read(join(root, "site/assets/sawa.css"));
  for (const rule of owned) assert.ok(!sawa.includes(rule), `site/assets/sawa.css still defines ${rule}`);

  for (const file of pages()) {
    const css = (read(file).match(/<style>[\s\S]*?<\/style>/g) || []).join("\n");
    for (const rule of owned) {
      assert.ok(!css.includes(rule), `${name(file)} still defines ${rule} — it belongs in shared.css`);
    }
  }
});

test("the scroll reveal is implemented once, in sawa.js, and every page loads it", () => {
  const js = read(join(root, "site/assets/sawa.js"));
  assert.ok(js.includes("IntersectionObserver"), "sawa.js should own the reveal observer");

  for (const file of pages()) {
    const html = read(file);
    assert.ok(html.includes("/assets/sawa.js"), `${name(file)} does not load /assets/sawa.js`);
    assert.ok(
      !html.includes("IntersectionObserver"),
      `${name(file)} has its own reveal observer — the shared one in sawa.js is the one that gets fixed`
    );
  }
});

test("Google Tag Manager is on every page, from one file, and waits for consent", () => {
  // Google's snippet is meant to be pasted into every head. Pasted here it
  // would put the container ID in twenty-one places, and — the part that
  // matters more — it would load GTM on sight, firing the container's tags
  // before anyone had been asked. site/cookies.html says analytics does not
  // run until you accept it, so a self-loading GTM would make that page false.
  const gtm = read(join(root, "site/assets/gtm.js"));
  assert.ok(gtm.includes("GTM-MJNDLPKG"), "gtm.js should own the container ID");
  assert.ok(
    gtm.includes("window.sawaConsent") && gtm.includes("onChange"),
    "gtm.js must load the container through a consent decision, not on sight"
  );

  const shell = read(join(root, "index.html"));
  assert.ok(
    shell.includes("googletagmanager.com/ns.html?id=GTM-MJNDLPKG"),
    "the SPA shell carries the <noscript> half — buildHead() cannot reach the body"
  );

  for (const file of pages()) {
    const html = read(file);
    const consent = html.indexOf("/assets/consent.js");
    const gtmTag = html.indexOf('<script defer src="/assets/gtm.js"></script>');
    assert.notEqual(gtmTag, -1, `${name(file)} does not load gtm.js, or loads it without defer`);
    assert.ok(consent < gtmTag, `${name(file)} loads gtm.js before consent.js`);
    assert.ok(
      !html.includes("googletagmanager.com/gtm.js"),
      `${name(file)} inlines Google's loader — the container ID belongs in gtm.js alone`
    );
    // The <noscript> half cannot be gated: no script runs in the case it
    // exists for. It has to be in the page itself.
    assert.ok(
      html.includes("googletagmanager.com/ns.html?id=GTM-MJNDLPKG"),
      `${name(file)} is missing the GTM <noscript> iframe`
    );
  }
});

test("consent runs before analytics on every page, and neither blocks rendering", () => {
  for (const file of pages()) {
    const html = read(file);
    const consent = html.indexOf("/assets/consent.js");
    const analytics = html.indexOf("/assets/analytics.js");
    assert.notEqual(consent, -1, `${name(file)} does not load consent.js`);
    assert.notEqual(analytics, -1, `${name(file)} does not load analytics.js`);
    assert.ok(consent < analytics, `${name(file)} loads analytics.js before consent.js`);
    assert.ok(
      html.includes('<script defer src="/assets/consent.js">'),
      `${name(file)} loads consent.js without defer`
    );
  }
});
