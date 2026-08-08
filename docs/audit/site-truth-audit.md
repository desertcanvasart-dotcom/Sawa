# Site Truth Audit — Phase 0

**Date:** 8 August 2026 · **Commit:** `b5f40a4` · **Status:** read-only audit, no code changed.

Database figures are live reads from the production Supabase instance, not assumptions.

---

## Executive summary — the five things that change the plan

1. **The stack is not Next.js.** It is Express + a Vite React SPA + 20 hand-written static HTML pages. There is no CMS and no App Router. Several tasks in the brief assume file-based routing that does not exist here. See §0.1.

2. **`GOAHEAD_MIN` and `GROUP_MAX` already exist** as `DEFAULT_GO_AHEAD`/`MIN_GROUP_SIZE = 4` and `MAX_GROUP_SIZE = 12` in `server/domain.js`, enforced by database CHECK constraints. P1.1 is largely already done on the server. The gap is entirely in **copy**, which is where all 40+ hardcoded instances live. See §0.2.

3. **The brief and the system disagree about per-product minimums, and the system disagrees on purpose.** The brief states "There is no per-product minimum." The schema, the validator and a written migration rationale all say a listing *may* require more than four. Today every one of the 14 live products is set to exactly 4, so the P1.2 copy is true right now — but it becomes false the moment anyone uses a documented feature. **This needs your decision before P1.1.** See §0.2.1 — this is Blocker B1.

4. **The departures table is empty. Zero rows. So is pledges.** Every "dates open", "forming now" and GoAhead count on the site is currently rendering against nothing. This is not a display bug to patch — Phase 3 has no data to display until you supply it (P3.2). See §0.4.

5. **There are four fabricated statistics live on `/goahead-promise` right now**: "30 yrs operating in Egypt", "4.9 average traveler rating", "4,700+ travelers hosted", and a "24/7 support line". Nothing in the database supports any of them. These are the highest-risk items in the audit and I would take them down ahead of the rest of Phase 1. See §0.3.

---

## 0.1 Stack and structure

**Your assumption was Next.js App Router + Supabase. The Supabase half is right.**

| | Actual |
|---|---|
| Server | Express 5 (`server/app.js`, ~2,270 lines) — API *and* static file server |
| Front end | React 19 SPA built by Vite into `dist/`. **No Next.js, no App Router, no file-based routing.** |
| Database | PostgreSQL via Supabase; `pg` Pool. Supabase Auth for logins |
| Styling | Hand-written CSS — `src/styles.css` (6,722 lines) + `redesign.css`; static pages carry their own inline `<style>` plus `site/assets/shared.css` |
| Deployment | Railway, auto-deploys `main` (`npm run build` → `npm start`) |
| CMS | **None.** Content is either hardcoded HTML or rows in Postgres |

### Three separate rendering surfaces — this is the single most important structural fact

| Surface | Lives in | URLs |
|---|---|---|
| **Static editorial HTML** | `site/*.html` — 20 hand-authored files, served off disk | `/`, `/about`, `/contact`, `/faq`, `/how-it-works`, `/privacy`, `/terms`, `/cookies`, `/departures`, `/goahead`, `/goahead-promise`, `/operators`, `/verify`, `/widget`, `/destinations/*` |
| **React SPA** | `src/main.jsx` (3,545 lines) | `/itineraries`, `/tour/:slug`, `/package/:slug`, `/blog`, `/blog/:slug`, `/booking`, `/admin`, `/agency` |
| **Server-injected head + body** | `server/seo.js`, `server/static-seo.js` | every route — titles, meta, OG, JSON-LD are injected server-side, *not* written in the page files |

**Consequences for this brief:**

- **The homepage is static HTML, not React.** P1.3 ("homepage How it works step 03") and P1.4 (marquee) are edits to `site/index.html`, and cannot read a JS constant at render time. See Blocker B2.
- **Duplication is structural.** The nav appears in 20 static files *and* in `SX_NAV_LINKS` in `main.jsx`. The footer is generated from `site/_partials/footer.html` by `npm run sync:partials`, with `server/partials.test.js` failing the build on drift. **P2.1 must edit the partial and re-run the sync — not the 20 files.**
- Some SPA routes (`AboutPage`, `FaqPage`, `LegalPage`) exist in `main.jsx` but are **dead code**, shadowed by the static files that the middleware serves first. Editing the React version of `/about` would change nothing. Relevant to P2.2.

---

## 0.2 Every place the GoAhead numbers appear

### Constants that already exist (`server/domain.js`)

