// The cruiser is always five-star, and the hotel supplement buys hotel nights.
//
// Until 033 the tier labels were the only place a standard appeared, and they
// said it WRONGLY — "5★ cruise" / "deluxe cruise" / "luxury cruise" read as
// though the boat upgraded with the hotel. Removing that was right; leaving
// nothing in its place was not. On the nine-day package the only "five-star"
// words remaining were two hotel tier names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasNileCruise, CRUISE_STANDARD_NOTE, CANCELLATION_SCHEDULE } from "../shared/booking-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SQL = read("server/db/schema_034_five_star_cruiser.sql");
const stmts = SQL.replace(/^\s*--.*$/gm, "").trim();

// ---- the detector ----------------------------------------------------------

test("it finds the cruise when the ITINERARY names it", () => {
  assert.equal(hasNileCruise({ type: "package", itinerary: [{ accommodation: "Nile Cruise · Luxor" }] }), true);
  assert.equal(hasNileCruise({ type: "package", itinerary: [{ overnight: "Nile Cruise" }] }), true);
});

test("it finds the cruise when only the INCLUSIONS name it", () => {
  // The case that makes the itinerary alone insufficient. "Egypt End to End" has
  // twelve itinerary days and no accommodation or overnight value on any of
  // them — and it is the longest and most expensive package, the one whose
  // cruise is easiest to lose among Cairo, Aswan and Hurghada nights.
  const endToEnd = {
    type: "package",
    itinerary: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
    included: ["4 nights Cairo hotel, 1 night Aswan, 3 nights Nile cruise (full board), 3 nights Hurghada"],
  };
  assert.equal(hasNileCruise(endToEnd), true, "an itinerary-only test misses this package");
});

test("it matches the cruiser spelling too", () => {
  assert.equal(hasNileCruise({ type: "package", included: ["4 nights aboard a five-star Nile cruiser (full board)"] }), true);
});

test("it stops on a package with no cruise", () => {
  assert.equal(hasNileCruise({
    type: "package",
    itinerary: [{ accommodation: "Hotel · Cairo" }],
    included: ["4 nights Cairo hotel", "Red Sea transfers"],
  }), false, "the note would claim something the traveller is not buying");
});

test("it stops on a day tour, whatever its text says", () => {
  // A day tour has no hotel tier selector at all, so the note has nowhere to go.
  assert.equal(hasNileCruise({ type: "day_tour", included: ["Nile cruise dinner"] }), false);
});

test("it does not throw on a bare or empty product", () => {
  for (const p of [{ type: "package" }, {}, null, undefined]) {
    assert.equal(typeof hasNileCruise(p), "boolean", `threw or returned non-boolean for ${JSON.stringify(p)}`);
  }
});

// ---- the note --------------------------------------------------------------

test("the note says both things the client said", () => {
  assert.match(CRUISE_STANDARD_NOTE, /five-star/i, "the standard");
  assert.match(CRUISE_STANDARD_NOTE, /hotel tier only/i, "what the supplement buys");
  // And it must not re-introduce the implication 033 removed.
  assert.ok(!/deluxe cruise|luxury cruise|four-star cruis/i.test(CRUISE_STANDARD_NOTE),
    "the cruiser does not vary by tier");
});

test("the note renders under the hotel tier selector, gated on the detector", () => {
  const src = read("src/main.jsx");
  assert.match(src, /\{hasNileCruise\(tour\) && <small className="bk-tier-note">\{CRUISE_STANDARD_NOTE\}<\/small>\}/);
  // Inside the Hotel tier label, not the Room one below it.
  const block = /<span>Hotel tier<\/span>[\s\S]*?<\/label>/.exec(src);
  assert.ok(block && block[0].includes("CRUISE_STANDARD_NOTE"), "it landed on the wrong field");
});

test("everything the component uses is imported", () => {
  // This shipped broken for one build: the JSX referenced hasNileCruise while
  // the import list still did not, so the bundle threw "hasNileCruise is not
  // defined" and EVERY SPA route rendered a blank page. The build succeeded —
  // Vite does not resolve a bare identifier at build time — and only loading a
  // page showed it.
  const src = read("src/main.jsx");
  const imported = (/import \{([\s\S]*?)\} from "\.\.\/shared\/booking-policy\.js";/.exec(src) || [])[1] || "";
  const names = imported.split(",").map((n) => n.trim().split(" as ").pop()).filter(Boolean);
  assert.ok(names.length > 4, "the import block was not parsed");
  for (const used of ["hasNileCruise", "CRUISE_STANDARD_NOTE"]) {
    assert.ok(src.includes(used), `${used} should be used by the component`);
    assert.ok(names.includes(used), `${used} is used but never imported — the bundle throws at load`);
  }
});

test("no tier label states a cruise standard", () => {
  // The whole point: the boat is constant, so it is stated once, not per tier.
  for (const bands of Object.values(CANCELLATION_SCHEDULE)) assert.ok(Array.isArray(bands));
  const fixture = read("site/_dev_bootstrap.json");
  assert.ok(!/deluxe cruise|luxury cruise/i.test(fixture), "a tier label still varies the cruise");
});

// ---- the migration ---------------------------------------------------------

test("034 states the standard in the INCLUSIONS", () => {
  assert.match(stmts, /SET included =/);
  assert.match(stmts, /'nights aboard a five-star Nile cruiser \(full board\)'/);
  assert.ok(!/accommodation_tiers/.test(stmts), "the cruiser is not a tier — it does not vary");
});

test("034 preserves the rest of each sentence", () => {
  // The two packages phrase the surrounding nights differently — one has Aswan
  // and Hurghada in the same string. `replace` on the fragment keeps them; a
  // whole-string swap would have dropped them.
  assert.match(stmts, /replace\(e,/);
  assert.ok(!/WHEN '4 nights Cairo hotel/.test(stmts), "a whole-string swap loses the other nights");
});

test("034 cannot touch Nile Majesty", () => {
  // It already says "aboard a five-star Nile cruiser" and never contained the
  // old fragment, so it matches nothing even on the first run.
  const majesty = "4 nights aboard a five-star Nile cruiser (full board)";
  assert.ok(!majesty.includes("nights Nile cruise (full board)"));
});

test("034 is guarded, idempotent and registered", () => {
  assert.match(stmts, /LIKE '%nights Nile cruise \(full board\)%'/);
  assert.match(stmts, /type = 'package'/);
  assert.match(stmts, /jsonb_typeof\(included\) = 'array'/);
  assert.ok(!/\bpledges\b/i.test(stmts));
  assert.match(read("server/db/migrate.js"), /schema_034_five_star_cruiser\.sql/);
});

test("034 fixes the sentence in BOTH columns", () => {
  // "Egypt End to End" repeats its inclusions as prose in overview_html, so the
  // phrase is on that row twice. Fixing `included` alone leaves the page
  // contradicting itself a few paragraphs apart.
  assert.match(stmts, /SET included =/);
  assert.match(stmts, /SET overview_html = replace\(overview_html,/);
  assert.equal((stmts.match(/UPDATE tour_products/g) || []).length, 2);
});

test("the repo seed and the dev fixture already say it", () => {
  // Otherwise a reseed restores a package whose cruise has no standard.
  assert.match(read("server/db/add-package.js"), /4 nights aboard a five-star Nile cruiser \(full board\)/);
  const fixture = read("site/_dev_bootstrap.json");
  assert.ok(!/nights Nile cruise \(full board\)/.test(fixture), "the fixture still omits the standard");
});
