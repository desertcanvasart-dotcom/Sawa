// OOO1.2 — the half the rule names and never did.
//
// `INTERFACE_PROMISES` finds copy that promises the traveller will SEE
// something. Its own `why` string says what comes next:
//
//   "copy promising the traveller will see X — assert X renders (OOO1.2)"
//
// Nothing asserted X renders. The rule found the sentence and stopped, which is
// half a check: it can tell you a promise EXISTS, never whether it is KEPT.
//
// That gap is not hypothetical. The FAQ promised *"their name, license status
// and rating on every departure"* while name and licence rendered on 0 of 14.
// The copy was removed (OOO2) — and nothing would notice if it came back, or if
// the data quietly went away under copy that stayed.
//
// ============================================================================
// WHY THIS READS DATA AND NOT RENDERED HTML
// ============================================================================
//
// The departures board is client-rendered: a plain fetch of /departures shows
// "— departures open", with dashes where the numbers go. Scraping it would
// report every promise unmet regardless of the truth — a check that cannot pass
// (NNN1.2), and one whose failures would be baselined inside a week.
//
// The promise is really a claim about DATA: a name cannot be shown if no
// operator record carries one. `/api/bootstrap` is the payload the site itself
// renders from, so it is the honest instrument.
//
// ============================================================================
// NOTHING HERE ASSERTS ABSENCE
// ============================================================================
//
// Every probe is derived from the payload. When migration 025 is applied and
// licences are recorded, `licence` starts passing on its own — no edit here.
// A probe hard-coded to `false` would be a claim about today that silently
// outlives today, which is the evidence-expiry class this repository tracks in
// its own register.
export const PROMISED_DATA = {
  name: {
    label: "operator name",
    have: (p, ctx) => Boolean(ctx.agencyOf(p)?.name),
  },
  licence: {
    label: "operator licence status",
    have: (p, ctx) => {
      const a = ctx.agencyOf(p);
      return Boolean(a?.tourismLicenseNo || a?.etaaRegistrationNo || a?.verificationState);
    },
  },
  rating: {
    label: "operator rating",
    have: (p) => p?.rating != null || p?.averageRating != null || p?.reviewCount > 0,
  },
  price: {
    label: "price",
    have: (p) => Number(p?.publishedRate) > 0,
  },
  itinerary: {
    label: "itinerary",
    have: (p) => (Array.isArray(p?.itinerary) ? p.itinerary.length > 0 : Boolean(p?.itinerary)),
  },
};

// Which promised things a matched sentence actually names. A promise mentioning
// "name and licence status" is TWO promises, and reporting it as one would hide
// whichever half is kept.
const KEYWORDS = {
  name: /\bnames?\b/i,
  // NOT the adjective. "listed by a Ministry-licensed operator" says the
  // operator HOLDS a licence; it does not promise the traveller will SEE a
  // licence status. The first run filed that as an unmet promise — a rule
  // firing on correct copy, which is NNN1.2's failure in a rule written to
  // close NNN1.2's other half.
  licence: /\blicen[sc]e\b(?!d)|\blicen[sc]es\b|\blicen[sc]e\s+(?:status|number|no\.?)\b|\bregistration\b/i,
  rating: /\bratings?\b|\breviews?\b/i,
  price: /\bprices?\b/i,
  itinerary: /\bitinerar(?:y|ies)\b/i,
};

