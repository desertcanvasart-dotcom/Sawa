// Fetches every public route and fails if one of them is not actually serving.
//
// This exists because "tests pass" and "routes serve" have now diverged twice,
// both times silently:
//
//   1. Deleting STATIC["/"] from seo.js — which was the DEFAULT title and
//      description for every route without an entry, not the config for "/" —
//      made buildHead() throw on every SPA route. /itineraries, /blog and
//      /booking served the bare shell: no title, no description, no JSON-LD.
//      The source parsed. All 176 unit tests passed.
//
//   2. A claim "corrected" in config that no route consumes, twice, while the
//      served string sat untouched.
//
// Unit tests check units. This checks that a visitor and a crawler get a page.
// Neither substitutes for the other, and this one is cheap.
//
//   node scripts/smoke-routes.js
//   node scripts/smoke-routes.js --base=https://sawa.tours
//
// Exits non-zero on any failure, so it can gate a deploy.
import { publicRoutes } from "./audit-claims.js";
import { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE, numberWord } from "../shared/group-size.js";

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = arg("base", "http://localhost:8795").replace(/\/$/, "");

// The raw Vite shell. If this is the served title, head injection failed and
// the route fell back — the exact signature of failure (1) above.
const SHELL_TITLE = "Sawa Shared Tours";

const tag = (html, re) => (html.match(re)?.[1] ?? "").trim();

// W1.2 — the group-size numbers, observed in SERVED output.
//
// check:constants reads the static HTML source, which makes it a pointer: it can
// only catch phrasings its rules already know. It missed "Travel in a group of
// 4–8 with one guide" on /how-it-works — a ceiling of eight against a database
// constraint of twelve — because its range rule expected the word "travellers"
// after the numbers.
//
// This reads what the route actually serves and checks the NUMBER, so it does
// not care how the sentence is phrased.
const NUM = String.raw`\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty`;
const asNumber = (t) => {
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
    "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
  return words.indexOf(String(t).toLowerCase());
};

export function groupSizeProblems(text) {
  const out = [];
  // A stated ceiling: "never more than N", "maximum of N", "group of X–N".
  for (const re of [new RegExp(String.raw`never (?:more than|above) (${NUM})`, "gi"),
                    new RegExp(String.raw`(?:maximum|max\.) of (${NUM})`, "gi"),
                    new RegExp(String.raw`(?:group|groups|party) of \d+\s*[–—-]\s*(\d+)`, "gi"),
                    new RegExp(String.raw`(\d+)\s+(?:seats?|travell?ers?) maximum`, "gi")]) {
    for (const m of text.matchAll(re)) {
      const n = asNumber(m[1]);
      if (n > 0 && n !== MAX_GROUP_SIZE) out.push(`states a ceiling of ${m[1]} — MAX_GROUP_SIZE is ${MAX_GROUP_SIZE} ("${m[0].trim()}")`);
    }
  }
  // A stated floor: the threshold may be HIGHER per product, never lower.
  for (const re of [new RegExp(String.raw`(?:minimum|min\.) of (${NUM})`, "gi")]) {
    for (const m of text.matchAll(re)) {
      const n = asNumber(m[1]);
      if (n > 0 && n < DEFAULT_GO_AHEAD) out.push(`states a minimum of ${m[1]}, below the floor of ${DEFAULT_GO_AHEAD} ("${m[0].trim()}")`);
    }
  }
  return out;
}

function checkRoute(route, status, html, expectStatus = 200) {
  const problems = [];
  if (status !== expectStatus) problems.push(`HTTP ${status}, expected ${expectStatus}`);

  const title = tag(html, /<title>([\s\S]*?)<\/title>/i);
  if (!title) problems.push("no <title>");
  else if (title === SHELL_TITLE) problems.push(`raw shell title — head injection failed`);

  const desc = tag(html, /<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!desc) problems.push("no <meta name=description>");

  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  problems.push(...groupSizeProblems(visible));

  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) problems.push("no JSON-LD");
  for (const [, raw] of blocks) {
    try {
      const parsed = JSON.parse(raw);
      const nodes = parsed["@graph"] || (Array.isArray(parsed) ? parsed : [parsed]);
      if (!nodes.length) problems.push("JSON-LD is empty");
      if (nodes.some((n) => !n || !n["@type"])) problems.push("JSON-LD node without @type");
    } catch (e) {
      problems.push(`JSON-LD does not parse: ${e.message}`);
    }
  }
  return problems;
}

