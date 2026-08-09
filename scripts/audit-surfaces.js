// Attributes every block of SERVED text to a known contributor, and fails on
// anything it cannot attribute.
//
// WHY THIS IS INVERTED
//
// The surface inventory was rebuilt three times and missed the next surface each
// time: seo.js's STATIC map, then attribute text (placeholder/alt/aria-label),
// then buildBody()'s server-rendered crawler body. A fourth — a "Verified" filter
// button — sat behind authentication.
//
// The cause is structural, not carelessness. An inventory built by enumerating
// what the codebase CONTAINS cannot list a surface that exists only at request
// time. Every miss was exactly that.
//
// So this starts from the response. Fetch a route, take the text a reader sees,
// and ask which known source it came from. Text that matches no source is an
// unmapped surface BY DEFINITION — which finds the next buildBody() without
// anyone knowing to look for it.
//
// STATUS: NOT GATE-READY. Deliberately not in `npm run preflight`.
//
// The inversion is right and it works — but the attribution model still reports
// ~46 false positives on this codebase, all of one of two shapes:
//
//   1. Runtime composition. "— Cairo, 12 days · 11 nights, from $1520/person" is
//      a seo.js template joined to two database columns. The bigrams that span
//      the join ("nights from", "from $1520") exist in no source, because they
//      only exist once the two are concatenated.
//   2. Derived values. A canonical URL contains a slug that tourSlug() computes
//      from a title. The string is in no file and no column.
//
// Both are known contributors. Lowering the threshold until they pass would make
// the output look clean while blinding it to real gaps — the failure this whole
// project keeps finding, and the reason HH1 exists. So the number stands and the
// tool stays out of the gate until attribution can model composition and
// derivation properly. Wiring it in now would produce a check that the first
// person to hit it disables.
//
// WHEN YOU RETURN TO THIS: instrument composition, do not refine matching.
//
// Reverse-engineering provenance from served text is a heuristic, and a better
// heuristic is still a heuristic. Recording provenance AT composition time is a
// fact. There are only a few composition points — seo.js's templates,
// buildBody(), tourSlug() — and tagging their output with the sources that fed
// it makes both remaining shapes attributable by construction:
//
//   runtime composition — the join is recorded, so a word-pair spanning it has
//                         a known origin instead of appearing from nowhere
//   derived values      — tourSlug() records that it computed the slug from a
//                         title, so the slug is attributable to that title
//
// Same principle as narrowing the Autoura boundary rather than guarding it:
// structural over heuristic. Do not start by adjusting COVERAGE.
//
//   node scripts/audit-surfaces.js
//   node scripts/audit-surfaces.js --base=https://sawa.tours
//   SMOKE_TOKEN=<jwt> node scripts/audit-surfaces.js     # includes authenticated surfaces
//
// THREE STATES, per HH2.3. A surface this cannot reach is reported UNVERIFIED,
// never counted as clean. The coverage boundary is printed every run.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publicRoutes } from "./audit-claims.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = arg("base", "http://localhost:8795").replace(/\/$/, "");
const TOKEN = process.env.SMOKE_TOKEN || "";

const norm = (s) => s
  .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&nbsp;/g, " ").replace(/&middot;/g, "·")
  .replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- the sources