// A promise cannot span two blocks.
//
// `visibleText` joins block elements with a space, so a heading and the
// paragraph under it become one string: "5. Information shown on the Platform
// We take reasonable care to ensure that itinerary descriptions…". The promise
// verb came from the HEADING and the noun from the PARAGRAPH, and the first run
// filed it as a promise about a per-departure itinerary field.
//
// Scanning per block removes the whole class rather than adding a heuristic to
// guess where a sentence ended. Nothing is stripped that carries copy: script
// and style content is dropped first, exactly as visibleText does.
export function visibleBlocks(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split(/<\/?(?:p|div|section|article|li|h[1-6]|td|th|tr|header|footer|nav|main|figcaption|blockquote|dt|dd|br)\b[^>]*>/i)
    .map((b) => b.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Every interface promise on a page, found within a single block.
export function promisesIn(html, where, pattern) {
  const out = [];
  for (const block of visibleBlocks(html)) {
    pattern.lastIndex = 0;
    for (const m of block.matchAll(pattern)) out.push({ where, match: m[0].trim(), block });
  }
  return out;
}

export function thingsNamedIn(promiseText) {
  return Object.keys(KEYWORDS).filter((k) => KEYWORDS[k].test(promiseText));
}

// THREE states, never two. "kept on some" is not "kept", and collapsing it into
// either would be a lie in one direction or the other: `itinerary` is present on
// 3 of 16 products today, and copy promising it is true for a fifth of the site.
export function coverageState(have, total) {
  if (total === 0) return "no-data";
  if (have === total) return "kept";
  if (have === 0) return "unmet";
  return "partial";
}

// promises: [{ where, match }] from INTERFACE_PROMISES
// payload:  the /api/bootstrap body
export function unmetPromises(promises, payload) {
  const agencies = new Map((payload?.agencies || []).map((a) => [a.id, a]));
  const products = payload?.tourProducts || [];
  const ctx = { agencyOf: (p) => (p?.agencyId ? agencies.get(p.agencyId) : null) };

  const out = [];
  for (const promise of promises) {
    for (const thing of thingsNamedIn(promise.match)) {
      const probe = PROMISED_DATA[thing];
      if (!probe) continue;
      const have = products.filter((p) => probe.have(p, ctx)).length;
      const state = coverageState(have, products.length);
      if (state === "kept") continue;
      out.push({
        rule: "promise-not-kept",
        thing,
        label: probe.label,
        state,
        have,
        total: products.length,
        where: promise.where,
        match: promise.match,
        why: state === "no-data"
          ? `nothing to check ${probe.label} against — the payload carried no products`
          : `copy promises ${probe.label}; it is present on ${have} of ${products.length} products`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI. Needs a live target: the payload is what production actually serves, and
// a promise checked against a local fixture proves nothing about the site.
//
//   node scripts/audit-promises.js --base=https://sawa.tours
const isCli = process.argv[1] && process.argv[1].endsWith("audit-promises.js");
if (isCli) {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { INTERFACE_PROMISES } = await import("./audit-page.js");

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const base = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) || "https://sawa.tours")
    .replace(/\/$/, "");

  const pages = readdirSync(join(ROOT, "site")).filter((f) => f.endsWith(".html"));
  if (!pages.length) {
    console.error("No static pages found. A sweep that examined nothing must not report clean.");
    process.exit(1);
  }
  const promises = pages.flatMap((f) =>
    promisesIn(readFileSync(join(ROOT, "site", f), "utf8"), f, INTERFACE_PROMISES));

  let payload;
  try {
    const res = await fetch(`${base}/api/bootstrap`);
    payload = await res.json();
  } catch (e) {
    // UNREACHABLE is not CLEAN. The whole point of this check is that it reads
    // production data; a run that read none has verified nothing, and reporting
    // that as a pass is the failure this repository keeps finding.
    console.error(`SITE DID NOT ANSWER — ${base}/api/bootstrap: ${e.message}`);
    console.error("Nothing was checked. This is availability, not a kept promise.");
    process.exit(1);
  }

  const products = payload?.tourProducts?.length || 0;
  console.log(`${promises.length} interface promise(s) in ${pages.length} pages, against ${products} live product(s)\n`);
  for (const p of promises) console.log(`  ${p.where}: "${p.match}"`);

  const findings = unmetPromises(promises, payload);
  if (!findings.length) {
    console.log(`\nEvery promise the copy makes is backed by data on every product.`);
    process.exit(0);
  }
  console.error(`\n${findings.length} promise(s) the data does not keep:\n`);
  for (const f of findings) {
    console.error(`  ${f.state.toUpperCase().padEnd(8)} ${f.label} — ${f.have} of ${f.total} — ${f.where}`);
    console.error(`           "${f.match}"`);
  }
  console.error(
    "\nEither the data is missing or the copy promises something the product does not do.\n"
    + "OOO5: copy says what is true, not what is intended.\n"
  );
  process.exit(1);
}
