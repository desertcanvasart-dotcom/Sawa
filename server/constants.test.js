// The group-size numbers are the booking conditions. "Every Sawa departure runs
// with a minimum of 4 and a maximum of 12 travelers" is a term of the contract,
// stated on the homepage, the how-it-works page, the GoAhead promise and in the
// terms — and typed by hand into twenty static files that cannot read a
// constant at render time.
//
// If domain.js and that copy ever disagree, the site promises something the
// system does not do, and it does it silently: every page keeps rendering
// perfectly. These are the assertions that make it loud.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE } from "./domain.js";
import { applyConstants, proseDrift, word, applyInterimCopy, undecidedKeysUsed } from "../scripts/sync-constants.js";
import { INTERIM_COPY, UNDECIDED } from "../shared/site-copy.js";
import { pages } from "../scripts/sync-partials.js";

const read = (f) => readFileSync(f, "utf8");
const name = (f) => relative(process.cwd(), f);

test("every static page states the group-size values domain.js holds", () => {
  const drifted = pages().filter((f) => applyConstants(read(f)) !== read(f)).map(name);
  assert.deepEqual(drifted, [], `run \`node scripts/sync-constants.js\` — drifted: ${drifted.join(", ")}`);
});

test("no page states a GoAhead threshold or ceiling in prose that domain.js contradicts", () => {
  const problems = pages().flatMap((f) =>
    proseDrift(read(f)).map((d) => `${name(f)}:${d.line} reads "${d.found}", expected "${d.expected}" — "${d.text}"`));
  // Prose is reported rather than rewritten: a regex cannot tell which number
  // in a sentence is the threshold. An early version proved it by turning
  // "your two travelers join four of ours" into "your four travelers join four
  // of ours". So these fail the build and a human edits the sentence.
  assert.deepEqual(problems, [], `group-size prose contradicts domain.js:\n  ${problems.join("\n  ")}`);
});

// The rules are only worth anything if they actually fire. Each of these is a
// real fragment from a real page, and each was broken at some point during the
// writing of this script.
test("the rewrite rules fire on the markup the pages actually use", () => {
  const at = (html) => applyConstants(html, 6, 14);

  // The number sits INSIDE a tag. A rule written as "N of M joined" matched
  // nothing at all here, and silently did nothing on both pages that use it.
  assert.equal(
    at('<span><b>4</b> of 12 joined</span><span>8 seats left</span>'),
    '<span><b>4</b> of 14 joined</span><span>10 seats left</span>',
    "ceiling display, with the remaining-seats figure derived from it");

  assert.equal(
    at('<span><b class="tnum">4</b> of 12 joined</span><span>minimum of 4 reached</span>'),
    '<span><b class="tnum">4</b> of 14 joined</span><span>minimum of 6 reached</span>');

  assert.equal(at("a minimum of 4 and a maximum of 12 travelers"),
    "a minimum of 6 and a maximum of 14 travelers");

  assert.equal(at("never more than twelve"), "never more than fourteen", "word form stays a word");
  assert.equal(at("Minimum of 4"), "Minimum of 6", "leading capital is preserved");

  // The marketed line from P1.3 begins a sentence. Written with a literal
  // `never` in the replacement, this rule lowercased it on both pages the
  // moment the line was added — the rule corrupting the copy it maintains.
  assert.equal(at("Never more than twelve. Ever."), "Never more than fourteen. Ever.");
  assert.equal(applyConstants("Never more than twelve. Ever."), "Never more than twelve. Ever.",
    "and at the live constants it is left exactly alone");
});

test("'X of N joined' is read in context, because it means opposite things on two pages", () => {
  // index / how-it-works : "4 of 12 joined · 8 seats left"     -> N is the CEILING
  // goahead-promise      : "3 of 4 joined · 1 seat to GoAhead" -> N is the THRESHOLD
  //
  // Rewriting on the pattern alone turned the second into "3 of 12 joined · 1
  // seat to GoAhead", which is not a thing that can happen.
  assert.equal(
    applyConstants('<span><strong>3</strong> of 4 joined</span><span>1 seat to GoAhead</span>', 6, 14),
    '<span><strong>3</strong> of 6 joined</span><span>3 seats to GoAhead</span>',
    "threshold display follows the minimum, and repluralises");

  // And at the live constants it must be left exactly alone — this is the
  // regression that made the check fail on a page that was already correct.
  const live = '<span><strong>3</strong> of 4 joined</span><span>1 seat to GoAhead</span>';
  assert.equal(applyConstants(live), live);
});

test("the rules never change spelling", () => {
  // The static pages write "travelers", the SPA writes "travellers". An early
  // version of the rules quietly rewrote three files to the other spelling,
  // which is what this guards: sync-constants must leave both alone.
  const us = "you only pay when four travelers confirm the date";
  const uk = "you only pay when four travellers confirm the date";
  assert.equal(applyConstants(us), us);
  assert.equal(applyConstants(uk), uk);
  assert.equal(applyConstants(us, 6, 14), us, "and still not when the constants move");
});

// ---- US English is the site standard (U4.3) ---------------------------------
//
// This assertion was DELETED once, to make a build pass, when supplied
// [EXACT COPY] using "travellers" landed on a page written in "travelers". That
// was the wrong repair: the standard was never decided, so the test was removed
// instead of the ambiguity. The standard is now decided — US English site-wide,
// and supplied copy bends to the site — so the assertion is restored rather than
// reinstated in a weakened form.
//
// It runs over every copy surface, including the attribute text (placeholder,
// alt, aria-label, title) that a earlier audit could not see at all.

