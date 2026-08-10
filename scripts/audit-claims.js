// Audits what the site actually SERVES, not what the source says.
//
// The first claims sweep read source files and missed instances in two ways,
// both of which this exists to close:
//
//   1. Minified/long lines. An extraction pattern that required 55 characters
//      of leading context silently skipped four instances in src/main.jsx.
//      Nothing here uses a context-window pattern; matches are found first and
//      context is sliced afterwards.
//
//   2. Copy that lives in the database and appears in no file at all.
//      blog_posts.tldr and blog_posts.faq both carried a claim, and the faq
//      field was being served to Google as FAQPage structured data.
//
// A third was found while writing this: seven of the nine entries in seo.js's
// STATIC title/description map are never rendered, because the static HTML in
// /site is served off disk with its own <title> and <meta description> before
// buildHead() runs. Fixing a title there changes nothing. Only a fetch shows it.
//
//   node scripts/audit-claims.js                 audit http://localhost:8795
//   node scripts/audit-claims.js --base=https://sawa.tours
//   node scripts/audit-claims.js --json          machine-readable output
//
// Sources audited: every served route (HTML, meta, JSON-LD), llms.txt,
// llms-full.txt, robots.txt, sitemap.xml, the built JS bundles, and every
// database text column that reaches a public surface.
//
// The SPA's client-rendered DOM is not executed. Instead the built bundle text
// is scanned, which is a superset of what the DOM can show — a string that
// cannot be found there cannot be rendered from there.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg("base", "http://localhost:8795").replace(/\/$/, "");
const AS_JSON = process.argv.includes("--json");

