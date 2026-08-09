// Keeps the group-size numbers in the static pages honest against
// server/domain.js, which is where they are actually decided.
//
// The 20 pages in /site are standalone documents served straight off disk, so
// they cannot read a JS constant at render time — which is how "four travelers"
// and "12 joined" came to be typed into twenty files by hand. Those numbers are
// the booking conditions. If the copy and domain.js ever disagree, the site is
// promising something the system does not do.
//
//   node scripts/sync-constants.js           write the constants into every page
//   node scripts/sync-constants.js --check   report drift, write nothing (exit 1)
//
// Two mechanisms, deliberately, because they carry different risk:
//
//   REWRITE — only where the number is unambiguously a VALUE: "4 of 12 joined",
//   "minimum of four", "4–12 travellers". These are safe to write automatically
//   because the surrounding words fix the meaning.
//
//   REPORT — prose that states the threshold in a sentence. A first draft of
//   this script rewrote those too, and turned "your two travelers join four of
//   ours" in operators.html into "your four travelers join four of ours" — a
//   sentence about an operator's own group, silently corrupted, because a regex
//   cannot tell which number is the threshold. So prose is reported for a human
//   to edit and CI fails until they do. A loud failure beats a quiet rewrite of
//   a sentence the script does not understand.
//
// Deliberately NOT a token like {{GROUP_MAX}}: a page carrying tokens stops
// being a document you can open, which is the property /site exists to keep.
//
// Spelling is preserved as authored. The static pages use "travelers", the SPA
// uses "travellers"; that split is not this script's to resolve, and the first
// draft resolved it by accident across three files.
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE } from "../server/domain.js";
import { INTERIM_COPY, UNDECIDED } from "../shared/site-copy.js";
import { pages } from "./sync-partials.js";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const NUM = `(?:\\d+|${WORDS.join("|")})`;

export const word = (n) => WORDS[n] || String(n);
const matchCase = (sample, replacement) =>
  (/^[A-Z]/.test(sample) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement);
// A numeral in the source stays a numeral; a word stays a word.
const like = (sample, n) => (/^\d+$/.test(sample) ? String(n) : matchCase(sample, word(n)));

// Safe to write automatically: in each of these the surrounding words fix what
// the number means, so there is no sentence for the script to misread.
export function rewriteRules(min = DEFAULT_GO_AHEAD, max = MAX_GROUP_SIZE) {
  return [
    { re: new RegExp(`\\b(minimum|min\\.) of (${NUM})\\b`, "gi"), to: (m, lead, n) => `${lead} of ${like(n, min)}` },
    { re: new RegExp(`\\b(maximum|max\\.) of (${NUM})\\b`, "gi"), to: (m, lead, n) => `${lead} of ${like(n, max)}` },
    // The leading word is captured rather than retyped. Written as a literal
    // `never`, this rule rewrote the sentence-initial "Never more than twelve.
    // Ever." to lowercase the moment it was added to two pages — the rule
    // corrupting the copy it exists to maintain.
    { re: new RegExp(`\\b(never) (more than|above) (${NUM})\\b`, "gi"),
      to: (m, never, lead, n) => `${never} ${lead} ${like(n, max)}` },
    // "X of N joined" is AMBIGUOUS and must never be rewritten on the pattern
    // alone. Two pages use it to mean opposite things:
    //
    //   index / how-it-works   "4 of 12 joined · 8 seats left"      N is the CEILING
    //   goahead-promise        "3 of 4 joined · 1 seat to GoAhead"  N is the THRESHOLD
    //
    // A rule that assumed the ceiling turned the second into "3 of 12 joined ·
    // 1 seat to GoAhead". So each form is matched with the sibling phrase that
    // fixes its meaning, and anything that matches neither is left alone and
    // reported rather than guessed at.
    //
    // Ceiling, with the remaining-seats figure derived alongside it:
    { re: /(<(?:b|strong)[^>]*>(\d+)<\/(?:b|strong)> of )\d+( joined<\/span><span>)\d+( seats? left)/g,
      to: (m, lead, joined, mid, tail) => `${lead}${max}${mid}${Math.max(0, max - Number(joined))}${tail}` },
    // Ceiling, stated next to the threshold being reached:
    { re: /(<(?:b|strong)[^>]*>\d+<\/(?:b|strong)> of )\d+( joined<\/span><span>minimum of )/g,
      to: (m, lead, mid) => `${lead}${max}${mid}` },
    // A group-size RANGE, in any of the phrasings the site uses. This was
    // originally written as `(\d+)–(\d+) travellers`, requiring that exact
    // noun immediately after the numbers — so it never saw "Travel in a group
    // of 4–8 with one guide" on /how-it-works, which stated a ceiling of eight
    // on the same page that promises "Never more than twelve. Ever."
    //
    // Anchored on the group word BEFORE the range as well as the noun after,
    // because the ceiling can be stated either way round.
    { re: new RegExp(`\\b(group|groups|party) of (\\d+)\\s*([–—-])\\s*(\\d+)`, "gi"),
      to: (m, lead, lo, dash, hi) => `${lead} of ${lo}${dash}${max}` },
    { re: /\b(\d+)\s*([–—-])\s*(\d+)\s+(travell?ers|people|guests|seats)\b/gi,
      to: (m, lo, dash, hi, noun) => `${lo}${dash}${max} ${noun}` },
    // Threshold, with the seats-to-GoAhead figure derived alongside it:
    { re: /(<(?:b|strong)[^>]*>(\d+)<\/(?:b|strong)> of )\d+( joined<\/span><span>)\d+( seats? to GoAhead)/g,
      to: (m, lead, joined, mid, tail) => {
        const left = Math.max(0, min - Number(joined));
        return `${lead}${min}${mid}${left}${tail.replace(/seats?/, left === 1 ? "seat" : "seats")}`;
      } },
  ];
}