```
line  4   export const DEFAULT_GO_AHEAD = 4;
line 12   export const MAX_GROUP_SIZE  = 12;
line 19   export const MIN_GROUP_SIZE  = 4;
```

Enforced in three layers: `capacityError()` in `domain.js`, API validation in `app.js:274-277`, and database CHECK constraints (`schema_021_max_group_size.sql`, `schema_022_min_group_size.sql`).

### 0.2.1 ⚠️ The per-product minimum conflict — BLOCKER B1

Your brief: *"These apply to every itinerary. There is no per-product minimum."*

The system disagrees, deliberately. From `server/db/schema_022_min_group_size.sql`:

> "Note this is a floor, not a fixed value. A listing may require MORE than four — a nine-day cruise might not be viable at four — and nothing is hidden when it does, because the card shows the real threshold ('2 of 6 joined'). What it may never do is confirm with fewer."

This is implemented, tested (`capacityError(6, 12)` returns `null` — a 6-person minimum is explicitly legal) and reflected in the UI, which renders `min_seats` per product rather than a constant.

**Live data — all 14 products (verified against production):**

```
min_seats values in use: 4     (every row)
max_seats values in use: 12    (every row)
```

So **`/itineraries`'s current wording is not factually wrong today** — it is architecturally accurate and coincidentally identical to the fixed number. The brief characterises it as an error; I'd characterise it as a design the copy is faithfully reflecting.

**This is a genuine fork and I need your call:**

- **(a)** Fix the copy only. Ship P1.2 verbatim. Accept that if anyone ever sets a listing to 6, four pages start lying. Cheapest, but leaves a live trap.
- **(b)** Make the product match the copy. Change the constraint to `min_seats = 4` exactly, remove per-listing minimums, delete the price-tier logic that depends on a variable floor. Honest and permanent, but it removes a shipped capability and touches pricing — which borders your "do not touch payment logic" line.
- **(c)** Keep the flexibility, write copy that survives it. Something like *"Every date confirms at four travellers on almost every itinerary — a few longer trips need more, and the number is always shown on the date itself."* Honest under both conditions, but it is not the `[EXACT COPY]` you supplied, and you marked that final.

I cannot pick this for you — (b) changes the product and (c) changes copy you marked final.

### 0.2.2 Hardcoded instances in copy

**These are all in static HTML or JSX strings. None can read a constant without a build step (Blocker B2).**

| File | Line | Current wording | Correct? |
|---|---|---|---|
| `server/seo.js` | 533 | "Every date is confirmed (GoAhead) at its **minimum travellers**" | The `/itineraries` string in the brief. Server-rendered crawler body — **not** the React page |
| `src/main.jsx` | 2017-2100 | React `/itineraries` hero copy | The version a *visitor* sees. **Both must change together** |
| `site/index.html` | 510 | "Four travelers on the same route, and the trip is locked in" | Correct today |
| `site/index.html` | 603 | "Four travelers, and you're going" (step 03) | Correct — P1.3 target |
| `site/index.html` | 617 | "**4** of 12 joined · 8 seats left" | Static illustration, not live data |
| `site/index.html` | 684 | "Four travelers" | Correct today |
| `site/how-it-works.html` | 336, 352, 372, 477 | "Four travelers, and the gold dot turns on"; "4 of 12 joined / minimum of 4 reached" | Correct today |
| `site/goahead-promise.html` | 7, 12, 59, 88 | "you only pay when four travelers confirm" | Correct today |
| `site/goahead.html` | 7, 12, 59 | "reached four confirmed travelers" | Correct today |
| `site/terms.html` | 109 | "The standard minimum is four" | **The only page that gets B1 right** — "standard" implies variance |
| `src/main.jsx` | 67, 287, 1589, 2623, 2744 | "its minimum seats" / "the minimum travellers" | Per-product framing — accurate to the model, contradicts the brief |
| `site/departures.html` | 246 | "at or past its minimum" | Per-product framing |
| `site/goahead.html` | 168 | "at or past its minimum" | Per-product framing |

**Count: 40+ instances across 3 surfaces.** Twelve appears as a ceiling in only **two** places (`index.html:617`, `how-it-works.html:352`), both inside static illustrations rather than as a stated promise — confirming your P1.3 premise that the ceiling is nearly invisible.

---

## 0.3 Claims audit

### 🔴 Fabricated statistics — no supporting data exists

All four are on `/goahead-promise`, lines 150-153, in a sticky panel presented as an operator credential card:

