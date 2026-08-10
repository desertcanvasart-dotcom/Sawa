// AAA1.1 — the ban on handlers that discard a failure, and proof the check
// fires, points at the right line, and does not invent hits.
//
// The check itself had three defects on its first run, all from one shortcut —
// stripping comments with `src.replace(/comment/g, "")`. It reported
// src/main.jsx:2188, which is a loading skeleton; the handler is at 2306. It
// turned `catch { /* reason */ }` into `catch {  }` and reported it as empty.
// And with no string handling it flagged a quoted `catch(e){}` inside the
// widget source this project hands to third-party sites.
//
// A check that points at the wrong line teaches the reader to distrust it, and
// a distrusted gate is removed. So the check is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankNonCode, scanCatchHandlers } from "../scripts/check-catch-handlers.js";

function fileWith(source, ext = ".js") {
  const dir = mkdtempSync(join(tmpdir(), "catch-handlers-"));
  const file = join(dir, `fixture${ext}`);
  writeFileSync(file, source);
  return file;
}
const scan = (source, ext) => scanCatchHandlers([fileWith(source, ext)]);

test("it fires on the shape that ran the mirror for years", () => {
  const hits = scan(`emitDepartureSync(id).catch(() => {});\n`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[0].name, "empty rejection handler");
});

test("every empty form is caught, including the two-line block", () => {
  // The two-line block is the one the first version missed entirely: it scanned
  // line by line, and neither line matched on its own.
  const forms = [
    `p.catch(() => {});`,
    `p.catch((e) => {});`,
    `p.catch(e => {});`,
    `p.catch(function (e) {});`,
    `try { f(); } catch {}`,
    `try { f(); } catch (e) {}`,
    `try {\n  f();\n} catch (e) {\n}`,
  ];
  for (const form of forms) {
    assert.equal(scan(`${form}\n`).length, 1, `not caught: ${JSON.stringify(form)}`);
  }
});

test("a comment is not an observable effect", () => {
  // AAA1.3. These read as decisions and are decisions — taken at write time and
  // never reported at run time. Eight of the first twenty-eight hits were this
  // shape, and all eight turned out to be real: a sitemap silently serving six
  // static URLs instead of thirty-eight looks, downstream, like a correct one.
  assert.equal(scan(`try { f(); } catch { /* DB optional */ }\n`).length, 1);
  assert.equal(scan(`try { f(); } catch (e) {\n  // live data is a bonus\n}\n`).length, 1);
});

test("a handler that substitutes a value and says why is allowed", () => {
  // The ban is on handlers that produce nothing. These produce a result the
  // rest of the program can act on, which is a decision with an outcome.
  assert.equal(scan(`p.catch(() => ({ ok: false }));\n`).length, 0);
  assert.equal(scan(`p.catch(() => []);\n`).length, 0);
  assert.equal(scan(`try { f(); } catch (e) { if (e.code !== "ENOENT") throw e; current = ""; }\n`).length, 0);
  assert.equal(scan(`try { f(); } catch (e) { warnOnce("k", "blocked", e.message); }\n`).length, 0);
});

test("the reported line survives a multi-line block comment above it", () => {
  // Defect 1, exactly. Deleting the comment deleted its newlines and shifted
  // every line number in the file after it.
  const source = `/*\n * four\n * line\n * comment\n */\nconst a = 1;\np.catch(() => {});\n`;
  const hits = scan(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 7, "the reported line no longer matches the source");
  assert.equal(source.split("\n")[hits[0].line - 1], "p.catch(() => {});");
});

test("the reported text is the RAW line, comment included", () => {
  const hits = scan(`try { f(); } catch { /* DB optional */ }\n`);
  assert.match(hits[0].text, /DB optional/, "the reader must see what they actually wrote");
});

