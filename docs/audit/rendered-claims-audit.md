# Rendered-output claims audit (T2, T3)

**8 August 2026.** Run with `node scripts/audit-claims.js` against the branch
build. 38 routes, 35 database columns, the built bundles, `llms.txt`,
`llms-full.txt`, `robots.txt` and `sitemap.xml`.

Nothing here was found by reading source. Everything below was found by fetching
what the server actually serves, scanning the built bundles without a
leading-context pattern, and querying the database directly.

---

## 🔴 The finding that matters most — a fabricated operator is live

`site/goahead-promise.html:148` renders a credential card:

> **Verified Operator** · **Nile Valley Travel · Luxor**
> 30 yrs operating in Egypt · 4.9 average traveler rating · 4,700+ travelers
> hosted · Licence ✓ Min. of Tourism verified

**"Nile Valley Travel" does not exist in the database.** It is not one of the
five seed rows deleted under S3.2 — it is hardcoded HTML, and the seed purge
never touched it.

`site/operators.html:91` renders two more in a pooling illustration:

> **Aswan Heritage Tours** 3 · **Nile Valley Travel**'s pooled in 2

Neither is in `agencies`. Both read as real partners.

This is precisely what the Phase 0 Decisions asked for in Section 3 — *"ensure
no page renders an operator list, count, or name that is not a signed, verified
partner"* — and my method missed it. I audited the `agencies` **table**, found
six seed rows, purged five, and reported the surface clean. The names that were
actually rendering were never in that table.

`site/verify.html:99` also uses the name, but as a form **placeholder**
(`placeholder="e.g. Nile Valley Travel"`). That is ordinary UI and is fine.

**Not removed, pending your word.** The `/goahead-promise` card is the same
panel as the blocked "4,700+" decision, and T1.2 says report rather than rewrite.
One commit removes all of it whenever you say.

---

## 🔴 Claims served as structured data

The claim is not only published, it is marked up for machines — the same failure
mode as `blog_posts.faq`.

| Surface | Claim |
|---|---|
| `/faq` **JSON-LD `FAQPage`** | "a **24/7 support line** throughout" — served to Google as a marked-up answer |
| `/blog/…` **JSON-LD `FAQPage`** | "a date reached its **minimum travellers**" — threshold stated as universal |
| `db:blog_posts.key_takeaways` | "A date is confirmed only at **minimum travellers** (GoAhead)" |

---

## T2.1 — `BRAND.description` propagation, verified by fetching

| Output | Result |
|---|---|
| JSON-LD `Organization`/`TravelAgency` description | ✅ corrected string |
| `/llms.txt` | ✅ corrected string; zero `guarantee*` in the whole file |
| `/about` `<meta name="description">` | ⚠️ **does not come from `BRAND.description` at all** |

### A correction to what I told you

I reported `BRAND.description` as "one string feeding three outputs, including
the `/about` meta description". **That third one was wrong.**

`/about` is a static HTML file served straight off disk with its own
`<meta name="description">`. The `seo.js` `STATIC` map entry for `/about` never
runs, because the static middleware answers first.

Checked across all nine `STATIC` entries by comparing served `<title>` to the map:

| Route | Uses `seo.js` STATIC? |
|---|---|
| `/itineraries`, `/blog` | **yes** |
| `/`, `/about`, `/contact`, `/faq`, `/how-it-works`, `/privacy`, `/terms` | **no — dead config** |

**Seven of nine entries are dead code.** Consequences:

1. The `/how-it-works` **title** I corrected under P1.5 — "Guaranteed Shared
   Tours" — was never rendered. The real served title is "How it works — Sawa
   Tours Egypt". The fix was harmless but did nothing.
2. `/about`'s real meta description reads *"…across **verified Egyptian
   operators**…"*, which is the P1.6 "verified" claim, in metadata, unaddressed.
3. Any future metadata fix aimed at those seven routes will silently no-op.

---

## T2.4 — Machine-readable surface map

| Surface | Renders from | Status |
|---|---|---|
| JSON-LD `Organization`/`TravelAgency` (every page) | `server/brand.js` `BRAND` → `travelAgencySchema()` | ✅ clean |
| JSON-LD `WebSite` | `BRAND` → `websiteSchema()` | ✅ clean |
| JSON-LD `BreadcrumbList` | route + `STATIC.crumb` / product title | ⚠️ `/verify` carries "Become a verified operator" |
| JSON-LD `TouristTrip` (tour/package) | `tour_products` row | ✅ clean |
| JSON-LD `Article` (blog) | `blog_posts` row | ✅ clean |
| JSON-LD **`FAQPage`** | `blog_posts.faq` **and** static page FAQ markup | 🔴 `/faq` carries the 24/7 claim |
| JSON-LD `Place` | `blog_posts.geo_*` | ✅ clean |
| `<meta name="description">`, OG, Twitter — **static pages** | the page file's own tags | ⚠️ not `seo.js`; see above |
| `<meta …>` — **SPA routes** | `seo.js` `STATIC` + `tourSchema`/`postSchema` | ✅ clean |
| `/llms.txt` | `BRAND` + hand-written route list | ⚠️ availability string |
| `/llms-full.txt` | `BRAND` + live catalogue snapshot | ⚠️ availability string |
| `/sitemap.xml` | `tour_products`, `blog_posts` | ✅ clean |
| `/robots.txt` | `server/seo.js` `robotsTxt()` | ✅ clean |
| `/api/bootstrap` | `tour_products`, `departures`, `cities` | ✅ clean (agencies stripped for anonymous) |
| Server-rendered crawler body | `seo.js buildBody()` | ⚠️ "verified by Sawa Tours" on 14 product pages |
| Email templates | `server/email.js` | **not yet audited — see below** |