| Claim | Evidence needed | Evidence found |
|---|---|---|
| **"30 yrs operating in Egypt"** | Company registration date | `BRAND.foundingDate` is `""` (marked TODO) |
| **"4.9 average traveler rating"** | A review system | **No reviews table exists.** No ratings anywhere in the schema |
| **"4,700+ travelers hosted"** | Booking history | **`pledges` table has 0 rows.** Zero travellers have ever booked |
| **"Licence ✓ Min. of Tourism verified"** | Verification records | No verification fields on the `agencies` table |

`/goahead.html:63` also renders a hard-coded **"100% guaranteed to run"**.

These are my top recommendation for immediate removal, ahead of the rest of Phase 1.

### 🔴 Contradictory support-availability claims

Three different promises are live simultaneously:

| Location | Claim |
|---|---|
| `site/contact.html:82` | "support available **24/7** for travelers on an active tour" |
| `site/terms.html:95` | "the same WhatsApp number, **monitored 24 hours a day** while your tour is running" |
| `site/goahead-promise.html` | "**24/7 support line**" |
| `src/main.jsx:2702` | "Hours: **9am – 9pm Cairo time**, daily" |
| `src/main.jsx:2687`, `server/seo.js:52` | "We reply **within two hours**" |

The Terms version is narrower (during an active tour) and may well be true. The others are broader. **Blocker B3 — I need the real availability.**

### 🟠 "Guarantee" family — 15+ instances

Beyond the blog meta description in P1.5:

- `site/goahead.html` — 5 instances, including `<meta name="description">`, the H1 lede, and card copy "Guaranteed to run"
- `site/how-it-works.html:439` — a whole section headed "GUARANTEES"
- `site/goahead-promise.html:67` — "THREE GUARANTEES"
- `server/seo.js:50` — page **title**: "How Sawa Works — **Guaranteed** Shared Tours"
- `server/seo.js:551` — `llms.txt`, the file AI engines read
- `src/main.jsx:2057, 2598` — "It runs, guaranteed"

Note `server/seo.js:50` and `:551` are metadata: they reach Google and AI assistants directly.

Legitimate uses I would **not** touch: `terms.html` uses "not guaranteed" as a limitation (correct), and several code comments use the word technically.

### 🟠 "Verified" — 30+ instances, and a route collision

"Verified Egyptian operators" appears in the footer blurb of **every** static page, plus meta descriptions on `/about`, `/terms` and `/`, plus `'Verified operator'` as a **fallback string** when a departure has no guide name (`site/index.html:957`, `site/goahead.html:283`) — i.e. the word renders *in the absence of data*.

**Route collision confirmed:** `/verify` already exists and is operator-facing — "Become a verified Sawa operator — Apply to list departures". Your proposed `/verify-operators` does not collide, but the two names are one character apart in meaning and will confuse. I'd suggest `/verification-standard`. **Blocker B4.**

### 🔴 Marquee destinations — confirmed unbacked

`site/index.html:572-582` (rendered twice for the scroll loop):

| Destination | Product exists? |
|---|---|
| The White Desert | **No** |
| Siwa Oasis | **No** — a `/destinations/siwa.html` *page* exists, but no bookable product |
| Dahab & the Blue Hole | **No** |

Live catalogue covers **only Cairo, Luxor and Aswan**. The `destinations` table has exactly three rows: Cairo, Luxor, Aswan.

Note the complication: `/destinations/siwa` and `/destinations/abu-simbel` are full pages in the sitemap. Siwa has no product. Abu Simbel does (via the Aswan day tour). **Removing the marquee item does not address the standalone Siwa page.** Blocker B5.

### 🟠 Operator identity — likely seed data on display

The `agencies` table holds six rows:

```
ag_1 Nile Gate Travel   ag_2 Cairo Discovery   ag_3 LuxWay Tours
ag_4 Heritage Desk      ag_5 Lotus Day Trips   ag_6 adham
```

Five look like demo fixtures; `adham` looks like a test account. **Capital Travel Service is not among them** — despite being the operating entity that P2.3 wants flagged as founding operator. If any of these names render publicly, that is a fabricated-operator claim. Blocker B6.

---

## 0.4 Departures data model

**The tables are empty:**

```
departures : 0 rows
pledges    : 0 rows
```

