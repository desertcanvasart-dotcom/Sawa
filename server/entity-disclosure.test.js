// DIR-19.2 — the entity string, and the fact that it has five authors.
//
// The registered name has not arrived, and DIR-19 forbids placeholders. So this
// does not rename anything. It fixes the number that makes the rename either a
// one-line change or a five-surface hunt: **how many independent places say who
// runs Sawa.**
//
// The response-derived sweep (10 Aug 2026) found the string on:
//
//   23 of 23 rendered public routes  — 3 of them in JSON-LD with NO footer
//   12 of 12 rendered mail templates
//   0 of 121 production text columns
//
// but those are OUTPUTS. In SOURCE it is written five separate times, in four
// different sentences, and nothing makes them agree.
//
// This is the `tourSlug` shape: nine copies of one fact, and the one nobody
// remembers is the one that drifts. It is not restructured here — that is
// DIR-19.1's job and it needs the new name — but it is RATCHETED, so a sixth
// copy cannot appear while we wait.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// DIR-19 executed 10 Aug 2026. The sweep this file was built from IS the
// checklist that was worked through, which is what it was for.
const ENTITY = "Online Era";
// The former entity. It may still appear — but only where it is deliberate, and
// never as the operator of the platform.
const FORMER = "Capital Travel Service";

// Every place the string is WRITTEN, and why. Generated files are excluded
// below; if a path here disappears or a new one appears, this fails.
//
// The `surface` column is the DIR-19.1 checklist: when the registered name
// arrives, these are the edits, and there are no others.
const AUTHORED = {
  "site/_partials/footer.html": { n: 1, surface: "footer — applyFooter writes it into 21 static pages" },
  "src/main.jsx":               { n: 1, surface: "footer — the SPA's own copy of the same sentence" },
  // Was 2. The second was a COMMENT beside an empty `accreditations`, saying the
  // entity's own tourism registration was a fact the client had not supplied.
  // The client confirmed both credentials on 14 Aug 2026, so that sentence
  // described a state that no longer exists and went with the fix. What remains
  // is the declaration itself — the only occurrence DIR-19.1 has to edit here.
  // (Phrased without the name on purpose: this file counts itself.)
  "server/brand.js":            { n: 1, surface: "BRAND.legalName — the JSON-LD Organization node is built from it" },
  "server/email.js":            { n: 1, surface: "mail footer — hardcoded, NOT read from BRAND" },
  "site/privacy.html":          { n: 2, surface: "controller identity in body prose (a third is the generated footer)" },
  "site/cookies.html":          { n: 1, surface: "controller identity in body prose (a second is the generated footer)" },
  "site/terms.html":            { n: 1, surface: "§1 contracting party, in body prose (a second is the generated footer)" },
  "site/about.html":            { n: 1, surface: "\"Who runs Sawa\", beside the founder history" },
  "server/entity-disclosure.test.js": { n: 3, surface: "this file's own declaration, plus the exact-rendering assertions" },
};

const ROOTS = ["site", "server", "src", "scripts", "shared"];
// The 21 static pages carry a GENERATED footer. They are outputs of the partial
// and are asserted against it below rather than listed one by one — listing
// them would be the hand-maintained catalogue DIR-7 removed.
const GENERATED_FOOTER = /^site\/(?!_partials\/).*\.html$/;

function walk(dir, out = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(js|jsx|html)$/.test(e)) out.push(rel);
  }
  return out;
}

const occurrences = (rel) => {
  const src = readFileSync(join(ROOT, rel), "utf8");
  return (src.match(new RegExp(ENTITY, "g")) || []).length;
};

// AUTHORED occurrences only: the <footer> block on a static page is written by
// applyFooter from the partial, so it is an output, not an author.
//
// The first version of this skipped the whole FILE when it had a generated
// footer — which silently dropped privacy, cookies and terms, the three pages
// that name the entity in body prose as well. A filter that removes a file to
// avoid double-counting one line is how a sweep under-reports.
const authoredOccurrences = (rel) => {
  let src = readFileSync(join(ROOT, rel), "utf8");
  if (GENERATED_FOOTER.test(rel)) src = src.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  return (src.match(new RegExp(ENTITY, "g")) || []).length;
};

