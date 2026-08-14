// DDD1 — the evidence-expiry register, and the entries a commit can arm.
//
// An argument from absence stops holding the moment the absent thing exists,
// silently, with nothing to announce it. The register records what would arm
// each one. This re-checks the conditions that are REPOSITORY facts, so those
// entries fail the gate rather than going quiet — a document alone would drift,
// which is the failure the register exists to prevent, one level up.
//
// The entries resting on production state (E-2 pledges, E-4 pg_stat_statements,
// E-9 audit_log counters) cannot be checked from here and are not pretended to
// be. That limit is stated in the register itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BANNED } from "../scripts/check-catch-handlers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = readFileSync(join(ROOT, "docs", "audit", "evidence-expiry.md"), "utf8");

const entries = REGISTER.split(/^### (E-\d+) — /m).slice(1);
const ENTRIES = [];
for (let i = 0; i < entries.length; i += 2) ENTRIES.push({ id: entries[i], body: entries[i + 1] });

function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(js|jsx)$/.test(e)) out.push(full);
  }
  return out;
}
const FILES = ["server", "src", "scripts", "shared"].flatMap((r) => sources(join(ROOT, r)));

// The INTERPOLATIONS inside template literals — `${…}` — and nothing else.
//
// The first version of this scanned whole template literals and flagged twenty
// spans, every one of them a fixture in the checker's own test or a phrase
// quoted in backticks inside a comment. That was the check being wrong, not the
// code: E-6's claim is about `${…}`, whose contents are EXECUTED and therefore
// could be a real handler. The literal text around it is inert data, and a
// scanner fixture is exactly the inert data this repository is full of.
//
// Written out rather than fixed with an exemption list, because an exemption
// list would have hidden the fact that the check did not match the claim.
//
// Deliberately its own reader rather than reusing blankNonCode: that function's
// whole job is to make these invisible, so asking it would be circular.
function interpolations(src) {
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== "`") continue;
    for (i += 1; i < src.length && src[i] !== "`"; i += 1) {
      if (src[i] === "\\") { i += 1; continue; }
      if (src[i] !== "$" || src[i + 1] !== "{") continue;
      const start = (i += 2);
      for (let depth = 1; i < src.length && depth > 0; i += 1) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") depth -= 1;
        if (depth === 0) out.push(src.slice(start, i));
      }
    }
  }
  return out;
}

test("the register has entries, and every one carries all five fields", () => {
  assert.ok(ENTRIES.length >= 8, `only ${ENTRIES.length} entries — the parser or the register is broken`);
  for (const { id, body } of ENTRIES) {
    for (const field of ["**Status**", "**The claim**", "**Rests on**", "**What would arm it**", "**Where that is defined**"]) {
      assert.ok(body.includes(field), `${id} has no ${field} — an entry missing one is not an entry`);
    }
  }
});

test("every entry declares LIVE or EXPIRED with a date", () => {
  for (const { id, body } of ENTRIES) {
    const status = body.split("**Status**")[1]?.split("\n")[0] || "";
    assert.ok(/LIVE|EXPIRED \d{4}-\d{2}-\d{2}/.test(status), `${id}: status is "${status.trim()}"`);
  }
});

test("E-1 is recorded as expired, and the thing that expired it still exists", () => {
  // The entry that proves the register's point. If someone reverts
  // setLoginAccess to a one-way revoke, E-1's premise becomes true again and
  // this register would be wrong in the other direction — so it is pinned from
  // both sides rather than trusted.
  const e1 = ENTRIES.find((e) => e.id === "E-1");
  assert.match(e1.body.split("**Status**")[1].split("\n")[0], /EXPIRED 2026-08-10/);

  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  assert.match(app, /ban_duration: allowed \? "none" : "876000h"/,
    "E-1 says a ban can now be lifted; nothing in app.js lifts one");
});

test("E-6 — no empty handler is hiding inside a template expression", () => {
  // The checker blanks `${…}` with its template and says so. This is the only
  // thing that would notice one appearing.
  const found = [];
  for (const file of FILES) {
    for (const span of interpolations(readFileSync(file, "utf8"))) {
      for (const { re } of BANNED) {
        re.lastIndex = 0;
        if (re.test(span)) found.push(relative(ROOT, file));
      }
    }
  }
  assert.deepEqual([...new Set(found)], [],
    "E-6 is ARMED — an empty handler now lives where check:catch-handlers cannot see it. Update the register and fix the checker.");
});

test("E-6's check fires — proven, not assumed", () => {
  // W3. A check that finds nothing and has never been shown to find anything is
  // indistinguishable from a check that cannot find anything. The first version
  // of E-6's scan flagged twenty fixtures and zero real handlers; this is what
  // stops the corrected version from flagging nothing at all, forever.
  const planted = "const html = `<p>${ load().catch(() => {}) }</p>`;";
  const spans = interpolations(planted);
  assert.equal(spans.length, 1, "the interpolation reader found nothing to read");
  assert.ok(BANNED.some(({ re }) => { re.lastIndex = 0; return re.test(spans[0]); }),
    "a handler planted inside ${…} was not caught");

  // And the inert case it must NOT flag: fixture text in a template, which is
  // what the first version got wrong.
  assert.deepEqual(interpolations("const fixture = `p.catch(() => {});`;"), [],
    "literal template text is data, not code");
});

test("E-7 — no regex literal follows a closing parenthesis", () => {
  // `if (x) /re/.test(y)` — the blanker reads `)` as a value, calls the slash
  // division, and blanks to end of line, hiding anything real on it.
  const found = [];
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    // A `)` then whitespace then a slash that is not a comment or an assignment.
    if (/\)\s+\/(?![/*=\s])/.test(src.replace(/^\s*\/\/.*$/gm, ""))) found.push(relative(ROOT, file));
  }
  assert.deepEqual(found, [],
    "E-7 may be ARMED — a regex after a closing paren would be misread as division. Check the hit and update the register.");
});

test("the register is reachable from the directives", () => {
  // A register nobody finds is a register nobody updates.
  const directives = readFileSync(join(ROOT, "docs", "audit", "open-directives.md"), "utf8");
  assert.match(directives, /evidence-expiry\.md/, "nothing points at the evidence-expiry register");
});

test("E-2 is recorded as expired, and the four dependents carry the same date", () => {
  // Until 2026-08-12 this test asserted the load-bearing sentence was still
  // cited verbatim in its dependents — the watch that would notice a citation
  // quietly disappearing before the seed. Five pledge rows landed that day, so
  // it now pins the other side, the way E-1's test does: the register says
  // EXPIRED, and every dependent is bounded by the one date. A present-tense
  // "never held a row" reappearing anywhere would be the old claim un-restated.
  const e2 = ENTRIES.find((e) => e.id === "E-2");
  assert.match(e2.body.split("**Status**")[1].split("\n")[0], /EXPIRED 2026-08-12/);
  for (const file of ["scripts/audit-claims.js", "docs/audit/legal-register.md",
    "docs/audit/cancel-job-rehearsal.md", "docs/audit/evidence-expiry.md"]) {
    assert.match(readFileSync(join(ROOT, ...file.split("/")), "utf8"),
      /E-2 ENDED 2026-08-12/, `${file} does not carry the restatement marker`);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, "scripts", "audit-claims.js"), "utf8"),
    /pledges has never held a row/, "the volume rule still states the expired premise");
});
