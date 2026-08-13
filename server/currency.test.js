// The currency is a term of the booking, and it was typed by hand into forty
// places.
//
// `shared/currency.js` made it one declaration, and everything that can import
// reads it. But the static pages CANNOT import — they are hand-written
// documents served off disk — and neither can a copywriter adding a card
// renderer by pasting the one above it, which is exactly how eight boards came
// to carry `'$'+price+' USD / person'` in the first place.
//
// So this is the check that makes a re-introduced dollar loud. It is the same
// instrument as server/constants.test.js, which holds the group-size numbers
// against domain.js, and for the same reason: a page with the wrong currency on
// it keeps rendering perfectly, and the first person to notice is a traveller
// looking at a number they are about to owe.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENCY, CURRENCY_SYMBOL, CURRENCY_PROSE } from "../shared/currency.js";
import { BRAND } from "./brand.js";
import { pages } from "../scripts/sync-partials.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(f, "utf8");
const name = (f) => relative(ROOT, f);

// A guard on the guard: every assertion below checks against these, so if
// someone changes them the whole file starts checking the new answer. This is
// the one place the current decision is written down. Same shape as the
// group-size constants assertion in constants.test.js.
test("the currency is what the site quotes in", () => {
  assert.equal(CURRENCY, "EUR");
  assert.equal(CURRENCY_SYMBOL, "€");
  assert.equal(CURRENCY_PROSE, "euros (EUR)");
});

// ---------------------------------------------------------------------------
// The static pages.
//
// Comments are stripped: the audit notes in these files quote the old dollar
// strings deliberately, to record what was removed. Same carve-out, and same
// reasoning, as the US-English sweep in constants.test.js.
const stripComments = (html) => html
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

// "USD" as a word, "US$", and the prose forms. Not a bare "$": that is caught
// separately, below, with the context that tells a price from a jQuery-ism.
const DEAD_CURRENCY = [
  /\bUSD\b/g,
  /\bUS\$/g,
  /\bUS dollars?\b/gi,
  /\bUnited States dollars?\b/gi,
];

test("no static page names a currency the site does not quote in", () => {
  const problems = [];
  for (const file of pages()) {
    const body = stripComments(read(file));
    for (const re of DEAD_CURRENCY) {
      const hits = body.match(re);
      if (hits) problems.push(`${name(file)}: ${hits.length}× "${hits[0]}"`);
    }
  }
  assert.deepEqual(problems, [],
    `the site quotes in ${CURRENCY_PROSE}:\n  ${problems.join("\n  ")}`);
});

// A dollar sign against a FIGURE — "$740", "$0" — or against an interpolated
// price, which in these files is always string concatenation: `'$'+price` or
// `tnum">$'+p.price`. Both shapes shipped. The static pages contain no template
// literals at all, so `${` is not a false positive to reason about here.
const DOLLAR_AMOUNT = /\$(?:\s*\d|'\s*\+|(?=[^\s<]*'\s*\+))/g;

test("no static page renders a price with a dollar sign", () => {
  const problems = [];
  for (const file of pages()) {
    const body = stripComments(read(file));
    for (const m of body.matchAll(DOLLAR_AMOUNT)) {
      problems.push(`${name(file)}: "…${body.slice(Math.max(0, m.index - 30), m.index + 30)}…"`);
    }
  }
  assert.deepEqual(problems, [],
    `prices are shown as "${CURRENCY_SYMBOL}":\n  ${problems.join("\n  ")}`);
});

test("it fires — a page that reintroduces either shape", () => {
  // W3 — a sweep whose only evidence is "the real pages are clean" is also
  // exactly what a sweep matching nothing would report. These are the two
  // shapes that were actually live, so the check is proved against them.
  const stray = '<b class="tnum">$740 USD</b>';
  assert.ok(DEAD_CURRENCY.some((re) => re.test(stray)), "USD went undetected");
  assert.ok(DOLLAR_AMOUNT.test(stray), "a dollar amount went undetected");

  const renderer = `+'<span class="price"><b class="tnum">$'+f.price+'</b></span>'`;
  assert.ok(new RegExp(DOLLAR_AMOUNT.source).test(renderer),
    "a concatenated dollar price went undetected");

  // And it does not fire on the euro forms that replaced them.
  const good = `<b class="tnum">€740 EUR</b>+'<b class="tnum">€'+f.price+'</b>'`;
  assert.ok(!DEAD_CURRENCY.some((re) => new RegExp(re.source, "g").test(good)));
  assert.ok(!new RegExp(DOLLAR_AMOUNT.source).test(good));
});

// ---------------------------------------------------------------------------
// The surfaces that CAN import, and therefore must.
//
// Checked by import rather than by scanning for glyphs: these files are full of
// `${...}` template literals, so a dollar-sign scan over them is noise. What
// matters is that they take the currency from the authority — a file that
// imports it cannot quietly hard-code a different one without the mismatch
// being visible on the line above.
const RENDERS_MONEY = [
  "src/main.jsx",
  "src/AdminDashboard.jsx",
  "src/AgencyDashboard.jsx",
  "server/seo.js",
  "server/email.js",
  "server/autoura-sync.js",
];

test("everything that renders money reads the currency from shared/", () => {
  const missing = RENDERS_MONEY.filter(
    (f) => !/from "\.\.?\/(?:\.\.\/)?shared\/currency\.js"/.test(read(join(ROOT, f))));
  assert.deepEqual(missing, [],
    `these render prices and must import shared/currency.js: ${missing.join(", ")}`);
});