// Each is a haystack of text that a known contributor can produce.
async function buildSources() {
  const sources = {};
  const add = (name, text) => { sources[name] = (sources[name] || "") + " " + norm(text); };

  // 1. Hand-written static pages, and the partial they share.
  for (const f of readdirSync(join(root, "site")).filter((f) => f.endsWith(".html")))
    add("static HTML (site/*.html)", readFileSync(join(root, "site", f), "utf8"));
  for (const f of readdirSync(join(root, "site", "destinations")).filter((f) => f.endsWith(".html")))
    add("static HTML (site/*.html)", readFileSync(join(root, "site", "destinations", f), "utf8"));
  add("shared partial (site/_partials)", readFileSync(join(root, "site", "_partials", "footer.html"), "utf8"));

  // 2. The SPA bundle. Covers client-rendered text this script cannot execute,
  //    including every authenticated view — a superset, deliberately.
  const dist = join(root, "dist", "assets");
  if (existsSync(dist))
    for (const f of readdirSync(dist).filter((f) => f.endsWith(".js")))
      add("SPA bundle (dist/assets)", readFileSync(join(dist, f), "utf8"));

  // 3. Server-side text builders.
  for (const f of ["seo.js", "static-seo.js", "brand.js", "email.js", "domain.js", "app.js"])
    add(`server (${f})`, readFileSync(join(root, "server", f), "utf8"));

  // 4. Database text. The surface that exists in no file at all.
  try {
    const { pool } = await import("../server/db/index.js");
    for (const [table, cols] of [
      ["blog_posts", ["title", "excerpt", "body_html", "meta_title", "meta_description", "tldr", "key_takeaways", "faq", "author", "author_credentials"]],
      ["tour_products", ["title", "description", "overview_html", "itinerary", "included", "not_included", "policies_html", "meeting_point", "guide", "vehicle", "city", "duration"]],
      ["departures", ["route", "city", "guide", "vehicle", "notes"]],
      ["destinations", ["name", "meeting_points"]], ["cities", ["name"]], ["agencies", ["name"]],
    ]) {
      const present = (await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])).rows.map((r) => r.column_name);
      const use = cols.filter((c) => present.includes(c));
      if (!use.length) continue;
      const rows = (await pool.query(`SELECT ${use.join(", ")} FROM ${table}`)).rows;
      for (const row of rows) for (const c of use) if (row[c] != null)
        add("database", typeof row[c] === "string" ? row[c] : JSON.stringify(row[c]));
    }
    await pool.end();
    sources.__dbReached = true;
  } catch (e) {
    sources.__dbError = e.message;
  }
  return sources;
}

// --------------------------------------------------------------- the response
// Reader-visible text: element content plus the attribute text that a check
// once missed entirely.
function servedBlocks(html) {
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const attrs = [...withoutCode.matchAll(/\b(?:placeholder|alt|aria-label|title)="([^"]{4,})"/gi)].map((m) => m[1]);
  const metas = [...withoutCode.matchAll(/<meta[^>]+content="([^"]{4,})"/gi)].map((m) => m[1]);
  const text = withoutCode.replace(/<[^>]+>/g, "\n");
  return [...text.split("\n"), ...attrs, ...metas]
    .map(norm)
    // Short fragments are numbers, punctuation and single words — too weak to
    // attribute either way, and reporting them would bury the real findings.
    .filter((t) => t.length >= 25 && /[a-z]{3}/i.test(t));
}

