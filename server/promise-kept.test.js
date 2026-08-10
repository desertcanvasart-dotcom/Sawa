// OOO1.2 — a promise about the interface, checked against the data.
//
// The rule found sentences and stopped. Its own `why` said "assert X renders"
// and nothing did, so it could report that a promise EXISTS and never whether
// it is KEPT.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unmetPromises, thingsNamedIn, coverageState, promisesIn, visibleBlocks } from "../scripts/audit-promises.js";
import { INTERFACE_PROMISES } from "../scripts/audit-page.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A payload shaped like /api/bootstrap: prices everywhere, itineraries on some,
// no operator records at all — which is production today.
const PAYLOAD = {
  agencies: [],
  tourProducts: [
    { id: "a", publishedRate: 100, itinerary: [{ day: 1 }] },
    { id: "b", publishedRate: 120, itinerary: [] },
    { id: "c", publishedRate: 90 },
  ],
};
const promise = (match, where = "fixture.html") => [{ where, match }];

test("it fires — copy promises a rating and no product carries one", () => {
  const f = unmetPromises(promise("you'll see their rating on every departure"), PAYLOAD);
  assert.equal(f.length, 1);
  assert.equal(f[0].thing, "rating");
  assert.equal(f[0].state, "unmet");
  assert.match(f[0].why, /present on 0 of 3/);
});

test("it fires — PARTIAL is its own state, not rounded to either end", () => {
  // "kept on some" is not "kept". Rounding down cries wolf; rounding up is the
  // FAQ promise that rendered on 0 of 14 and passed for months.
  const f = unmetPromises(promise("the itinerary is shown on every departure"), PAYLOAD);
  assert.equal(f[0].state, "partial");
  assert.equal(f[0].have, 1);
  assert.equal(f[0].total, 3);
});

test("it stops — a promise the data actually keeps", () => {
  assert.deepEqual(unmetPromises(promise("prices are shown on every departure"), PAYLOAD), []);
});

test("one sentence promising three things is three promises", () => {
  // The FAQ sentence. Reported as one, whichever half is kept would hide the
  // other — and name, licence and rating had three different answers.
  assert.deepEqual(thingsNamedIn("you'll see their name, license status and rating on every departure").sort(),
    ["licence", "name", "rating"]);
  const f = unmetPromises(promise("you'll see their name, license status and rating on every departure"), PAYLOAD);
  assert.equal(f.length, 3, "each promised thing must be reported on its own");
});

test("no products means no-data, which is not a pass", () => {
  const f = unmetPromises(promise("prices are shown on every departure"), { agencies: [], tourProducts: [] });
  assert.equal(f[0].state, "no-data");
  assert.equal(coverageState(0, 0), "no-data");
});

test("an operator record with a licence keeps the promise — nothing asserts absence", () => {
  // When migration 025 is applied and licences are recorded, this starts
  // passing with no edit here. A probe hard-coded to false would be a claim
  // about today that outlives today.
  const withLicence = {
    agencies: [{ id: "ag", name: "Real Operator", tourismLicenseNo: "1234" }],
    tourProducts: [{ id: "a", agencyId: "ag", publishedRate: 100 }],
  };
  assert.deepEqual(unmetPromises(promise("you'll see their name and license status"), withLicence), []);
});

// ---------------------------------------------------------------------------
// The two false positives the first run produced, pinned so they cannot return.
test("it stops — 'Ministry-licensed operator' is an adjective, not a UI promise", () => {
  assert.deepEqual(thingsNamedIn("listed by a Ministry-licensed operator"), [],
    "the copy says the operator HOLDS a licence; it does not promise you will see one");
});

test("it stops — a promise cannot span a heading and the paragraph under it", () => {
  const html = `<h2>5. Information shown on the Platform</h2>
    <p>We take reasonable care to ensure that itinerary descriptions are accurate.</p>`;
  const found = promisesIn(html, "terms.html", INTERFACE_PROMISES);
  assert.deepEqual(found.flatMap((p) => thingsNamedIn(p.match)), [],
    "the verb came from the heading and the noun from the paragraph — visibleText joins them");
  assert.ok(visibleBlocks(html).length >= 2, "the heading and the paragraph must be separate blocks");
});

// ---------------------------------------------------------------------------
test("the live copy makes promises, and the scan is not looking at nothing", () => {
  const pages = readdirSync(join(ROOT, "site")).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 10, `only ${pages.length} pages`);
  const found = pages.flatMap((f) =>
    promisesIn(readFileSync(join(ROOT, "site", f), "utf8"), f, INTERFACE_PROMISES));
  assert.ok(found.length > 0,
    "no interface promise found anywhere — the scanner is looking at the wrong thing, "
    + "not the site having stopped making promises");
});
