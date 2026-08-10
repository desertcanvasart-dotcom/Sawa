// DIR-7 — a catalogue that cannot be incomplete.
//
// The hand-maintained one listed five duplications and six existed. A written
// list of copies has the same defect as the copies: somebody has to remember,
// and the one nobody remembers is the one that drifts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authorities, duplications, GENERATED } from "../scripts/check-duplication.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (src, name = "x.js") => {
  const dir = mkdtempSync(join(tmpdir(), "dup-"));
  const f = join(dir, name);
  writeFileSync(f, src);
  return f;
};
const owned = new Map([["seatsTotal", "shared/departure-state.js"]]);

test("the authority list is derived from shared/, not written down", () => {
  const a = authorities();
  assert.ok(a.size >= 10, `only ${a.size} authorities — shared/ is not being read`);
  for (const n of ["seatsTotal", "statusFor", "tourSlug", "DEFAULT_GO_AHEAD"]) {
    assert.ok(a.has(n), `${n} is exported by shared/ and the catalogue cannot see it`);
  }
});

test("it fires on a second implementation", () => {
  const f = fixture("function seatsTotal(p) { return p.length; }\n");
  const d = duplications([f], owned);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "second implementation");
});

test("it fires on a const form too", () => {
  assert.equal(duplications([fixture("const seatsTotal = (p) => p.length;\n")], owned).length, 1);
});

test("it stops on a correct import", () => {
  const f = fixture('import { seatsTotal } from "../shared/departure-state.js";\nseatsTotal([]);\n');
  assert.deepEqual(duplications([f], owned), []);
});

test("it stops on a mere call — using it is not redeclaring it", () => {
  assert.deepEqual(duplications([fixture("const n = seatsTotal(pledges);\n")], owned), []);
});

test("it does not match its own explanation", () => {
  // Every fix here is explained beside the thing it fixed, so these names appear
  // in comments constantly. The catch-handler checker had to learn the same
  // lesson about its own header.
  const f = fixture("// function seatsTotal(p) is the authority in shared/\n/* const seatsTotal = … */\n");
  assert.deepEqual(duplications([f], owned), []);
});

test("generated files are exempt — they must contain the declarations", () => {
  assert.ok(GENERATED.has("site/assets/slug.js"));
  assert.ok(GENERATED.has("site/assets/rules.js"));
  // And their currency is guarded elsewhere, or the exemption would be a hole.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts["check:slug"], "no check keeps the generated slug file current");
  assert.ok(pkg.scripts["check:rules"], "no check keeps the generated rules file current");
});

test("nothing outside shared/ declares an authority's name", () => {
  assert.deepEqual(duplications().map((d) => `${d.file}: ${d.name}`), []);
});

test("the blog slug is a separate rule, and stays out of the browser bundle", () => {
  // A tour slug drops stop-words and appends the origin city; a blog slug must
  // round-trip an editor's title. They look alike and must not be merged.
  const blog = readFileSync(join(ROOT, "shared", "blog-slug.js"), "utf8");
  assert.match(blog, /\|\| "post"/, "the server's fallback is the authority's behaviour");
  const generated = readFileSync(join(ROOT, "site", "assets", "slug.js"), "utf8");
  assert.ok(!/blogSlug/.test(generated),
    "admin-only logic must not ship to every visitor");
});