| Question | Answer |
|---|---|
| Storage | `departures` table — 25 columns: `id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time, city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price, quality, cutoff, status, notes, deposit_percent, created_at, created_by` |
| **Own URL?** | ❌ **No.** No `/departures/:id` route exists on any surface. `/departures` is a single static board. **P3.1 is net-new.** |
| Joined count | Derived, not stored — `SUM(pledges.seats) WHERE status <> 'cancelled'` |
| No slug field | `departures` has no slug column. P3.1's `[itinerary-slug]-[YYYY-MM-DD]` must be derived via `tourSlug(product)` + date, and needs a reverse lookup |
| `is_anchor` / `anchor_month` | ❌ Do not exist. P3.5 needs a migration |
| Homepage "dates open" | `site/index.html:525` — `<b data-live-departures>—</b>` populated by JS from `/api/bootstrap` |
| **Current value** | **A literal em-dash**, permanently, because the source array is empty |
| Homepage "forming this month" | `site/index.html:652,656` — hardcoded `Loading…` and `<b>0</b> more forming this month` |
| **Current value** | **`Loading…` forever**, and **`0`** |
| `/goahead` hero | Two `data-live-count` elements initialised to `—`, plus a hardcoded `100%` |
| `/departures` hero | Same two `—` placeholders |

**P3.4's premise is confirmed exactly.** The dash, the perpetual "Loading…" and the bare zero are all live right now, on the homepage, `/departures` and `/goahead`.

---

## 0.5 Blog infrastructure

**One published post.** `blog_posts` is better equipped than the brief assumes.

| P5.1 field | Status |
|---|---|
| Author name | ✅ `author` — populated: "Mariam Hassan" |
| Author credential | ✅ `author_credentials` column exists — **NULL** on the only post |
| Published date | ✅ `published_at` — 8 June 2026 |
| **Last-reviewed date** | ❌ Only `updated_at`. `seo.js` maps `dateModified` from it. A distinct editorial "last reviewed" needs a new column |
| **Category** | ❌ Only `tags TEXT[]`. No category field, no taxonomy, no per-category routes |
| Anchor-date reference | ❌ Does not exist |

Also present and useful: `tldr`, `key_takeaways`, `faq` (JSON), `geo_region/place/lat/lng`, `meta_title`, `meta_description`, `keywords`, `canonical_url`, `og_image`, `noindex`.

**Structured data (already good):** `postSchema()` in `server/seo.js` emits `Article` with author, publisher, `datePublished`, `dateModified`; **`FAQPage` when `faq` is populated**; `Place` with geo-coordinates. P5.6 is mostly satisfied already — the gap is `dateModified` needing to come from a real last-reviewed field.

**Blog index (`BlogIndexPage`, `main.jsx:2982`):** masthead "Notes from the Nile", loading skeletons (already correct per P3.4), a designed empty state, and cards that are properly crawlable anchors. **Missing:** the P5.3 hero copy, the two CTA buttons, category navigation, category/last-reviewed on cards, and the forming-dates module.

**Existing post metadata** — P1.5's target confirmed:

> "Egypt group tours often get cancelled for low numbers. Sawa's GoAhead model **guarantees your date** before you pay. Here's how shared departures work."

`author_credentials` is NULL, so P5.4's article footer has nothing to render. **Blocker B7.**

---

## 0.6 Entity and legal identity

**Better than expected — this is the most consistent area of the site.**

| Location | Content |
|---|---|
| Footer (all 20 static pages + SPA `main.jsx:1232`) | "© 2026 Sawa Tours · Operated by Capital Travel Service · ETAA 2179" |
| `site/terms.html:89-94` | "operated by **Capital Travel Service**, trading as **Sawa Tours**" + Giza postal address |
| `site/privacy.html:100-102` | Same entity, "ETAA licence: 2179", same address |
| `site/cookies.html:86` | Same entity |
| `server/brand.js:38` | `accreditations: ["Operated by Capital Travel Service — ETAA licence no. 2179"]` |

The footer is **generated** from `site/_partials/footer.html` — P2.1 edits that one file and runs `npm run sync:partials`.

### Mismatches found (P2.4)

1. **JSON-LD names the wrong entity.** `BRAND.name` is "Sawa Tours"; there is **no `legalName`**. Terms and Privacy say the legal entity is Capital Travel Service. Structured data should carry `legalName: "Capital Travel Service"`.
2. **JSON-LD address is empty** — `streetAddress: ""`, `postalCode: ""` (both TODO) — while Terms and Privacy both publish the full Giza address.
3. **`/about` carries no entity disclosure at all** beyond the footer. P2.2 is genuinely net-new.
4. **Unfilled brand TODOs** feeding structured data: `foundingDate`, `founders`, `sameAs` (social profiles), `awards`, `priceRange`.

**No contradictions between locations** — the gap is JSON-LD being less complete than the legal pages, not disagreeing with them.

