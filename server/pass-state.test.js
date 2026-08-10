// NNN1.2 — the pass-state audit.
//
// W3 asks whether a check FIRES. NNN1's second half asks whether it can PASS,
// and the failure it names is quieter than a missing check: a rule that reports
// findings forever on correct copy gets baselined within a fortnight, and takes
// the real class down with it.
//
// It has already happened twice here. INTERFACE_PROMISES flagged "you'll see
// the desert's famous mirages" — travel prose, not a promise about the site.
// The `availability` rule flagged all nine renderings of the ONE agreed string
// after the four contradictory ones were fixed; its own comment records the
// lesson: *"a check that cannot pass when the defect is fixed is not measuring
// the defect."*
//
// `audit:claims` carries eleven rules and needs a live site, so it is
// UNVERIFIED in CI. Nine of the eleven had no test of either kind. This proves
// both states for all eleven, offline, against real copy.
//
// ---------------------------------------------------------------------------
// DERIVED FROM `RULES`. Adding a rule without proving both states fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, scan, visibleText } from "../scripts/audit-claims.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// [ text that MUST fire the rule, text that matches the pattern but MUST NOT be
// reported ]. The second entry is null for a rule with no `ok` predicate —
// there is no exception path to exercise.
const FIXTURES = {
  "guarantee": [
    "Every Sawa departure is guaranteed to run.",
    "We do not guarantee that a date ever reaches its minimum."],
  "absolute-claim": [
    "A 100% guaranteed, risk-free booking.", null],
  "rating": [
    "Our operators hold a 4.8 out of 5 average rating.", null],
  "volume": [
    "Over 12,000 travellers hosted since we began.", null],
  "tenure": [
    "15 years operating in Egypt.", null],
  "availability": [
    "Our team is available around the clock.",
    "Reach us on WhatsApp, answered 24/7 — around the clock is not how we say it."],
  "verified-status": [
    "Book with confidence from our verified operators.",
    "We verify this licence with the Ministry before any operator is approved."],
  "seed-operator": [
    "Operated by Nile Gate Travel.", null],
  "company-name": [
    "Operated by Pyramid Sun Tours on the ground.",
    "Capital Travel Service, trading as Sawa Tours."],
  "phantom-payment-process": [
    "A pending charge may appear on your statement.",
    "Access-Control-Allow-Headers: Content-Type,Authorization"],
  "universal-threshold": [
    "Every date confirms at minimum travellers.",
    "A date confirms when it reaches its minimum travellers."],
};

const fires = (text, id) => scan(text, "fixture").some((h) => h.rule === id);

test("every rule has a fixture — a rule added without one is not proved", () => {
  const missing = RULES.map((r) => r.id).filter((id) => !FIXTURES[id]);
  assert.deepEqual(missing, [],
    `these rules have no fixture: ${missing.join(", ")}\n`
    + `Add [firing case, exception case-or-null] to FIXTURES. A rule nobody has `
    + `shown to fire, or shown to pass, is a rule that will be baselined.`);
});

test("and no fixture outlives its rule", () => {
  const ids = new Set(RULES.map((r) => r.id));
  const stale = Object.keys(FIXTURES).filter((id) => !ids.has(id));
  assert.deepEqual(stale, [], `FIXTURES names rules that no longer exist: ${stale.join(", ")}`);
});

test("it fires — every one of the eleven catches the claim it exists for", () => {
  const silent = RULES.filter((r) => !fires(FIXTURES[r.id][0], r.id)).map((r) => r.id);
  assert.deepEqual(silent, [], `these rules did not fire on their own fixture: ${silent.join(", ")}`);
});

test("it passes — every `ok` predicate actually suppresses something", () => {
  // The NNN1.2 case proper. A rule whose exception path never triggers has no
  // escape hatch: correct copy that matches the pattern is unwritable, and the
  // rule gets suppressed instead of the copy getting fixed.
  const withOk = RULES.filter((r) => typeof r.ok === "function");
  assert.ok(withOk.length >= 5, `only ${withOk.length} rules carry an ok predicate`);
  const broken = withOk.filter((r) => {
    const pass = FIXTURES[r.id][1];
    return pass == null || fires(pass, r.id);
  }).map((r) => r.id);
  assert.deepEqual(broken, [],
    `these rules have an \`ok\` predicate that does not suppress their own fixture: ${broken.join(", ")}`);
});

test("a rule with no `ok` predicate is declared so, not left ambiguous", () => {
  // A null second fixture is a claim: "this pattern has no legitimate form."
  // If such a rule later grows an `ok`, this fails and the fixture must be
  // written — the exception cannot be added silently.
  const undeclared = RULES.filter((r) => typeof r.ok !== "function" && FIXTURES[r.id][1] !== null)
    .map((r) => r.id);
  assert.deepEqual(undeclared, [],
    `these rules have no \`ok\` predicate but carry an exception fixture: ${undeclared.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The pass state that matters most: real copy, not a fixture.
test("every rule is silent on the site's own published copy", () => {
  const pages = readdirSync(join(ROOT, "site")).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 10, `only ${pages.length} static pages — refusing to report clean`);

  const corpus = pages.map((f) => ({ f, text: visibleText(readFileSync(join(ROOT, "site", f), "utf8")) }));
  const chars = corpus.reduce((n, x) => n + x.text.length, 0);
  assert.ok(chars > 50_000, `only ${chars} chars of visible copy — the corpus is too thin to prove a pass state`);

  const findings = corpus.flatMap(({ f, text }) =>
    scan(text, f).map((h) => `${h.rule}  ${f}: ${JSON.stringify(h.match)}`));

  assert.deepEqual(findings, [],
    `a rule fires on copy that is live and believed correct:\n  ${findings.join("\n  ")}\n\n`
    + `Either the copy is wrong, or the rule is — and a rule in this state gets `
    + `baselined, which is how the class it protects stops being protected.`);
});

// ---------------------------------------------------------------------------
test("it fires — a rule with no fixture is reported, not skipped", () => {
  // The guard above asserts an empty list, which is also what a guard looking at
  // the wrong thing would produce. This plants the case it exists to catch.
  const invented = [{ id: "rule-nobody-proved" }, ...RULES];
  const missing = invented.map((r) => r.id).filter((id) => !FIXTURES[id]);
  assert.deepEqual(missing, ["rule-nobody-proved"],
    "a rule with no fixture must be reported by name");
});

test("the exception path is what a pass state IS — exercised in isolation", () => {
  // `availability` before DIR-17.1 was a rule whose pattern matched the correct
  // copy and whose `ok` never fired. That is the shape NNN1.2 names, so it is
  // worth pinning that `ok` is consulted at all rather than assumed.
  //
  // The first version of this test passed a `rules` option `scan` did not
  // accept, so it scanned with the REAL eleven and asserted nothing. `rules` is
  // now injectable — the fix belonged in the scanner, not in the assertion.
  const re = () => /always/gi;
  const noEscape = { id: "cannot-pass", why: "a rule with no way to be satisfied", re: re(), ok: () => false };
  const escapes  = { id: "can-pass",    why: "the same rule, with a working exception", re: re(), ok: () => true };

  assert.equal(scan("this always matches", "f", { rules: [noEscape] }).length, 1,
    "a rule whose ok never fires reports on every match — this is the baseline-me state");
  assert.deepEqual(scan("this always matches", "f", { rules: [escapes] }), [],
    "an ok predicate returning true must suppress the finding");
});