test("a handler quoted inside a string or template is not code", () => {
  // Defect 3: src/AgencyDashboard.jsx ships widget source to third-party sites
  // as a template literal, and that source contains `catch(e){}`. It is not
  // this project's handler and this project cannot fix it.
  assert.equal(scan("const EMBED = `<script>try{s()}catch(e){}</script>`;\n").length, 0);
  assert.equal(scan(`const doc = "write p.catch(() => {}) and it fails review";\n`).length, 0);
  assert.equal(scan(`const doc = 'try { f(); } catch {}';\n`).length, 0);
});

test("a handler inside a comment is not code either", () => {
  // The original reason for stripping at all: this check, and the runbook, both
  // quote the banned expression while explaining it.
  assert.equal(scan(`// never write p.catch(() => {});\nconst a = 1;\n`).length, 0);
  assert.equal(scan(`/*\n  p.catch(() => {});\n*/\nconst a = 1;\n`).length, 0);
});

test("a regex containing a quote does not derail the scanner", () => {
  // The failure mode that matters most and shows up as nothing: an unhandled
  // regex literal opens a string span that never closes, the rest of the file
  // is blanked, and the check reports clean. Same shape as the glob check that
  // found zero files and exited 0.
  const source = `const q = /["']/g;\nconst r = /\\/\\//;\np.catch(() => {});\n`;
  const hits = scan(source);
  assert.equal(hits.length, 1, "a regex swallowed the rest of the file");
  assert.equal(hits[0].line, 3);
});

test("division is not mistaken for a regex", () => {
  const source = `const half = total / 2;\nconst r = count / n / 2;\np.catch(() => {});\n`;
  assert.equal(scan(source).length, 1);
});

test("a regex after `return` is still a regex", () => {
  const source = `function f() { return /['"]/.test(s); }\np.catch(() => {});\n`;
  assert.equal(scan(source).length, 1);
});

test("blanking preserves every character position", () => {
  // The invariant the blanker asserts at run time, asserted here on the shapes
  // that break naive stripping. If a position is lost, every line number after
  // it is a lie.
  for (const source of [
    `/* a */ const a = 1; // b\n"str"\n\`tpl ${"${x}"}\`\n/re/g\n`,
    `const s = "unterminated`,
    `const c = /* unterminated`,
    `const t = \`multi\nline\ntemplate\`;\n`,
  ]) {
    const out = blankNonCode(source);
    assert.equal(out.length, source.length, `length changed for ${JSON.stringify(source)}`);
    assert.equal(out.split("\n").length, source.split("\n").length, "line count changed");
  }
});

test("blanking removes only what is not code", () => {
  const out = blankNonCode(`const a = 1; // note\nconst b = "text";\n`);
  assert.match(out, /const a = 1;/);
  assert.match(out, /const b = /);
  assert.ok(!out.includes("note"), "a comment survived");
  assert.ok(!out.includes("text"), "a string body survived");
});

test("a scan with nothing to scan must fail, not pass", () => {
  // scripts/run-tests.js learned this the expensive way: an empty run exits 0
  // and reads exactly like a clean one.
  assert.throws(() => scanCatchHandlers([]), /no files to scan/);
});

test("the repository has no handler that discards a failure", () => {
  // The ratchet. `npm run check:catch-handlers` is in preflight; this is the
  // same assertion inside the unit suite, so a reintroduction fails at the
  // pre-commit hook rather than at deploy time.
  const started = Date.now();
  const problems = scanCatchHandlers();
  assert.deepEqual(
    problems.map((p) => `${p.file}:${p.line}`),
    [],
    "an empty handler is redundant if the function does not throw, and a bug if it does"
  );

  // The first blanker was quadratic in file length and did not finish on
  // src/main.jsx — while passing every test above, because a three-line fixture
  // cannot show it. A gate that hangs is worse than one that fails: it reads as
  // a stuck machine, and the fix people reach for is to stop running it.
  // The real scan takes about 0.2s; this fires on an algorithmic regression,
  // not on a slow machine.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `the repository scan took ${elapsed}ms`);
});
