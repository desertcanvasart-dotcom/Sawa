# P1.5 — "guarantee" sweep

**8 August 2026.** Every remaining instance of *guarantee / guaranteed / 100% /
risk-free / hassle-free* in site copy or metadata, after the fixes below.

P1.5 says: *do not auto-rewrite body copy; flag it.* So this splits in two.

---

## Changed (metadata, labels and the specified copy)

Metadata is not body copy, and it is what reaches Google and the AI engines
directly, so it was corrected rather than flagged.

| Where | Was | Now |
|---|---|---|
| `blog_posts.meta_description` | "…Sawa's GoAhead model **confirms** your date before you pay…" | the supplied copy, verbatim |
| `blog_posts.excerpt` | "…how Sawa's GoAhead model **guarantees your date** before you pay a deposit." | the supplied copy, verbatim |
| `server/seo.js` `/how-it-works` **title** | "How Sawa Works — **Guaranteed** Shared Tours" | "How Sawa Works — Shared Departures, Confirmed Before You Pay" |
| `server/seo.js` `/how-it-works` description | "…your departure is **guaranteed** before you pay a deposit." | "…confirmed before you pay a deposit." |
| `server/seo.js` `llms.txt` | "…the date is **guaranteed** before you pay." | "…the date is confirmed before you pay." |
| `site/goahead.html` meta + og:description | "Every trip on this page is **guaranteed to run**." | "These departures have reached their GoAhead number, so they are confirmed and running." |
| `site/goahead.html` hero stat | **"100% guaranteed to run"** | removed; replaced with the supplied sentence |
| `site/goahead.html` departure card label | "**Guaranteed** to run" | "Confirmed to run" |
| `site/goahead.html:111` hero demo card label | "**guaranteed** to run" | "confirmed to run" |

The last two were found only by checking the **served page** rather than the
source: a first pass classified them as CSS noise alongside `width:100%`. Both
are labels a visitor reads.

### A correction to the brief

The brief and the Phase 0 audit both said the *meta description* contained
"guarantees your date". It did not — the **excerpt** did. The meta description
said "confirms". The supplied replacement copy is very close to the existing
excerpt, so it reads as a rewrite of that sentence, and it has been applied to
both fields. Flagging in case only the meta description was intended.

---

## Body copy — flagged first, then applied on approval

Each of these is a sentence a person wrote, so under P1.5 each was proposed
rather than rewritten. **All five were approved and are now applied** — see
"Applied on approval" below for what landed, including five more the first pass
had missed.

### 1. `site/goahead.html:59` — hero lede

> Every departure on this page has reached four confirmed travelers — the
> GoAhead. **These trips are guaranteed to run**, and most still have seats…

Note also "four confirmed travelers", which states the threshold as universal
when it is per product. Proposed:

> Every departure on this page has reached its GoAhead number, so it is
> confirmed and running — and most still have seats…

### 2. `src/main.jsx:2058` and `:2582` — the how-it-works step 03 heading

> **It runs, guaranteed** / **It runs — guaranteed**

The same step on the static `/how-it-works` page reads "Four travelers, and the
gold dot turns on". Proposed: **"It runs — confirmed."**

### 3. `src/main.jsx:2728` — FAQ answer

> "GoAhead means a date has reached the minimum travellers, so the guide and
> vehicle are booked and the **departure is guaranteed to run**."

Proposed: "…and the departure is confirmed to run."

### 4. `blog_posts.tldr` — renders in-article as "In short:"

> "Sawa pools travellers onto shared dates; once a date hits its minimum it's
> **guaranteed to run**, and you only pay then."

Proposed: "…once a date hits its minimum it's confirmed to run, and you only pay
then."

### 5. Section headings and HTML comments

- `site/goahead-promise.html:67` — `<!-- THREE GUARANTEES -->`
- `site/how-it-works.html:178` — `/* ===== guarantees ===== */`
- `site/how-it-works.html:439` — `<!-- GUARANTEES -->`

Not visible to a reader, so not urgent — but they name the section, and the
section is what the word is being removed from.

---

## Left alone deliberately — correct legal usage

`terms.html` uses the word to state a **limitation**, which is the honest use and
should stay:

- `:135` "a displayed place is **not guaranteed** until your reservation is accepted"
- `:233` name changes "may not be possible"
- `:255` "A request is **not guaranteed**"

---

---

## Applied 8 August 2026, on approval

All five flagged items were approved and applied, plus five more the first sweep
had missed. Two of the five were found only by reading the rendered post and the
served page; four were in long minified lines that a `.{55}…` extraction skipped.

| Where | Now |
|---|---|
| `/goahead` hero lede | "…has reached its GoAhead number, so it is confirmed and running" — also drops "four confirmed travelers", which stated the threshold as universal |
| `main.jsx` how-it-works step 03 (×2) | "It runs — confirmed." |
| `main.jsx` FAQ answer | "…the departure is confirmed to run." |
| `blog_posts.tldr` | "…it's confirmed to run, and you only pay then." |
| Section headings (×3) | GUARANTEES → PROMISES |
| **`blog_posts.faq`** | Fed the `FAQPage` structured data — "it's confirmed to run" |
| **`server/brand.js` `BRAND.description`** | "…**are guaranteed to run**" → "…reach the numbers they need to run" |
| `main.jsx:2043` how-it-works lead | "…it is confirmed to run." |
| `main.jsx:2614` trust item | "…only charged once the date is confirmed to run." |
| `main.jsx:2629` about lead | "…real, confirmed group departures across Egypt." |
| `main.jsx:2635` about body | "…only needs a handful of people to be confirmed" |

`BRAND.description` was the worst-placed instance on the site: one string feeding
the `/about` meta description, the JSON-LD `Organization` description **and**
`llms.txt`. Google and the AI engines were reading "packages across Egypt are
guaranteed to run" directly from it.

### Still outstanding — one editorial decision

`site/operators.html:143`, an H1 pitched at operators:

> Add **"guaranteed departures"** to your…

Held back because rewriting it changes the pitch to operators rather than
correcting a factual claim about travellers. Proposed: **Add confirmed
departures to your…**. Your call.

---

## Acceptance status

The amended checklist asks that *"guarantee", "guaranteed", "100%" appear nowhere
in site copy or metadata*.

**Metadata: clear. Body copy: clear**, apart from the one operator-facing headline
above. Approve that headline (or supply your own) and the item closes.
