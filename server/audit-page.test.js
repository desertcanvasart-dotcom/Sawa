// OOO1.2 / NNN1 — the interface-promise rule, both halves proven.
//
// Prove it fires: the two promises that were live and unflagged.
// Prove it stops: the product descriptions that are ordinary travel prose.
//
// The second half is not decoration here. The rule's first form matched any
// "you'll see", and on its first run it flagged "you'll see the desert's famous
// mirages" and "where you'll see ancient temple-building at its best-preserved"
// — copy about what a traveller sees IN EGYPT. Shipped like that it would have
// reported two findings forever on correct copy, been baselined within a
// fortnight, and taken the real class with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERFACE_PROMISES, UK_SPELLINGS, auditOnePage } from "../scripts/audit-page.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fires = (s) => { INTERFACE_PROMISES.lastIndex = 0; return INTERFACE_PROMISES.test(s); };

test("it fires on the promises that were live and unflagged", () => {
  // Both real, both removed under OOO2, neither ever caught by audit:claims —
  // whose rules test assertions in text, not promises about a UI element.
  assert.ok(fires("You'll see their name, license status and rating on every departure."));
  assert.ok(fires("References and traveler reviews are checked, and ratings stay visible on every departure."));
  assert.ok(fires("The operating company is shown on the departure page."));
  assert.ok(fires("Every operator's licence is displayed before you book."));
});

test("it stops on travel prose, which is what the site is mostly made of", () => {
  for (const ok of [
    "as the sun rises and the road heats, you'll see the desert's famous mirages shimmer in the distance",
    "this \"lesser\" road is where you'll see ancient temple-building at its best-preserved",
    "You will see the Nile at sunset from the west bank.",
    "From the terrace you can view the whole Giza plateau.",
  ]) {
    assert.ok(!fires(ok), `false positive on legitimate copy: ${ok.slice(0, 60)}`);
  }
});

test("the UK spelling list matches the one the static-page test enforces", () => {
  // DIR-14 — a loop is a claim about every member and says nothing about
  // whether there are any. This test is worthless on an empty set.
  assert.ok(UK_SPELLINGS.length > 10, `only ${UK_SPELLINGS.length} words — the list is not being read`);
  // Two lists would drift, and the drift would be invisible: each would pass on
  // its own surface. Same MM3 argument as everywhere else here.
  const constants = readFileSync(join(ROOT, "server", "constants.test.js"), "utf8");
  for (const word of UK_SPELLINGS) {
    assert.ok(constants.includes(`"${word}"`), `${word} is checked on database copy but not on static pages`);
  }
});

test("a page that did not serve is not a clean page", () => {
  // The vacuous pass this script committed on its own first run: it audited a
  // 404, found nothing, and exited 0.
  const src = readFileSync(join(ROOT, "scripts", "audit-page.js"), "utf8");
  assert.match(src, /res\.status !== 200/, "a non-200 must fail rather than report zero findings");
  assert.match(src, /UNREACHABLE/);
});

test("auditOnePage reads copy, not markup", () => {
  // PPP2 — it reuses audit-claims' visibleText rather than re-deriving one. A
  // script written minutes after reading that helper's comment ignored it and
  // reported JSON-LD as prose.
  const html = `<html><body><p>Our travellers love it.</p>
    <script type="application/ld+json">{"text":"travellers travellers travellers"}</script></body></html>`;
  const hits = auditOnePage(html, "/x").filter((f) => f.rule === "uk-spelling");
  assert.equal(hits.length, 1);
  assert.match(hits[0].match, /^1x travellers$/, "script content was counted as copy");
});