// ---------------------------------------------------------------- patterns
// Each rule says what it is looking for and why it matters, so a hit is
// actionable without going back to the brief.
export const RULES = [
  { id: "guarantee", why: "GoAhead confirms a date at its threshold; it does not promise a date reaches it",
    re: /guarantee\w*/gi,
    ok: (ctx) => /not guarantee|no .{0,12}guarantee|never guarantee/i.test(ctx) },
  { id: "absolute-claim", why: "an unconditional promise the model cannot keep",
    re: /100%\s*(guaranteed|safe|refund)|risk[- ]free|hassle[- ]free/gi },
  { id: "rating", why: "no reviews table exists; a rating cannot be evidenced or sourced",
    re: /\b[0-9]\.[0-9]\s*(?:\/\s*5|out of 5|average|stars?)|\baverage (?:traveller?|customer) rating|★{3,}/gi },
  { id: "volume", why: "pledges has never held a row; no traveller has been carried",
    re: /\b[\d,]{3,}\+?\s*(?:travell?ers|travelers|customers|guests|bookings)\s*(?:hosted|served|carried)?/gi },
  { id: "tenure", why: "BRAND.foundingDate is empty; a tenure claim needs a subject and a record",
    re: /\b\d{1,3}\s*(?:yrs|years)\s*(?:operating|in business|of experience)/gi },
  { id: "availability", why: "must be ONE string from ONE config value; four contradictory ones were live",
    re: /24\/7|24 hours a day|around the clock|within (?:two|2) hours|9\s*am\s*[–-]\s*9\s*pm/gi },
  // HH1 — this flags "verified" as a STATUS, not the word.
  //
  // The distinction matters twice over. /verification-standard, when it
  // publishes, has to use the correct verb to describe what it does — a blanket
  // string ban makes its own subject unspeakable. And a rule that flags true
  // statements ("we verify this licence with the Ministry before approval" is a
  // concrete, checkable action) teaches people to write around it, which is how
  // a check stops being read.
  //
  // So: a badge, a filter value, an attribute, a thing an operator BECOMES —
  // flagged. A verb describing an action Sawa performs — not flagged.
  { id: "verified-status", why: "'verified' as a status implies a published standard; there is none until /verification-standard exists",
    re: /\bverified\s+(?:operators?|travell?ers?|partners?|compan(?:y|ies)|guides?)\b|\bbecome\s+(?:a\s+)?verified\b|\bget\s+verified\b|\bgold\s+shield\b|\bverification\s+(?:badge|shield|status|standard)\b|\bvetted\b/gi,
    // "we verify / verifies / verifying <thing> with <authority>" is an action,
    // not a badge. So is a link to the standard once it exists.
    ok: (ctx) => /\b(?:we|sawa|they)\s+verif|verif\w+\s+(?:it|this|them|documents?|licen[cs]es?)\s+with\b|verification-standard/i.test(ctx) },
  { id: "seed-operator", why: "seed records were purged; no placeholder operator may appear anywhere",
    re: /Nile Gate Travel|Cairo Discovery|LuxWay Tours|Heritage Desk|Lotus Day Trips|Nile Valley Travel|Aswan Heritage Tours/gi },
  // Company-SHAPED, not a fixed list. The seed purge failed because it checked
  // the agencies table for names that were never in it: "Nile Valley Travel"
  // was hardcoded HTML. This catches the shape instead, so an invented operator
  // nobody has thought of yet still trips it.
  { id: "company-name", why: "any company-shaped name must be a signed partner, or it must not appear",
    re: /\b(?!Sawa\b)[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|&|and|el-|Al))*\s+(?:Travel|Travels|Tours|Touring|Tourism|Holidays|Voyages|Agency|Expeditions|Adventures)\b/g,
    // Sawa's own names, the regulator, and generic phrases that happen to fit.
    ok: (ctx) => /Sawa Tours|Capital Travel Service|Ministry of Tourism|Egyptian Travel Agents|e\.g\.|placeholder|Egypt Tours|Shared Tours|Day Tours|Group Tours|Sawa Shared/i.test(ctx) },
  // V1.2 — language describing a financial process that does not occur. There
  // is no payment gateway, no card is ever collected, and no authorization is
  // ever placed, so any sentence about holds, statements, chargebacks or refund
  // timelines describes a mechanism that does not exist. This is the only claim
  // class in the audit that is falsifiable by the reader against their own bank
  // statement.
  { id: "phantom-payment-process", why: "no payment gateway exists; no card is collected and no authorization is placed",
    re: /\b(authoris\w+ hold|authoriz\w+ hold|pre-?authoris\w+|pre-?authoriz\w+|hold is released|released by your bank|your bank may show|pending charge|statement descriptor|chargeback|business days of our confirming|original payment method)\b/gi,
    // The Terms may describe conditions that apply once payments exist, and the
    // codebase's own auth middleware is not a claim.
    ok: (ctx) => /Content-Type,Authorization|Bearer|middleware|unauthoris|unauthoriz|authorised to book|authorised adult/i.test(ctx) },
  { id: "universal-threshold", why: "the threshold is per product; only the ceiling is universal",
    re: /\b(?:four|4)\s+(?:confirmed\s+)?travell?ers?\s*(?:—|-|,)?\s*(?:the\s+)?GoAhead|every date confirms at (?:four|4)|minimum travell?ers/gi,
    // "reaches ITS minimum travellers" is the correct per-product framing — it
    // names no number and is possessive to the date. Only the bare, generic form
    // ("confirmed at minimum travellers") reads as one universal number.
    // Without this the rule fired on six email templates that are correct, and a
    // rule with known false positives is one people learn to ignore.
    ok: (ctx) => /\b(its|their|the date's|this date's)\s+minimum travell?ers/i.test(ctx) },
];

const context = (text, index, span = 70) =>
  text.slice(Math.max(0, index - span), index + span).replace(/\s+/g, " ").trim();