No RSS or JSON feed exists.

---

## T3.3 — Database columns audited (35)

All clean unless noted.

`blog_posts`: title, excerpt, body_html, meta_title, meta_description, tldr,
**key_takeaways** ⚠️, **faq** ⚠️, author, author_credentials, keywords, geo_place
`tour_products`: title, description, overview_html, itinerary, included,
not_included, policies_html, meeting_point, guide, vehicle, city, duration, quality
`departures`: route, city, guide, vehicle, notes *(table empty)*
`agencies`: name, contact_name · `destinations`: name, meeting_points · `cities`: name

**Gap:** `server/email.js` templates are not in this inventory. They are copy
that reaches a person, and they were never audited in Phase 0 either. Worth a
pass before launch.

---

## T3.2 — Group-size numbers, re-run against rendered output

7 hits, all the same error: **the threshold stated as universal**.

- `/blog/…` visible text and its `FAQPage` JSON-LD — "reached its minimum travellers"
- `db:blog_posts.key_takeaways`, `db:blog_posts.faq`
- Three in the bundle: the tour-page FAQ, the how-it-works explainer, the FAQ list

These are the same class as the `/goahead` lede fixed under P1.5b. None states a
*wrong* number — they state a *universal* one where it is per product.

No hardcoded `4` or `12` was found in rendered output beyond the illustrations
`sync-constants.js` already maintains.

---

## T3.4 — "Verified" and the seed purge, re-checked against rendered output

**Seed operator names: clean from the database, not clean from the site.** No
purged name (`Nile Gate Travel`, `Cairo Discovery`, `LuxWay Tours`,
`Heritage Desk`, `Lotus Day Trips`) appears in any rendered surface, JSON-LD or
`llms.txt`. But the hardcoded names above do — see the top of this report.

**"Verified" as a fallback: confirmed fixed.** 27 hits for `verified*`, and none
is a fallback for missing data. Every one is editorial copy — "verified Egyptian
operators", "verified by Sawa Tours" (14 product pages, from `buildBody`),
"Become a verified operator". All of it is P1.6/P4.1 work: it stays only once
`/verification-standard` is live.

---

## Other findings

| Where | Claim |
|---|---|
| `/how-it-works` | "**100% refunded** if a date never confirms" — an absolute claim the sweep missed |
| `/contact`, `/faq`, `/faq` JSON-LD, `/goahead-promise` ×2, `/terms` | availability — see T4 |
| `/llms.txt`, `/llms-full.txt`, bundle ×3 | "within two hours" / "9am – 9pm Cairo time" |

---

### Copy decision — mixed spelling on `operators.html`

The T1.1 `[EXACT COPY]` uses **"travellers"**. `operators.html` is written in
**"travelers"** throughout, so the page now carries both. Final copy wins over
house style, so it is in verbatim — but the page reads inconsistently.

The static pages use US spelling and the React app uses UK spelling, so this
split predates T1.1. Worth settling once, either way, rather than per page.

---

## T1.2 — `operators.html` claims audit

H1 and lede replaced under T1.1. Everything else on the page, reported not
rewritten:

| Line | Claim | Category | Proposed |
|---|---|---|---|
| 91 | "**Aswan Heritage Tours** 3 · **Nile Valley Travel**'s pooled in 2" | fabricated operators | Remove, or relabel the panel as an illustration with non-company labels ("Operator A", "Operator B") |
| 143 | Add "**guaranteed departures**" to your own site | absolute claim | "Add confirmed departures to your own site." |
| 78 | "A guide, a vehicle and a permit cost the same whether two people show up or eight" | cost assertion | Fine — a general economics point, not a Sawa claim |
| 106 | "List a date in minutes" | timing | Fine if true of the form |
| 118 | "Your tours, finally full" | outcome implication | Implies Sawa has demand it does not yet have. Suggest "Your tours, filled together" |
| 164 | "Fill the dates you were about to cancel" | outcome implication | Same; now duplicates the new H1 |
| — | "$0 to list a route", "$0 upfront cost" | pricing | Verify this is the actual commercial model before launch |

**No earnings, revenue, booking-projection or operator-count claim was found.**
The page implies demand rather than quantifying it, which is the milder version
of the problem, but 118 and 164 are the two that promise an outcome.

---

## How to re-run

```
node scripts/audit-claims.js                      # branch server on :8795
node scripts/audit-claims.js --base=https://sawa.tours
node scripts/audit-claims.js --json               # machine-readable
```

Exit code is non-zero when anything is found, so it can gate a deploy.