// A dollar sign sitting in JSX TEXT, which is where nine of them were hiding
// after the sweep above came back clean.
//
// This is the shape the "no USD" rule cannot see, because these carried no
// label at all: `<b className="tnum">${pp}</b>` on the mobile booking bar,
// `<strong>${rateFor(departure)}</strong>` in the departure editor, six in the
// agency booking summary, and a `<th>Live $</th>` column header. In JSX that
// `$` is literal text; in a template literal the identical characters are an
// interpolation. So the rule is anchored on the thing that distinguishes them:
// a JSX text run starts at a tag's closing `>` and contains no backtick.
//
// `[^\s=<>-]` excludes `=>`, `>=` and a spaced `>` comparison, which is how an
// arrow function inside a template literal read as a tag close on the first
// draft. Verified against all six components: zero findings, and it still fires
// on each of the four shapes that were live.
const JSX_TEXT_DOLLAR = /[^\s=<>-]>[^<>`\n]*\$/g;
const COMPONENTS = ["src/main.jsx", "src/AdminDashboard.jsx", "src/AgencyDashboard.jsx",
  "src/LoginGate.jsx", "src/RichText.jsx", "src/DashSidebar.jsx"];

test("no component renders a dollar sign as JSX text", () => {
  const problems = [];
  for (const f of COMPONENTS) {
    const body = stripComments(read(join(ROOT, f)));
    for (const m of body.matchAll(JSX_TEXT_DOLLAR)) {
      problems.push(`${f}: "${body.slice(m.index, m.index + 60).replace(/\n/g, " ")}"`);
    }
  }
  assert.deepEqual(problems, [],
    `prices are shown as "${CURRENCY_SYMBOL}":\n  ${problems.join("\n  ")}`);
});

// The third shape, and the last one standing: a literal dollar inside a
// TEMPLATE literal, immediately before an interpolation — ` (+$${supplement})`.
// It is invisible to the rule above (there is no tag close in front of it) and
// to the "no USD" rule (no label), and three of them were live in the hotel-tier
// and single-supplement selects.
//
// `$${` is unambiguous in JavaScript: a literal dollar sign against a value. The
// only other thing that writes it is a SQL placeholder built by index —
// `$${vals.push(x)}` in server/db/sanitize-existing-html.js — which is why this
// rule is scoped to the components, where no SQL is written.
const TEMPLATE_DOLLAR = /\$\$\{/g;

test("no component puts a dollar sign against an interpolated price", () => {
  const problems = [];
  for (const f of COMPONENTS) {
    const body = stripComments(read(join(ROOT, f)));
    for (const m of body.matchAll(TEMPLATE_DOLLAR)) {
      problems.push(`${f}: "${body.slice(m.index - 20, m.index + 40).replace(/\n/g, " ")}"`);
    }
  }
  assert.deepEqual(problems, [],
    `prices are shown as "${CURRENCY_SYMBOL}":\n  ${problems.join("\n  ")}`);
});

test("it fires — every shape that was live in the components", () => {
  const live = [
    '<b className="tnum">${pp}</b>',              // the mobile booking bar
    "<span>from ${from}/pp</span>",               // the agency catalogue card
    "<th>Live $</th>",                            // a column header
    "<strong>$740</strong>",                      // a hard-coded figure
  ];
  for (const s of live) {
    assert.ok(new RegExp(JSX_TEXT_DOLLAR.source).test(s), `went undetected: ${s}`);
  }
  // The template-literal shape, which the JSX rule cannot see and must not be
  // assumed covered by it.
  const inTemplate = "` (+$${t.perPersonSupplement}/pp)`";
  assert.ok(!new RegExp(JSX_TEXT_DOLLAR.source).test(inTemplate), "assumption changed — recheck");
  assert.ok(new RegExp(TEMPLATE_DOLLAR.source).test(inTemplate), "went undetected");
  assert.ok(!new RegExp(TEMPLATE_DOLLAR.source).test("` (+${CURRENCY_SYMBOL}${t.x}/pp)`"));
  // And not on their replacements, nor on a template literal that merely
  // contains an arrow function or a comparison.
  for (const s of ['<b className="tnum">{CURRENCY_SYMBOL}{pp}</b>', "<th>Live {C}</th>",
                   "`${xs.map((x) => x > 1)} and ${y}`"]) {
    assert.ok(!new RegExp(JSX_TEXT_DOLLAR.source).test(s), `false positive: ${s}`);
  }
});

test("no money surface still names the dollar", () => {
  const problems = [];
  for (const f of RENDERS_MONEY) {
    const body = stripComments(read(join(ROOT, f)));
    for (const re of DEAD_CURRENCY) {
      const hits = body.match(re);
      if (hits) problems.push(`${f}: ${hits.length}× "${hits[0]}"`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n  "));
});

// ---------------------------------------------------------------------------
// Structured data. A crawler reads priceCurrency, and a wrong one there is a
// price advertised in the wrong currency in a search result, where nobody on
// this side ever sees it.
test("the schema.org price tier carries the site's currency", () => {
  assert.ok(BRAND.priceRange.startsWith(CURRENCY_SYMBOL),
    `priceRange is "${BRAND.priceRange}" — it is rendered in rich results and must use ${CURRENCY_SYMBOL}`);
});

test("structured data declares the currency as ISO 4217", () => {
  // seo.js opens a pool at import time and cannot be loaded under `node --test`
  // (the note at the top of static-seo.test.js), so this reads the source. The
  // point is the same: the literal "USD" must not come back.
  const src = read(join(ROOT, "server", "seo.js"));
  assert.match(src, /priceCurrency:\s*CURRENCY\b/,
    "priceCurrency must come from shared/currency.js, not a literal");
});
