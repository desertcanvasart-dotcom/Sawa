// JJ3 / P3.4 — nothing that looks like data may ship in the markup.
//
// The two strings this guards were not bugs in the rendering logic. They were
// SHIPPED, hand-written into site/index.html: "Loading…" as the board count and
// a literal 0 in "0 more forming this month". A visitor with a slow connection,
// a blocked script or a failed API saw both, indefinitely, and neither is
// distinguishable from a real answer.
//
// A rendering fix does not stop someone typing them back into the template, so
// the template is what is asserted here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (f) => readFileSync(join(siteDir, f), "utf8");

// Only the markup, not the scripts: the scripts legitimately contain the words
// that build these strings once a real number is known.
function markupOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

test("the homepage ships no loading text and no placeholder count", () => {
  const markup = markupOf(read("index.html"));

  assert.ok(!/Loading/i.test(markup), 'the served markup contains "Loading"');
  assert.ok(
    !/>\s*0\s*<\/b>/.test(markup),
    "the served markup contains a hard-coded 0 inside a count element"
  );
  assert.ok(
    !/\bmore forming this month\b/.test(markup),
    "the board footer's sentence ships in the markup; it must be written only when the count is above zero"
  );
});

test("the board count and footer are present, empty, and addressable", () => {
  // The guard against the wrong repair: deleting the elements would satisfy the
  // test above and leave the script writing into nothing.
  const html = read("index.html");
  assert.match(html, /data-board-count/, "the board count element is gone");
  assert.match(html, /data-board-more[^>]*hidden/, "the footer must ship hidden, not merely empty");
  assert.match(html, /class="sk sk-cnt"/, "the count must ship as a skeleton, not as text");
});

test("both boards offer State A's two actions, and neither invents a destination", () => {
  // State A is only honest if its actions work. "Tell me when a group forms"
  // points at /contact because no alerts capture exists yet; if that href ever
  // points somewhere unbuilt, this fails.
  for (const file of ["index.html", "departures.html"]) {
    const html = read(file);
    assert.match(html, /Start a date/, `${file}: State A is missing its primary action`);
    // The anchor itself, not "the words appear somewhere near an href" — the
    // first draft of this matched a code comment that happened to quote both.
    assert.match(
      html,
      /<a href="\/contact"[^>]*>Tell me when a group forms<\/a>/,
      `${file}: the alert action must be an anchor pointing at a channel that exists`
    );
  }
});