const UK_SPELLINGS = [
  "travellers", "traveller", "travelled", "travelling",
  "cancelled", "cancelling", "organisation", "organisations", "organisational",
  "reorganisation", "organiser", "authorisation", "authorised", "unauthorised",
  "licence", "licences", "recognised", "apologise", "realise", "minimise",
];

const stripComments = (html) => html
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

test("every static page is written in US English", () => {
  const problems = [];
  for (const file of pages()) {
    // Comments are not copy — the audit notes in these files quote the old
    // British spellings deliberately, to record what was removed.
    const body = stripComments(read(file));
    for (const uk of UK_SPELLINGS) {
      const re = new RegExp(`\\b${uk}\\b`, "gi");
      const hits = body.match(re);
      if (hits) problems.push(`${name(file)}: ${hits.length}× "${uk}"`);
    }
  }
  assert.deepEqual(problems, [], `US English is the site standard:\n  ${problems.join("\n  ")}`);
});

test("attribute text is held to the same standard", () => {
  // placeholder, alt, aria-label and title are read by users and were invisible
  // to every check until an operator name was found sitting in a placeholder.
  const problems = [];
  for (const file of pages()) {
    for (const m of stripComments(read(file)).matchAll(/\b(placeholder|alt|aria-label|title)="([^"]*)"/gi)) {
      for (const uk of UK_SPELLINGS) {
        if (new RegExp(`\\b${uk}\\b`, "i").test(m[2])) problems.push(`${name(file)} @${m[1]}: "${m[2].slice(0, 60)}"`);
      }
    }
  }
  assert.deepEqual(problems, [], `US English in attribute text:\n  ${problems.join("\n  ")}`);
});

test("a group-size range is corrected in every phrasing the site uses", () => {
  // /how-it-works read "Travel in a group of 4–8 with one guide" — a ceiling of
  // eight, on the same page that promises "Never more than twelve. Ever.", and
  // against a database CHECK constraint of 12.
  //
  // The range rule was written as `(\d+)–(\d+) travellers`, requiring that noun
  // immediately after the numbers, so it never saw this phrasing at all. It is
  // now anchored on the group word BEFORE the range as well as the noun after.
  assert.equal(applyConstants("Travel in a group of 4–8 with one guide"),
    "Travel in a group of 4–12 with one guide", "the bug this test exists for");

  assert.equal(applyConstants("shared departure for 4–12 travellers", 4, 14),
    "shared departure for 4–14 travellers", "noun-after phrasing");
  assert.equal(applyConstants("a group of 4–8 travelers"), "a group of 4–12 travelers",
    "US spelling of the noun");
  assert.equal(applyConstants("party of 4-8"), "party of 4-12", "hyphen as well as en-dash");
});

test("the range rule does not touch numbers that are not group sizes", () => {
  // A rule loose enough to catch every phrasing is loose enough to eat a price
  // range or a cancellation window.
  for (const s of ["from $45-$68 per person", "7-14 days before departure",
                   "open 9-5", "8-10 hours on the road"]) {
    assert.equal(applyConstants(s), s, s);
  }
});

test("the constants are what the booking conditions say", () => {
  // A guard on the guard: if someone changes these, every assertion above
  // starts checking the new number, so this is the one place the old contract
  // is written down.
  assert.equal(DEFAULT_GO_AHEAD, 4);
  assert.equal(MAX_GROUP_SIZE, 12);
  assert.equal(word(DEFAULT_GO_AHEAD), "four");
  assert.equal(word(MAX_GROUP_SIZE), "twelve");
});

// ---- interim copy (shared/site-copy.js) ------------------------------------
// Strings that are true of this build and will change on a known event. They
// live in one file so the swap is one edit — "24/7" reached six locations
// saying four different things by being typed into each of them.

test("a marked element is rewritten from site-copy.js", () => {
  const html = '<p>When that number is reached, <span data-copy="payment-arrangement">OLD TEXT</span>. Good.</p>';
  const out = applyInterimCopy(html, { "payment-arrangement": "the tour is confirmed" });
  assert.equal(out, '<p>When that number is reached, <span data-copy="payment-arrangement">the tour is confirmed</span>. Good.</p>');
});

test("an undecided key is never written into a page", () => {
  // The support-availability string is deliberately unpopulated: the true answer
  // is the client's to give, and guessing is how four contradictory versions got
  // published. A null must leave the page exactly as authored rather than
  // emptying the element — a blank claim is still a published claim.
  const html = '<p>We reply <span data-copy="support-availability">during Cairo hours</span>.</p>';
  assert.equal(applyInterimCopy(html, { "support-availability": null }), html);
});

test("a page may not mark a key that has no value", () => {
  for (const file of pages()) {
    const used = undecidedKeysUsed(read(file));
    assert.deepEqual(used, [], `${name(file)} marks undecided key(s): ${used.join(", ")}`);
  }
});

test("every key in site-copy.js is either decided or listed as undecided", () => {
  for (const [key, value] of Object.entries(INTERIM_COPY)) {
    if (value == null) assert.ok(UNDECIDED.includes(key), `${key} is null but not listed in UNDECIDED`);
    else assert.ok(typeof value === "string" && value.trim(), `${key} must be a non-empty string`);
  }
});