// Prose that states the threshold. Reported, never rewritten — see the note
// above. Tightly anchored so an unrelated sentence about numbers of people
// cannot match.
export function proseRules(min = DEFAULT_GO_AHEAD, max = MAX_GROUP_SIZE) {
  return [
    { label: "GoAhead threshold", n: min, re: new RegExp(`\\b(${NUM}) travell?ers?,? (?:and|confirms?|commit|join the same)\\b`, "gi") },
    { label: "GoAhead threshold", n: min, re: new RegExp(`\\b(?:when|once|reaches) (${NUM}) travell?ers?\\b`, "gi") },
    { label: "group ceiling", n: max, re: new RegExp(`\\bno (?:Sawa )?group (?:ever )?goes above (${NUM})\\b`, "gi") },
  ];
}

// Writes shared/site-copy.js into any element marked data-copy="<key>".
//
// Interim strings — copy that is true of this build and will change on a known
// event — otherwise get typed into each page and drift. "24/7" reached six
// locations saying four different things that way.
//
// An undecided key (null value) is never written. A page must not publish a
// placeholder, so this refuses rather than emitting an empty element, and
// server/constants.test.js fails if a page marks a key that has no value.
export function applyInterimCopy(html, copy = INTERIM_COPY) {
  return html.replace(
    /(<([a-z]+)([^>]*\bdata-copy="([a-z-]+)"[^>]*)>)([\s\S]*?)(<\/\2>)/gi,
    (whole, open, tag, attrs, key, inner, close) => {
      const value = copy[key];
      if (value == null) return whole;   // undecided: leave the page as authored
      return `${open}${value}${close}`;
    });
}

// Keys a page marks but site-copy.js has no value for.
export function undecidedKeysUsed(html, copy = INTERIM_COPY) {
  return [...html.matchAll(/data-copy="([a-z-]+)"/gi)]
    .map((m) => m[1])
    .filter((k) => copy[k] == null);
}

export function applyConstants(html, min = DEFAULT_GO_AHEAD, max = MAX_GROUP_SIZE) {
  let out = html;
  for (const { re, to } of rewriteRules(min, max)) out = out.replace(re, to);
  return out;
}

// Every prose mention whose number does not match the constant it states.
export function proseDrift(html, min = DEFAULT_GO_AHEAD, max = MAX_GROUP_SIZE) {
  const out = [];
  const lines = html.split("\n");
  for (const { label, n, re } of proseRules(min, max)) {
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        const found = m[1].toLowerCase();
        const ok = found === String(n) || found === word(n);
        if (!ok) out.push({ line: i + 1, label, found: m[1], expected: word(n), text: m[0].trim() });
      }
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const isCheck = process.argv.includes("--check");
  const rel = (f) => relative(process.cwd(), f);
  const valueDrift = [];
  const proseProblems = [];
  let written = 0;

  for (const file of pages()) {
    const before = readFileSync(file, "utf8");
    const after = applyInterimCopy(applyConstants(before));
    if (before !== after) {
      if (isCheck) valueDrift.push(rel(file));
      else { writeFileSync(file, after); written++; }
    }
    proseDrift(after).forEach((d) => proseProblems.push({ file: rel(file), ...d }));
  }

  for (const p of proseProblems) {
    console.error(`${p.file}:${p.line}  ${p.label} reads "${p.found}", domain.js says "${p.expected}" — "${p.text}"`);
  }
  if (isCheck && valueDrift.length) {
    console.error(`Group-size values do not match server/domain.js in:\n  ${valueDrift.join("\n  ")}\nRun: node scripts/sync-constants.js`);
  }
  if (proseProblems.length || (isCheck && valueDrift.length)) process.exit(1);

  console.log(isCheck
    ? `Group-size copy matches domain.js (GoAhead ${DEFAULT_GO_AHEAD}, max ${MAX_GROUP_SIZE}) across all ${pages().length} pages.`
    : `Wrote GoAhead ${DEFAULT_GO_AHEAD} / max ${MAX_GROUP_SIZE} into ${written} of ${pages().length} pages.`);
}