// X2/Y1 — assert the RUNNING configuration, read with credentials.
//
// /api/modes is behind requireAuth: the drift argument needs visibility, not
// public visibility. Supply a token with SMOKE_TOKEN (a Supabase access token
// for any signed-in user).
//
// THREE STATES, not two. "Could not check" must never render as "clean" — that
// is the failure this project keeps finding, most recently a repo-truth
// collector that found zero statements on Node 20 and exited 0. So:
//
//   verified      modes read and every expectation matched
//   FAILED        modes read and an expectation did not match, or unreachable
//   UNVERIFIED    no credentials — reported loudly, and a FAILURE if the caller
//                 asked for specific expectations, because a demand that cannot
//                 be evaluated has not been met
const expectations = Object.fromEntries(
  (arg("expect", "").split(",").filter(Boolean)).map((pair) => pair.split("=").map((x) => x.trim())));
const token = process.env.SMOKE_TOKEN || "";

let modeFailures = 0;
let modeState = "UNVERIFIED";
if (!token) {
  if (Object.keys(expectations).length) {
    console.error(`FAIL /api/modes — ${Object.keys(expectations).length} expectation(s) given but SMOKE_TOKEN is not set, so none could be evaluated`);
    modeFailures++;
  } else {
    console.warn("UNVERIFIED /api/modes — SMOKE_TOKEN not set; the running configuration was NOT checked");
  }
} else {
  try {
    const res = await fetch(`${BASE}/api/modes`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      console.error(`FAIL /api/modes — ${res.status}; SMOKE_TOKEN was rejected, configuration NOT checked`);
      modeFailures++;
    } else {
      const body = await res.json();
      if (!body.modes) {
        console.error("FAIL /api/modes reports no resolved modes — the running configuration is unobservable");
        modeFailures++;
      } else {
        modeState = "verified";
        console.log(`Resolved modes: ${Object.entries(body.modes).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        for (const [key, want] of Object.entries(expectations)) {
          const got = body.modes[key];
          if (String(got) !== want) {
            console.error(`FAIL /api/modes ${key} is "${got}", expected "${want}"`);
            modeFailures++;
          }
        }
      }
    }
  } catch (e) {
    console.error(`FAIL /api/modes unreachable — ${e.message}`);
    modeFailures++;
  }
}

// And the split itself is asserted: /api/health must NOT leak modes.
try {
  const open = await (await fetch(`${BASE}/api/health`)).json();
  if (open.modes) {
    console.error("FAIL /api/health exposes resolved modes to an unauthenticated caller");
    modeFailures++;
  }
} catch (e) {
  // AAA1.3 — a check that silently did not run is reported identically to one
  // that ran and passed, so it says so.
  //
  // CCC3.1 — and it COUNTS. Saying "skipped" while still exiting 0 leaves the
  // reader with a green run whose meaning depends on a line they may not have
  // read. Could not check is not a pass.
  console.error(`SKIPPED /api/health mode-leak assertion — ${e.message}`);
  modeFailures++;
}

const routes = await publicRoutes();
// A route that must 404 — proves the 404 path still renders its own head rather
// than silently 200ing an empty shell.
const cases = [...routes.map((r) => [r, 200]), ["/definitely-not-a-page", 404]];

let failed = modeFailures;
for (const [route, expect] of cases) {
  let status, html;
  try {
    const res = await fetch(BASE + route, { redirect: "follow" });
    status = res.status; html = await res.text();
  } catch (e) {
    console.error(`FAIL ${route} — ${e.message}`); failed++; continue;
  }
  const problems = checkRoute(route, status, html, expect);
  if (problems.length) {
    failed++;
    console.error(`FAIL ${route}\n      ${problems.join("\n      ")}`);
  }
}

const total = cases.length;
if (failed) {
  console.error(`\n${failed} of ${total} routes failed. Nothing should ship on this.`);
  process.exit(1);
}
console.log(`All ${total} routes serve a title, a description and valid JSON-LD (${BASE}).`);
if (modeState !== "verified") {
  console.warn(`Configuration: UNVERIFIED — set SMOKE_TOKEN to check the running modes. Routes passed; configuration was not examined.`);
}
