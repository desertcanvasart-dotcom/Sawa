# PPP1 — Every gate protects code. Data changes bypass all of them.

**10 August 2026.**

`preflight`, the pre-commit hook, `audit:claims`, `smoke` — all of them run when
someone touches the repository. **Two products appeared in production within an
hour, adding two routes and the copy that came with them, and no gate ran.**

Claims live in database fields here. `blog_posts.tldr` and the FAQ JSON have
both carried findings that source-reading missed. So a product added through the
admin panel can introduce exactly the class the auditor exists to catch, and the
auditor will not see it until somebody happens to run it.

---

## PPP1.3 — What checking the two new products actually found

The class is not confined to them.

| | |
|---|---|
| Product pages audited | **16 of 16** |
| Findings | **30** |
| Pages with at least one | **16 of 16** |

Every finding is a British spelling in database copy:

| Word | Pages |
|---|---|
| `travellers` | 16 |
| `travelling` | 11 |
| `travelled` | 1 |
| `recognised` | 1 |
| `organisation` | 1 |

The two new products were merely the ones that made it visible: Minya carries
4× *travellers* and 1× *recognised*, Fayoum 2× *travellers*.

### Why no gate has ever seen this

`server/constants.test.js` — *"every static page is written in US English"* —
iterates `pages()`. **Static files only.** `audit:claims` has no spelling rule
at all.

So U4.3, a standard that was **deleted once to make a build pass and then
deliberately restored** — *"US English site-wide, and supplied copy bends to the
site"* — is enforced on exactly the surfaces that go through git, and on none of
the surfaces that do not.

### The rest of PPP1.3, all clean

| Check | Result |
|---|---|
| Fourth package inherits the 30-day confirm deadline | ✅ `confirm_deadline_days` is `null`, so it takes the package default |
| Price renders from data | ✅ `$56` on the Minya package |
| GoAhead numbers from constants | ✅ "4–12 travel…", "4 travel…" |
| Interface promises in product copy | ✅ none, **after the rule was narrowed** |

---

## The rule fired on correct copy, which is NNN1's second half

`INTERFACE_PROMISES`, drafted for OOO1.2, matched any *"you'll see"*. On its
first run it flagged two product descriptions:

> "as the sun rises and the road heats, **you'll see** the desert's famous
> mirages shimmer in the distance"
>
> "this 'lesser' road is where **you'll see** ancient temple-building at its
> best-preserved"

Both are about what a traveller sees **in Egypt**. Shipped as drafted, the rule
would have reported two findings forever on correct copy, been baselined within
a fortnight, and taken the real class with it.

Narrowed so the promise must land near something **the site would have to
render** — a name, a licence, a rating, a price, "on every departure", "before
you book". Both halves are asserted in `server/audit-page.test.js`: it fires on
the two promises that were live and unflagged, and stops on four pieces of
ordinary travel prose.

---

## And the tool committed the failure it was written to describe

`scripts/audit-page.js`, on its first run, **audited a 404, reported "0
finding(s)" and exited 0.**

Its own header warns that a total cannot distinguish "checked and passed" from
"never checked". A non-200 is now a failure, and the summary line reports
`N of M audited` with an `UNREACHABLE` count.

---

## PPP1.4 — Surfaces that write claim-bearing text with no check between the write and the reader

| Surface | Writes | Gate between write and reader |
|---|---|---|
| `POST /api/admin/tour-products` | title, description, overview, itinerary, included/excluded, policies, meeting point | **none** |
| `POST /api/agency/tour-products` | the same, via an operator | **none** (admin approval reviews the listing, not the copy) |
| `POST /api/admin/tour-products/:id/pricing` | prices across the product and every departure | **none** |
| Blog admin | `blog_posts.title`, `excerpt`, `body_html`, `tldr`, `key_takeaways`, `faq` | **none** — and `tldr` has already carried a finding |
| Departure creation | route, city, guide, vehicle, notes | **none** |
| `agencies` | name, contact name | **none** |

All are audited **after the fact** by `audit:claims`, and only when a human runs
it. Nothing runs on write.

---

## Recommended

1. **PPP1.1** — run `audit:claims` and `smoke` against `https://sawa.tours` on a
   schedule, reporting findings **and route-count change**. Route count 39 → 41
   was the signal that production had moved; nothing was watching for it.
2. **The 30 spellings are a data fix**, not a code fix — 16 rows in
   `tour_products`. Proposed as a reviewable script for the client to run, in
   the same way migrations are. Not applied here.
3. **Add a spelling rule to `audit:claims`** so the standard covers rendered
   output rather than source files. That is the change that makes U4.3 true
   rather than merely stated.