---

## 0.7 Blockers

| # | Blocker | Blocks | Why I can't decide it |
|---|---|---|---|
| **B1** | **Per-product minimums.** Your "no per-product minimum" contradicts a deliberate, documented, database-enforced design. Options (a)/(b)/(c) in §0.2.1 | **P1.1, P1.2** — the foundation of Phase 1 | (b) removes a shipped capability and touches pricing; (c) rewrites copy you marked `[EXACT COPY]` |
| **B2** | **Static HTML can't read JS constants.** ~30 of the 40+ instances are in hand-written HTML with no build step. Options: (i) accept them as manually-maintained with a drift test like `partials.test.js`; (ii) add a build step; (iii) convert the pages to templates | **P1.1** and the acceptance criterion "zero hardcoded instances remain in code" | (ii) and (iii) are significant architectural changes well beyond a copy fix |
| **B3** | **True support availability.** Four different claims are live (§0.3) | **P1.6** | Only you know what is actually staffed |
| **B4** | **`/verify` already exists** and is operator-facing. `/verify-operators` doesn't collide but is confusingly similar. Suggest `/verification-standard` | **P4.1** | Naming/IA decision |
| **B5** | **Siwa has a full destination page** in the sitemap but no product. Removing the marquee item doesn't address it | **P1.4** | Deleting an indexed page is an SEO decision |
| **B6** | **Six agency rows look like seed data**, incl. one named "adham". Capital Travel Service is not among them. Are any real? Should the others be purged? | **P2.3, P4.2** | I won't touch production data on inference |
| **B7** | **`author_credentials` is NULL** on the only post | **P5.1, P5.4** | Item 6 on your supply list |
| **B8** | **No route-alert table exists.** P6.1's data model is net-new; it needs to capture the demand signal *and* attribute it | **P6.1** | Schema design tied to how you'll actually use the signal |
| **B9** | **Migrations don't run on deploy.** `npm start` is `node server/app.js` — no migrate step. Every Phase 3/5/6 migration needs a manual `npm run db:migrate` against production | **P3.1, P3.5, P5.1, P6.1** | Deployment-process decision |
| **B10** | **"Verified operator" is a fallback string** rendered when a departure has *no* guide data (`index.html:957`, `goahead.html:283`) — the claim appears precisely where data is absent | **P1.6** | Needs a replacement you approve |
| **B11** | **Price tiers vary price by group size** (`schema_020`: 4→$110, 7→$85, 10→$60). P6.4's "render price from the itinerary record" must decide *which* price — the at-minimum price, or a range | **P6.4** | Pricing-presentation decision |
| **B12** | **`/goahead` renders a hardcoded "100% guaranteed to run".** Under P1.5 this goes — but that panel is the page's whole trust proposition and would be left with two em-dashes | **P1.5, P3.4** | Needs replacement copy |

---

## Where the brief and reality diverge — summary

| Brief assumes | Reality |
|---|---|
| Next.js App Router | Express + Vite SPA + static HTML |
| Constants need creating | Already exist and are DB-enforced; the gap is copy |
| No per-product minimum | Per-product minimums are a deliberate, documented feature |
| `/itineraries` wording is wrong | It is accurate to the data model — the *model* is what conflicts with the brief |
| Blog index is a bare list | Has skeletons, empty state, crawlable cards; missing hero/categories/dates |
| Blog needs structured data | `Article` + `FAQPage` + `Place` already emitted |
| Departures need URLs added | Departures have **no data at all** — 0 rows |
| Entity disclosure needs adding | Already consistent in footer/Terms/Privacy/Cookies; JSON-LD is the gap |

**Live inventory verified — your figures were exactly right:** 11 day tours ($45–$68), 3 packages (Nile Majesty $675, Egypt in Depth $1,390, Egypt End to End $1,520). All 14 approved and active, all `min_seats=4`, all `max_seats=12`.

---

## Recommended sequence, if you want one

1. **Answer B1** — everything in Phase 1 hangs off it.
2. **Pull the four fabricated stats and the "100%" immediately**, ahead of the rest of Phase 1. They are the clearest liability and the change is small.
3. **Answer B2** — it determines whether "zero hardcoded instances" is achievable or needs restating.
4. **Phase 3 waits on your real departure data (P3.2).** Nothing in Phase 3 can be meaningfully tested against an empty table, and P3.3's State B — the screen you want to be the best on the site — cannot be designed against zero rows.

---

*No files were modified in the production of this audit. Awaiting your response before Phase 1.*
