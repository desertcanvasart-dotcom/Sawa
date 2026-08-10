// DIR-13 — proving `smoke`'s per-route assertions fire.
//
// `smoke` needs a running site, so it is UNVERIFIED in CI and its assertions
// had never been exercised anywhere. What it checks does not need a target: it
// is a function from (status, html) to a list of problems.
//
// Every case below is a page that is wrong in exactly one way.
import test from "node:test";
import assert from "node:assert/strict";
import { checkRoute, groupSizeProblems } from "../scripts/smoke-routes.js";
import { MAX_GROUP_SIZE, DEFAULT_GO_AHEAD } from "../shared/group-size.js";

const OK = `<title>A real page — Sawa</title>
<meta name="description" content="Something specific about this page." />
<script type="application/ld+json">{"@type":"WebPage","name":"x"}</script>
<p>Small groups, never more than ${MAX_GROUP_SIZE}.</p>`;

const fires = (html, re, status = 200) => {
  const problems = checkRoute("/x", status, html);
  assert.ok(problems.some((p) => re.test(p)), `expected ${re}, got: ${JSON.stringify(problems)}`);
};

test("it stops — a well-formed page reports nothing", () => {
  assert.deepEqual(checkRoute("/x", 200, OK), []);
});

test("it fires — the wrong HTTP status", () => fires(OK, /HTTP 500, expected 200/, 500));
test("it fires — no <title>", () => fires(OK.replace(/<title>.*<\/title>/, ""), /no <title>/));
test("it fires — no meta description", () => fires(OK.replace(/<meta[^>]*>/, ""), /no <meta name=description>/));
test("it fires — no JSON-LD", () => fires(OK.replace(/<script[\s\S]*?<\/script>/, ""), /no JSON-LD/));
test("it fires — JSON-LD that does not parse", () =>
  fires(OK.replace(/\{"@type[^<]*/, "{not json"), /JSON-LD does not parse/));
test("it fires — a JSON-LD node with no @type", () =>
  fires(OK.replace(/\{"@type":"WebPage",/, "{"), /JSON-LD node without @type/));

test("it fires — a ceiling the code does not hold", () => {
  const wrong = MAX_GROUP_SIZE + 4;
  fires(OK.replace(`never more than ${MAX_GROUP_SIZE}`, `never more than ${wrong}`),
    new RegExp(`states a ceiling of ${wrong}`));
});

test("it fires — a floor below the GoAhead threshold", () => {
  assert.ok(groupSizeProblems(`a minimum of ${DEFAULT_GO_AHEAD - 2} travelers`)
    .some((p) => /below the floor/.test(p)));
});

test("the number is read, not the phrasing — word forms count too", () => {
  assert.ok(groupSizeProblems("never more than twenty").length, "spelled-out ceilings must be read");
  assert.deepEqual(groupSizeProblems("never more than twelve"), [],
    "the correct ceiling in words must not be flagged");
});

test("group-size prose is read from the visible page, not from script tags", () => {
  // A JSON blob carrying a different number is data, not a claim to a reader.
  // Measuring markup as prose is a mistake this project has already made once.
  assert.deepEqual(checkRoute("/x", 200,
    `${OK}<script>var config = {"maximum of 40": true};</script>`), []);
});
