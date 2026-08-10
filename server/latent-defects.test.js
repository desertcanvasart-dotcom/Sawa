// DIR-3 — the latent-defect register.
//
// A latent defect is real in the code and unreachable, because some unrelated
// invariant holds it closed. The register exists for one failure: an invariant
// relaxed for a good reason by someone who has no idea what was resting on it.
//
// A document alone drifts, which is the failure it exists to prevent, one level
// up. This asserts the shape, and re-checks the masks that are repository facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = readFileSync(join(ROOT, "docs", "audit", "latent-defects.md"), "utf8");

const parts = REGISTER.split(/^### (L-\d+) — /m).slice(1);
const ENTRIES = [];
for (let i = 0; i < parts.length; i += 2) ENTRIES.push({ id: parts[i], body: parts[i + 1] });

test("the register has entries, and every one carries all four fields", () => {
  assert.ok(ENTRIES.length >= 8, `only ${ENTRIES.length} entries — the parser or the register is broken`);
  for (const { id, body } of ENTRIES) {
    for (const field of ["**What is divergent**", "**What masks it**", "**What would arm it**", "**Where that is defined**"]) {
      assert.ok(body.includes(field), `${id} has no ${field} — an entry missing one is not an entry`);
    }
  }
});

test("L-1's mask is still in the schema", () => {
  // "a pledge with no seats counts as one traveller", held closed by the column
  // being NOT NULL. If that ever relaxes, the register must be revisited before
  // the change lands, not after.
  const schema = readFileSync(join(ROOT, "server", "db", "schema.sql"), "utf8");
  assert.match(schema, /seats\s+INTEGER NOT NULL CHECK \(seats >= 1\)/,
    "L-1 is armed: pledges.seats is no longer NOT NULL");
});

test("L-3's mask is still in place — every read enriches", () => {
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  assert.match(app, /return enrichDeparture\(mapDeparture\(dep\.rows\[0\], pledges\.rows\), product\)/,
    "L-3 is armed: loadDeparture no longer recomputes status before serving");
});

test("L-4 is still unwritten — the columns exist and nothing fills them", () => {
  for (const f of ["server/app.js", "server/departure-cancel.js", "server/jobs/cancel-unconfirmed.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/cancelled_reason/.test(src),
      `${f} now writes cancelled_reason — L-4's precedence rule applies from this commit`);
  }
});

test("L-5's bound is what the register says it is", () => {
  const sync = readFileSync(join(ROOT, "server", "autoura-sync.js"), "utf8");
  assert.match(sync, /MAX_REMEMBERED = 50/,
    "the register quotes 50 remembered divergences; the code disagrees");
});

test("L-9's two implementations are still two", () => {
  // Recorded as open. If someone unifies them, the entry should be moved to the
  // closed list rather than left implying a defect that no longer exists.
  const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  const spa = readFileSync(join(ROOT, "src", "main.jsx"), "utf8");
  assert.match(app, /function cleanRefCode\(/);
  assert.match(spa, /function cleanRef\(/);
});

test("the closed entries name what closed them", () => {
  const closed = REGISTER.slice(REGISTER.indexOf("## Closed, kept as worked examples"));
  assert.ok(closed.length > 400, "the closed section is missing or empty");
  // Each row must say what closed it, or it is a defect list rather than a
  // register of reasoning.
  for (const line of closed.split("\n").filter((l) => l.startsWith("| **"))) {
    assert.ok(line.split("|").length >= 4, `a closed row without a cause: ${line.slice(0, 70)}`);
  }
});

test("the register is reachable from the directives", () => {
  const d = readFileSync(join(ROOT, "docs", "audit", "open-directives.md"), "utf8");
  assert.match(d, /latent-defects\.md/, "nothing points at the latent-defect register");
});