// Attribution has to survive COMPOSITION. Almost nothing served is a literal
// string in a file: titles interpolate `${BRAND.name}`, catalogue lines are a
// template joined to database columns, and a first version of this flagged 170
// blocks that were all perfectly well attributed — just assembled at runtime.
//
// So attribution is by word-pair coverage. A block belongs to a source if the
// adjacent word pairs that make it up can be found there. Interpolation breaks
// the whole string but leaves nearly every pair intact; genuinely unmapped copy
// has pairs that appear nowhere at all, which is the thing worth finding.
// One normalisation, used for both sides.
const wordSpace = (text) => norm(text).toLowerCase().replace(/[^a-z0-9$£€%'’\s-]/g, " ").replace(/\s+/g, " ");

const bigrams = (text) => {
  const words = wordSpace(text).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
};

const COVERAGE = 0.8;

// Scored against the UNION of sources, not the best single one. A catalogue line
// is a template from seo.js joined to a city and a duration from the database —
// no single source contains it, and requiring one flagged 104 blocks that were
// all fully accounted for. What matters is whether every part of the text comes
// from SOMEWHERE known, not whether it all comes from the same place.
let unionCache = null;
export let lastScore = 0;
const attribute = (block, sources) => {
  const needle = norm(block);
  const named = Object.entries(sources).filter(([n]) => !n.startsWith("__"));
  for (const [name, hay] of named) if (hay.includes(needle)) return name;

  const pairs = bigrams(block);
  if (pairs.length < 3) return "too short to attribute";
  // The haystack must be normalised the SAME WAY as the block. A first version
  // stripped punctuation from the block's words and then searched the raw
  // source, so "days · 11" could never match "days 11" — every catalogue line
  // was reported unmapped because of a normalisation asymmetry, not a real gap.
  unionCache ??= named.map(([name, hay]) => [name, wordSpace(hay)]);

  let covered = 0;
  const credit = {};
  for (const p of pairs) {
    const hit = unionCache.find(([, hay]) => hay.includes(p));
    if (hit) { covered++; credit[hit[0]] = (credit[hit[0]] || 0) + 1; }
  }
  const score = covered / pairs.length;
  if (score < COVERAGE) { lastScore = score; return null; }
  return Object.entries(credit).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "composed";
};

// ------------------------------------------------------------------- the run
const get = async (path, auth = false) => {
  const headers = auth && TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const res = await fetch(BASE + path, { headers, redirect: "follow" });
  return { status: res.status, body: await res.text() };
};

const sources = await buildSources();
const routes = await publicRoutes();

// HH2.1/HH2.2 — authenticated surfaces, and public routes in their authenticated
// state. The HTML shell is identical for SPA routes whether signed in or not;
// what differs is rendered in the browser, which is why the bundle is a source.
const AUTHED = ["/api/modes", "/api/me", "/admin", "/agency", "/portal"];

const findings = [];
const unverified = [];

for (const route of routes) {
  let r;
  try { r = await get(route); } catch (e) { unverified.push(`${route} — fetch failed: ${e.message}`); continue; }
  for (const block of servedBlocks(r.body))
    if (!attribute(block, sources)) findings.push({ route, block, authed: false, score: lastScore });
}

if (!TOKEN) {
  unverified.push(`authenticated surfaces (${AUTHED.join(", ")}) — SMOKE_TOKEN not set, NOT checked`);
} else {
  for (const route of AUTHED) {
    let r;
    try { r = await get(route, true); } catch (e) { unverified.push(`${route} — fetch failed: ${e.message}`); continue; }
    if (r.status === 401 || r.status === 403) { unverified.push(`${route} — ${r.status}, token rejected, NOT checked`); continue; }
    for (const block of servedBlocks(r.body))
      if (!attribute(block, sources)) findings.push({ route, block, authed: true });
  }
}

if (!sources.__dbReached) unverified.push(`database text — could not read (${sources.__dbError}); DB-sourced copy NOT attributable`);

// ---------------------------------------------------------------- the report
console.log(`# Surface attribution — ${BASE}`);
console.log(`${routes.length} public route(s)${TOKEN ? ` + ${AUTHED.length} authenticated` : ""}, ${Object.keys(sources).filter((k) => !k.startsWith("__")).length} known sources\n`);

if (findings.length) {
  console.log(`## UNATTRIBUTED — ${findings.length}`);
  console.log("   Served text matching no known source. Each is an unmapped surface.\n");
  for (const f of findings.slice(0, 40))
    console.log(`   ${f.route}${f.authed ? " [auth]" : ""}\n      "${f.block.slice(0, 150)}"`);
  if (findings.length > 40) console.log(`   … and ${findings.length - 40} more`);
} else {
  console.log("## UNATTRIBUTED — none");
}

console.log(`\n## COVERAGE BOUNDARY — what this run could NOT verify`);
if (!unverified.length) console.log("   (nothing — every surface in scope was reached)");
for (const u of unverified) console.log(`   UNVERIFIED  ${u}`);
console.log(`   UNVERIFIED  client-rendered DOM — the SPA is not executed. Its text is`);
console.log(`               attributed via the bundle, which is a superset: a string`);
console.log(`               that cannot be found there cannot be rendered from there,`);
console.log(`               but dead code counts as covered.`);
console.log(`   UNVERIFIED  data-dependent states — a departure card with travellers on`);
console.log(`               it, a confirmed departure, a cancelled one. departures and`);
console.log(`               pledges are empty, so those states render nowhere yet.`);
console.log(`   UNVERIFIED  role-specific views — agency vs ops_staff vs super_admin`);
console.log(`               differ, and one token sees one of them.`);
console.log(`   UNVERIFIED  error paths — 5xx pages, validation messages, rate-limit`);
console.log(`               responses. Reached only by causing the error.`);

process.exit(findings.length ? 1 : 0);