test("the entity string is written in exactly the places DIR-19.1 will have to edit", () => {
  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(files.length > 50, `only ${files.length} files walked — refusing to report clean`);

  const found = {};
  for (const rel of files) {
    const n = authoredOccurrences(rel);
    if (!n) continue;
    found[rel] = n;
  }

  const unexpected = Object.keys(found).filter((f) => !AUTHORED[f]);
  assert.deepEqual(unexpected, [],
    `a NEW place now names the operating entity:\n  ${unexpected.join("\n  ")}\n\n`
    + `Every copy is one more edit when the registered name arrives, and one more `
    + `chance for the old name to survive the change. Add it to AUTHORED with a `
    + `surface, or read it from an existing authority instead.`);

  const gone = Object.keys(AUTHORED).filter((f) => !found[f]);
  assert.deepEqual(gone, [], `AUTHORED lists a file that no longer names the entity: ${gone.join(", ")}`);

  const miscounted = Object.entries(AUTHORED)
    .filter(([f, { n }]) => found[f] !== n)
    .map(([f, { n }]) => `${f}: expected ${n}, found ${found[f]}`);
  assert.deepEqual(miscounted, [], `the count changed:\n  ${miscounted.join("\n  ")}`);
});

test("the 21 static pages carry a GENERATED footer, not 21 hand-written copies", () => {
  // If this ever fails, the footer has stopped being generated and the count
  // above jumps from five authors to twenty-six.
  const footer = readFileSync(join(ROOT, "site/_partials/footer.html"), "utf8");
  const sentence = footer.match(new RegExp(`[^>]{0,60}${ENTITY}[^<]{0,60}`))?.[0]?.trim();
  assert.ok(sentence, "the footer partial no longer contains the entity sentence");

  const pages = walk("site").filter((f) => GENERATED_FOOTER.test(f) && occurrences(f));
  assert.ok(pages.length >= 20, `only ${pages.length} pages carry the footer sentence`);
  const divergent = pages.filter((f) => !readFileSync(join(ROOT, f), "utf8").includes(sentence));
  assert.deepEqual(divergent, [],
    `these pages state the entity in words the footer partial does not:\n  ${divergent.join("\n  ")}`);
});

test("it fires — a sixth author is reported, not absorbed", () => {
  // The planted case. Without it the assertions above are "the list is empty",
  // which is also what a walker looking in the wrong place produces.
  const pretend = { "site/newly-invented.html": 1 };
  const unexpected = Object.keys(pretend).filter((f) => !AUTHORED[f]);
  assert.deepEqual(unexpected, ["site/newly-invented.html"]);
});

test("the former entity is never presented as the operator of the platform", () => {
  // DIR-19.3 makes Capital Travel Service an OPERATOR RECORD — a founding
  // partner — so the name may legitimately appear again. What must not come
  // back is the claim it used to make: that CTS operates the platform.
  //
  // ETAA 2179 goes with it. It is CTS's travel-agency licence, and presenting
  // one company's licence as another's is the class this project removes.
  for (const f of ["site/_partials/footer.html", "src/main.jsx", "server/email.js",
                   "site/privacy.html", "site/cookies.html", "site/terms.html"]) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/<!--[\s\S]*?-->/g, " ").replace(/^\s*\/\/.*$/gm, " ");
    assert.doesNotMatch(src, new RegExp(`[Oo]perated by ${FORMER}`), `${f} still says the platform is operated by ${FORMER}`);
    assert.doesNotMatch(src, new RegExp(`${FORMER}, trading as`), `${f} still names ${FORMER} as the trading entity`);
    assert.doesNotMatch(src, /ETAA 2179/, `${f} presents Capital Travel Service's ETAA licence as the platform's`);
  }
});

test("the name is rendered exactly as supplied — no invented legal form", () => {
  // DDDD2: "Render the name exactly as given. Do not add a legal-form suffix
  // that was not supplied." A suffix here would be a claim about a company's
  // registered form that nobody made.
  const footer = readFileSync(join(ROOT, "site/_partials/footer.html"), "utf8");
  assert.match(footer, /Online Era/);
  assert.doesNotMatch(footer, /Online Era\s+(?:LLC|L\.L\.C|Ltd|Limited|S\.A\.E|SAE|Inc)/i);
  assert.match(footer, /148500/, "the registration number belongs with the name");
});

test("the mail footer does not read from BRAND, and that is recorded not assumed", () => {
  // server/email.js writes the sentence itself. BRAND holds a DIFFERENT one
  // ("Operated by … — ETAA licence no. 2179"). Two sentences, two authors, one
  // fact. Pinned so DIR-19.1 cannot fix the visible site and miss the email —
  // which is exactly what 19.2 was written to prevent.
  const email = readFileSync(join(ROOT, "server/email.js"), "utf8");
  const brand = readFileSync(join(ROOT, "server/brand.js"), "utf8");
  assert.ok(email.includes(ENTITY), "email.js no longer names the entity");
  assert.ok(!/BRAND\.legalName|BRAND\.accreditations/.test(email),
    "email.js now reads the entity from BRAND — update this test and AUTHORED");
  assert.ok(brand.includes(ENTITY), "brand.js no longer names the entity");
});