export function scan(text, where, { skipComments = false } = {}) {
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const ctx = context(text, m.index);
      if (rule.ok?.(ctx)) continue;
      if (skipComments && /^\s*(\/\/|\/\*|\*|<!--)/.test(ctx)) continue;
      out.push({ rule: rule.id, why: rule.why, where, match: m[0].slice(0, 60), context: ctx.slice(0, 150) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- fetching
async function get(path) {
  const res = await fetch(BASE + path, { redirect: "follow" });
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type") || "" };
}

// Visible text only: script and style content is not copy, and CSS is full of
// "100%". JSON-LD is pulled out separately and audited on its own.
const visibleText = (html) => html
  .replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ");

// Text a user reads that is not element content: placeholders, alt text,
// aria-labels, title tooltips. visibleText() strips tags wholesale, so these
// were invisible to the audit — which is how a form placeholder carrying an
// invented operator name survived the company-name hunt.
const attributeText = (html) =>
  [...html.matchAll(/\b(placeholder|alt|aria-label|title)="([^"]*)"/gi)]
    .map(([, k, v]) => ({ k, v }))
    .filter((a) => a.v.trim().length > 2);

const metaTags = (html) =>
  [...html.matchAll(/<meta[^>]+(?:name|property)="([^"]+)"[^>]+content="([^"]*)"/gi)]
    .map(([, k, v]) => ({ k, v }))
    .concat([...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map(([, v]) => ({ k: "title", v })));

const ldBlocks = (html) =>
  [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, raw]) => { try { return JSON.parse(raw); } catch { return null; } })
    .filter(Boolean);

// CCC3.1 — what this run was actually able to look at. Module-level because
// publicRoutes() is shared with smoke-routes.js and both CLIs need to know
// whether their coverage was complete.
export const coverage = { degraded: null };

// Every route the public can reach. Product and blog routes come from the
// sitemap, so a new product is audited without anyone updating this list.
export async function publicRoutes() {
  const fixed = ["/", "/about", "/contact", "/faq", "/how-it-works", "/privacy", "/terms",
    "/cookies", "/departures", "/goahead", "/goahead-promise", "/operators", "/verify",
    "/widget", "/itineraries", "/blog", "/booking",
    "/destinations", "/destinations/cairo", "/destinations/luxor", "/destinations/aswan",
    "/destinations/siwa", "/destinations/abu-simbel"];
  let dynamic = [];
  try {
    const { body } = await get("/sitemap.xml");
    dynamic = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ""))
      .filter((p) => /^\/(tour|package|blog)\//.test(p));
  } catch (e) {
    // AAA1.3 — this is the auditor's own blind spot, and it was commented
    // rather than reported. Without the sitemap, `dynamic` stays empty and the
    // audit covers the hard-coded routes only: no tour page, no package, no
    // blog post. It then prints a finding count and exits 0, which reads
    // exactly like an audit that looked at everything and liked it.
    //
    // CCC3.1 — and reporting it is not enough. The narrowing is RECORDED so the
    // CLI can fail on it. An audit that could not see two thirds of the site
    // has not audited the site, and "could not check" is not a pass.
    coverage.degraded = `sitemap.xml unreachable — ${fixed.length} hard-coded routes only, no tour/package/blog pages: ${e.message}`;
    console.error(`[audit] ${coverage.degraded}`);
  }
  return [...new Set([...fixed, ...dynamic])];
}

// ---------------------------------------------------------------- runner
export async function auditRendered() {
  const findings = [];
  const routes = await publicRoutes();
  for (const route of routes) {
    let page;
    try { page = await get(route); } catch (e) { findings.push({ rule: "fetch-failed", where: route, match: e.message, context: "" }); continue; }
    if (page.status >= 400) { findings.push({ rule: "fetch-failed", where: `${route} (HTTP ${page.status})`, match: String(page.status), context: "" }); continue; }
    findings.push(...scan(visibleText(page.body), `${route} · visible text`));
    for (const { k, v } of metaTags(page.body)) findings.push(...scan(v, `${route} · <${k}>`));
    for (const { k, v } of attributeText(page.body)) findings.push(...scan(v, `${route} · @${k}`));
    findings.push(...descriptionLengthFindings(route, page.body));
    for (const ld of ldBlocks(page.body)) findings.push(...scan(JSON.stringify(ld), `${route} · JSON-LD`));
  }
  for (const f of ["/llms.txt", "/llms-full.txt", "/robots.txt", "/sitemap.xml"]) {
    // AAA1.3 — a file that could not be fetched is reported with the vocabulary
    // this auditor already has for it, rather than skipped in silence.
    try { const r = await get(f); findings.push(...scan(r.body, f)); }
    catch (e) { findings.push({ rule: "fetch-failed", where: f, match: e.message, context: "" }); }
  }
  return { routes, findings };
}

// The built bundles: SPA copy that the served HTML does not contain because
// React renders it in the browser. Scanned as text, deliberately without any
// leading-context requirement — that is the pattern that missed four instances.
export function auditBundles() {
  const dist = join(root, "dist", "assets");
  if (!existsSync(dist)) return [];
  return readdirSync(dist).filter((f) => f.endsWith(".js")).flatMap((f) =>
    scan(readFileSync(join(dist, f), "utf8"), `dist/assets/${f}`, { skipComments: true }));
}

// Meta descriptions that will be cut in the result. Desktop truncates around
// 155-160 characters, so anything longer loses its closing clause — which is
// usually the part doing the persuading.
//
// Here because a proposed /about description was stated at "174 characters,
// within the display limit" and was actually 217. Counting by eye is not a
// method; this is.
const DESC_MAX = 160;
export function descriptionLengthFindings(route, html) {
  const out = [];
  for (const m of html.matchAll(/<meta\s+(?:name|property)="(description|og:description)"\s+content="([^"]*)"/gi)) {
    const [, kind, value] = m;
    if (value.length > DESC_MAX) {
      out.push({ rule: "meta-description-length",
        why: `over ${DESC_MAX} chars — truncated in search results, closing clause lost`,
        where: `${route} · <${kind}>`, match: `${value.length} chars`,
        context: `…${value.slice(DESC_MAX - 25, DESC_MAX + 25)}…  (cut near here)` });
    }
  }
  return out;
}

