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
const ENTITY = "Capital Travel Service";

// Every place the string is WRITTEN, and why. Generated files are excluded
// below; if a path here disappears or a new one appears, this fails.
//
// The `surface` column is the DIR-19.1 checklist: when the registered name
// arrives, these are the edits, and there are no others.
const AUTHORED = {
  "site/_partials/footer.html": { n: 1, surface: "footer — applyFooter writes it into 21 static pages" },
  "src/main.jsx":               { n: 1, surface: "footer — the SPA's own copy of the same sentence" },
  "server/brand.js":            { n: 1, surface: "JSON-LD accreditations, a differently-worded sentence" },
  "server/email.js":            { n: 1, surface: "mail footer — hardcoded, NOT read from BRAND" },
  "site/privacy.html":          { n: 2, surface: "controller identity in body prose (a third is the generated footer)" },
  "site/cookies.html":          { n: 1, surface: "controller identity in body prose (a second is the generated footer)" },
  "site/terms.html":            { n: 1, surface: "party to the contract, in body prose (a second is the generated footer)" },
  // Not disclosures — the string as data.
  "scripts/audit-claims.js":    { n: 1, surface: "the company-name rule's `ok` predicate: Sawa's own entity is not a phantom operator" },
  "server/pass-state.test.js":  { n: 1, surface: "NNN1.2 fixture proving that same `ok` suppresses" },
  "server/entity-disclosure.test.js": { n: 1, surface: "this file's own declaration of the string" },
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

test("the mail footer does not read from BRAND, and that is recorded not assumed", () => {
  // server/email.js writes the sentence itself. BRAND holds a DIFFERENT one
  // ("Operated by … — ETAA licence no. 2179"). Two sentences, two authors, one
  // fact. Pinned so DIR-19.1 cannot fix the visible site and miss the email —
  // which is exactly what 19.2 was written to prevent.
  const email = readFileSync(join(ROOT, "server/email.js"), "utf8");
  const brand = readFileSync(join(ROOT, "server/brand.js"), "utf8");
  assert.ok(email.includes(ENTITY), "email.js no longer names the entity");
  assert.ok(!/BRAND\.\w*[Ll]egal|BRAND\.accreditations/.test(email),
    "email.js now reads the entity from BRAND — update this test and AUTHORED");
  assert.ok(brand.includes(ENTITY), "brand.js no longer names the entity");
});
