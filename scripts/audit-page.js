// PPP1.3 — audit named pages against every rule, individually.
//
// `audit:claims` reports a total. A total cannot distinguish "these two pages
// were checked and passed" from "these two pages were never checked" — the same
// shape as a vacuous test pass, and the reason PPP1.3 exists.
//
// Two products appeared in production within an hour on 10 Aug 2026, adding two
// routes. No gate ran, because every gate in this project is triggered by
// touching the repository and nothing was touched. Claims live in database
// fields here — `blog_posts.tldr` and the FAQ JSON have both carried findings
// that source-reading missed — so a product added through the admin panel can
// introduce exactly the class the auditor exists to catch.
//
// Deliberately reuses audit-claims' OWN extraction helpers rather than
// re-deriving them. PPP2: `visibleText` already exists, with a comment saying
// why script content is not copy, and a quick script written minutes after
// reading that comment ignored it and reported JSON as prose.
//
//   node scripts/audit-page.js /tour/foo /package/bar
//   node scripts/audit-page.js --base=https://sawa.tours /tour/foo
import { scan, descriptionLengthFindings, visibleText, metaTags, attributeText, ldBlocks } from "./audit-claims.js";

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = arg("base", "https://sawa.tours").replace(/\/$/, "");
const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// The site standard, from the one place that declares it. Kept in step with
// server/constants.test.js by the test that imports both.
export const UK_SPELLINGS = [
  "travellers", "traveller", "travelled", "travelling",
  "cancelled", "cancelling", "organisation", "organisations", "organisational",
  "reorganisation", "organiser", "authorisation", "authorised", "unauthorised",
  "licence", "licences", "recognised", "apologise", "realise", "minimise",
];

// OOO1.1 — copy that promises the traveller will SEE something ON THE SITE.
// Checkable by asserting the element renders; nothing checked it until the FAQ
// promised a name, a licence status and a rating that appear on no departure.
//
// NARROWED after its first run, which is NNN1's second half failing on a rule
// written minutes earlier. The broad form flagged two product descriptions —
// "you'll see the desert's famous mirages", "where you'll see ancient
// temple-building at its best-preserved". Both are about what a traveller sees
// IN EGYPT. Shipped as written, the rule would have reported two findings
// forever on correct copy, been baselined within a fortnight, and taken the
// real class with it.
//
// So the promise must land near something the SITE would have to render. A
// pattern match remains a pointer: every hit is read before it is filed.
const PROMISE = "(?:you'?ll see|you can view|we show you|you will see|displayed|shown|listed|visible)";
const SITE_THING =
  "(?:name|names|licen[sc]e|licen[sc]ed|registration|rating|ratings|review|reviews|status|price|prices"
  + "|itinerary|operator|company|profile|on every departure|on each departure|before you book|on the departure page)";
export const INTERFACE_PROMISES = new RegExp(`\\b${PROMISE}\\b[^.!?]{0,60}?\\b${SITE_THING}\\b`, "gi");

export function auditOnePage(html, where) {
  const text = visibleText(html);
  const out = [
    ...scan(text, `${where} · visible text`),
    ...descriptionLengthFindings(where, html),
  ];
  for (const { k, v } of metaTags(html)) out.push(...scan(v, `${where} · <${k}>`));
  for (const { k, v } of attributeText(html)) out.push(...scan(v, `${where} · @${k}`));
  for (const ld of ldBlocks(html)) out.push(...scan(JSON.stringify(ld), `${where} · JSON-LD`));

  for (const uk of UK_SPELLINGS) {
    const hits = text.match(new RegExp(`\\b${uk}\\b`, "gi"));
    if (hits) out.push({ rule: "uk-spelling", why: "US English is the site standard (U4.3)", where, match: `${hits.length}x ${uk}`, context: "" });
  }
  for (const m of text.matchAll(INTERFACE_PROMISES)) {
    out.push({ rule: "interface-promise", why: "copy promising the traveller will see X — assert X renders (OOO1.2)",
      where, match: m[0], context: text.slice(Math.max(0, m.index - 60), m.index + 90) });
  }
  return out;
}

const isCli = process.argv[1] && process.argv[1].endsWith("audit-page.js");
if (isCli) {
  if (!paths.length) {
    console.error("Usage: node scripts/audit-page.js [--base=URL] /path [/path…]");
    process.exit(2);
  }
  let total = 0;
  let unreachable = 0;
  for (const p of paths) {
    const res = await fetch(BASE + p, { redirect: "follow" });
    const html = await res.text();

    // A page that did not serve has no findings, and on the first run of this
    // script that read as a pass: a 404 was audited, reported "0 finding(s)"
    // and exited 0. That is the vacuous pass this file's header warns about,
    // committed by the file itself. Not-200 is a failure, not a clean page.
    if (res.status !== 200) {
      unreachable += 1;
      console.error(`\n${res.status}  ${p}  —  NOT AUDITED. A page that does not serve cannot be clean.`);
      continue;
    }

    const findings = auditOnePage(html, p);
    total += findings.length;
    console.log(`\n${res.status}  ${p}  —  ${findings.length} finding(s), ${html.length} bytes`);
    for (const f of findings) console.log(`   ${f.rule}: ${f.match}\n      ${f.where}`);
  }
  // A page that was checked and a page that was never checked look identical in
  // a total. This prints per page, and says how many pages it actually read.
  console.log(`\n${paths.length - unreachable} of ${paths.length} page(s) audited · ${total} finding(s)`
    + (unreachable ? ` · ${unreachable} UNREACHABLE` : ""));
  process.exit(total || unreachable ? 1 : 0);
}