// ------------------------------------------------------- metadata ownership
// U2.3/U2.4 — who actually supplies each route's title, meta description and
// JSON-LD.
//
// This exists because seven of the nine entries in seo.js's STATIC map were
// never rendered, and nothing could tell: the static pages in /site carry their
// own <title> and <meta description> and are served off disk before buildHead()
// runs. Dead config looks exactly like live config, so a claim gets "fixed"
// there while the served string sits untouched somewhere else. It happened
// twice before this was written.
//
// Ownership is decided by comparing what the route SERVES to each candidate
// source, never by reading which file looks authoritative.
const staticFileFor = (route) => {
  const rel = route === "/" ? "index" : route.replace(/^\//, "");
  for (const candidate of [join(root, "site", `${rel}.html`), join(root, "site", rel, "index.html")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const tagOf = (html, re) => (html.match(re)?.[1] ?? "").trim();
const titleOf = (html) => tagOf(html, /<title>([\s\S]*?)<\/title>/i);
const descOf = (html) => tagOf(html, /<meta\s+name="description"\s+content="([^"]*)"/i);

export async function metadataOwnership() {
  const { STATIC } = await import("../server/seo.js");
  const rows = [];
  const routes = await publicRoutes();

  for (const route of routes) {
    let served;
    try { served = (await get(route)).body; } catch { continue; }
    const servedTitle = titleOf(served), servedDesc = descOf(served);
    const file = staticFileFor(route);
    const fileHtml = file ? readFileSync(file, "utf8") : null;
    const cfg = STATIC[route];

    const owner = (servedValue, fileValue, cfgValue) => {
      if (!servedValue) return "— none served";
      if (fileValue && fileValue === servedValue) return `site/${relative(join(root, "site"), file)}`;
      if (cfgValue && cfgValue.replace("${BRAND.name}", "Sawa Tours") === servedValue) return "server/seo.js STATIC";
      return file ? `site/${relative(join(root, "site"), file)}` : "server/seo.js buildHead()";
    };

    rows.push({
      route,
      title: owner(servedTitle, fileHtml && titleOf(fileHtml), cfg?.title),
      description: owner(servedDesc, fileHtml && descOf(fileHtml), cfg?.description),
      jsonld: file ? "server/static-seo.js injectStaticSchema()" : "server/seo.js buildHead()",
      hasConfig: Boolean(cfg),
      configLive: Boolean(cfg) && owner(servedTitle, fileHtml && titleOf(fileHtml), cfg?.title) === "server/seo.js STATIC",
    });
  }

  const dead = rows.filter((r) => r.hasConfig && !r.configLive).map((r) => r.route);
  const orphan = Object.keys(STATIC).filter((k) => !routes.includes(k));
  return { rows, dead, orphan };
}

// W2.2/W2.3 — email and notification templates.
//
// Emails were outside every sweep in this project, and they are the one surface
// where a correction corrects nothing: a sent message cannot be edited. So they
// get the strictest treatment, not the loosest.
//
// The templates are INVOKED with fixture data rather than read as source, so
// what is scanned is the rendered subject, HTML and text a recipient would
// actually receive — a verdict on the output, not a pointer at the code.
export async function auditEmailTemplates() {
  const t = await import("../server/email.js");
  const fx = {
    to: "traveller@example.com", fullName: "A Traveller", customerName: "A Traveller",
    agencyName: "An Operator", tempPassword: "TEMP-1234", role: "agency_owner",
    route: "Aswan Highlights", dateLabel: "2026-09-01", seats: 2,
    depositDue: 45, balanceDue: 405, bookingCode: "SAWA-ABCDE",
    title: "A Listing", reason: "A reason", reference: "REF-1",
    company: "An Operator", contact: "A Person", email: "op@example.com", phone: "+20 100 000 0000",
    city: "Aswan", about: "Some tours",
  };
  // An explicit ALLOW-list, not a name pattern. The pattern /Email$|Text$/
  // matched sendEmail — so the audit CALLED it, which wrote a row to the
  // production email_log table. Nothing was delivered (no key locally, so it
  // took the log branch), but an auditor must not have side effects, and
  // "looks like a template" is not the same as "is pure".
  //
  // Anything added to email.js must be listed here to be audited. A template
  // missing from this list is reported below rather than silently skipped.
  const TEMPLATES = ["inviteEmail", "bookingConfirmationEmail", "departureRequestReceivedEmail",
    "departureRequestApprovedEmail", "departureRequestDeclinedEmail", "goAheadEmail",
    "listingApprovedEmail", "listingRejectedEmail", "operatorApplicationEmail",
    "operatorApplicationReceiptEmail", "operatorApplicationText", "cancellationEmail"];
  const templates = TEMPLATES.filter((k) => typeof t[k] === "function").map((k) => [k, t[k]]);
  const missing = TEMPLATES.filter((k) => typeof t[k] !== "function");
  const unlisted = Object.keys(t).filter((k) => /Email$|Text$/.test(k) && k !== "sendEmail" && !TEMPLATES.includes(k));
  const findings = [];
  const rendered = [];
  for (const [name, fn] of templates) {
    let out;
    try { out = fn(fx); } catch (e) {
      findings.push({ rule: "template-error", why: "a template that cannot render cannot be audited",
        where: `email:${name}`, match: e.message, context: "" });
      continue;
    }
    const text = typeof out === "string" ? out
      : [out?.subject, out?.text, out?.html].filter(Boolean).join("\n");
    rendered.push(name);
    // Strip tags so CSS and markup do not trip the copy rules.
    const visible = String(text).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    findings.push(...scan(visible, `email:${name}`));
  }
  for (const k of missing) findings.push({ rule: "template-error", why: "listed for audit but not exported — cannot be checked",
    where: `email:${k}`, match: "missing", context: "" });
  for (const k of unlisted) findings.push({ rule: "template-error", why: "an email template not in the audit list — add it, do not skip it",
    where: `email:${k}`, match: "unlisted", context: "" });
  return { findings, rendered };
}

// Every text column that reaches a public surface. Reported in full even when
// clean, so the inventory exists for the next sweep.
export async function auditDatabase() {
  // X1 — a read-only session. An auditor must have no side effects, and the
  // way to guarantee that is not to keep reviewing what it does: a write
  // through this pool raises 25006 whatever the credentials permit. This
  // audit is the one that once called sendEmail and wrote to email_log.
  const { readOnlyPool } = await import("../server/db/readonly.js");
  const pool = readOnlyPool();
  const TARGETS = [
    ["blog_posts", "slug", ["title", "excerpt", "body_html", "meta_title", "meta_description",
      "tldr", "key_takeaways", "faq", "author", "author_credentials", "keywords", "geo_place"]],
    ["tour_products", "id", ["title", "description", "overview_html", "itinerary", "included",
      "not_included", "policies_html", "highlights", "faq", "meeting_point", "guide", "vehicle",
      "city", "duration", "quality"]],
    ["departures", "id", ["route", "city", "guide", "vehicle", "notes"]],
    ["agencies", "id", ["name", "contact_name"]],
    ["destinations", "id", ["name", "meeting_points"]],
    ["cities", "id", ["name"]],
  ];
  const findings = [];
  const inventory = [];
  for (const [table, key, cols] of TARGETS) {
    const present = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])).rows.map((r) => r.column_name);
    const use = cols.filter((c) => present.includes(c));
    if (!use.length) continue;
    const rows = (await pool.query(`SELECT ${key} AS __k, ${use.join(", ")} FROM ${table}`)).rows;
    for (const c of use) inventory.push({ table, column: c, rows: rows.length });
    for (const row of rows) {
      for (const c of use) {
        const v = row[c];
        if (v == null) continue;
        findings.push(...scan(typeof v === "string" ? v : JSON.stringify(v), `db:${table}.${c} (${row.__k})`));
      }
    }
  }
  await pool.end();
  return { findings, inventory };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rendered = await auditRendered();
  const bundles = auditBundles();
  // U2.4 — config that no route consumes is a trap, not clutter: the next audit
  // fixes the claim there and leaves the served string alone.
  const ownership = await metadataOwnership().catch(() => ({ rows: [], dead: [], orphan: [] }));
  const deadFindings = [...ownership.dead, ...ownership.orphan].map((route) => ({
    rule: "dead-config",
    why: "seo.js STATIC entry that no route renders — edit the file in /site instead",
    where: `server/seo.js STATIC["${route}"]`, match: route, context: "",
  }));
  const emails = await auditEmailTemplates().catch((e) => ({ findings: [{ rule: "template-error", why: "email templates could not be rendered — NOT a pass", where: "email templates", match: e.message, context: "" }], rendered: [] }));
  const db = await auditDatabase().catch((e) => ({ findings: [{ rule: "db-error", where: "database", match: e.message, context: "" }], inventory: [] }));
  const all = [...deadFindings, ...rendered.findings, ...bundles, ...emails.findings, ...db.findings];

  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, routes: rendered.routes, findings: all, inventory: db.inventory, metadataOwnership: ownership.rows, deadConfig: ownership.dead }, null, 2));
  } else {
    console.log(`# Claims audit — ${BASE}\n${rendered.routes.length} routes, ${db.inventory.length} db columns, ${all.length} findings\n`);
    const byRule = {};
    for (const f of all) (byRule[f.rule] ||= []).push(f);
    for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n## ${rule} — ${list.length}`);
      if (list[0]?.why) console.log(`   ${list[0].why}`);
      for (const f of list.slice(0, 25)) console.log(`   ${f.where}\n      "${f.match}"  …${f.context}…`);
      if (list.length > 25) console.log(`   … and ${list.length - 25} more`);
    }
    console.log(`\n## email templates rendered and audited (${emails.rendered.length})`);
    console.log("   " + (emails.rendered.join(", ") || "NONE — could not verify"));
    console.log(`\n## database columns audited (${db.inventory.length})`);
    console.log("   " + db.inventory.map((i) => `${i.table}.${i.column}`).join(", "));
  }
  // CCC3.1 — `fetch-failed` used to be excluded here, so a file this auditor
  // could not reach was a finding that did not fail the run. A claim that could
  // not be read is not a claim that checked out.
  if (coverage.degraded) console.error(`\nCOVERAGE DEGRADED — ${coverage.degraded}`);
  const blocking = all.length > 0 || !!coverage.degraded;
  console.log(`\n${blocking ? "RED" : "GREEN"} — ${BASE} · ${rendered.routes.length} routes · ${all.length} findings${coverage.degraded ? " · coverage degraded" : ""}`);
  process.exit(blocking ? 1 : 0);
}
