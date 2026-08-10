# DIR-19.2 — where the operating entity is named

**Response-derived sweep, 10 August 2026.** Nothing renamed. DIR-19 forbids
placeholders and the registered name has not arrived, so this establishes the
**checklist** DIR-19.1 will execute against — and ratchets it so it cannot grow
while we wait.

---

## The four surfaces, swept as output rather than as source

| surface | method | result |
|---|---|---|
| **rendered pages** | fetched `https://sawa.tours` for all 23 public routes | **23 of 23 carry it** |
| **transactional email** | rendered all 13 exports of `server/email.js` | **12 of 12 real templates carry it**; the 13th is the sender |
| **production database** | `ILIKE` across **121 text columns** in the public schema | **0 rows** |
| **source** | walked `site/ server/ src/ scripts/ shared/` | **five independent authors** |

### The rendered sweep found something a source grep would not

**`/itineraries`, `/blog` and `/booking` disclose the entity in JSON-LD and have
no footer at all.** On those three routes the only statement of who runs Sawa is
machine-readable. A rename that fixed visible copy and left `server/brand.js`
would leave the old entity in the structured data Google reads, on three pages,
with nothing on screen to contradict it.

### What the sweep could not reach, stated

`sitemap.xml` was unreachable, so `publicRoutes()` fell back to its **23
hard-coded routes**. Tour, package and blog detail pages were **not swept**.
They are rendered from the same shell and are expected to carry the same footer,
but expected is not swept — and this is the second time that fallback has
narrowed a sweep without saying so in the result line.

---

## Five authors, four sentences, one fact

The earlier note in DIR-19 said *"at least 10 `site/*.html` files"*. The files
are 22, but the **authors** are five — the rest are generated:

| where | occurrences | what it says |
|---|---|---|
| `site/_partials/footer.html` | 1 | *"© 2026 Sawa Tours · Operated by Capital Travel Service · ETAA 2179"* — written into 21 static pages by `applyFooter` |
| `src/main.jsx` | 1 | the same sentence again, for the SPA — a **second** copy, not a read |
| `server/brand.js` | 1 | *"Operated by Capital Travel Service — ETAA licence no. 2179"* → JSON-LD |
| `server/email.js` | 1 | *"Capital Travel Service, trading as Sawa Tours · Giza, Egypt"* — **hardcoded, not read from `BRAND`** |
| `site/privacy.html` ×2, `site/cookies.html` ×1, `site/terms.html` ×1 | 4 | *"…explains how Capital Travel Service, trading as Sawa Tours…"* — the controller and the contracting party, in body prose |

**Nothing makes these four sentences agree.** This is the `tourSlug` shape that
DIR-7 removed nine copies of: one fact, several authors, and the one nobody
remembers is the one that drifts. `server/email.js` is the likeliest to be
missed — it is the only surface a reader cannot see by browsing the site.

---

## What was built instead of a rename

`server/entity-disclosure.test.js` — a **ratchet**, not a restructure.

- the five authors are declared with the surface each one serves; **that list is
  DIR-19.1's checklist**
- a **sixth** author fails the build, with the reason stated in the failure
- an author that stops naming the entity also fails — a stale checklist is worse
  than none
- the 21 static pages are asserted to carry the partial's sentence **verbatim**,
  so if the footer ever stops being generated the count jumps from five to
  twenty-six and this says so
- it is proved to fire on a planted sixth author
- `email.js` is pinned as **not** reading from `BRAND`, so that if it ever does,
  the change is deliberate rather than assumed

**Restructuring to one authority was deliberately not done.** It would be a
change to legal and controller copy across three policy pages, and DIR-19.1 is
where that belongs — once there is a name to write.

---

## DIR-19 EXECUTED — 10 August 2026

**The entity is `Online Era`, registration `148500`.** Rendered exactly as
supplied: **no legal-form suffix was given, so none was added**, and a test
asserts no `LLC`/`Ltd`/`S.A.E.` ever appears after it.

All five authors edited, plus two the change itself created:

| | now reads |
|---|---|
| `site/_partials/footer.html` → 21 pages | *"© 2026 Sawa Tours · Operated by Online Era · Registration 148500"* |
| `src/main.jsx` | the same, for the SPA |
| `server/brand.js` | `legalName: "Online Era"`, `registrationNumber: "148500"` → JSON-LD `legalName` + a typed `identifier` |
| `server/email.js` | *"Online Era, trading as Sawa Tours · Giza, Egypt"* |
| `privacy` ×2, `cookies`, `terms` §1/§2 | controller identity and contracting party |
| **`site/about.html`** — new | *"Who runs Sawa"*, beside the 1993 founder history |

### ⚠️ Two things were REMOVED rather than transferred

**ETAA 2179 and the registered office address belong to Capital Travel Service.**
Restating either under Online Era would be a false statement about who is
licensed and where they are registered — in the one paragraph a reader relies on
to know who they are contracting with.

| removed from | was |
|---|---|
| the footer, on 21 pages + the SPA | *"· ETAA 2179"* |
| `BRAND.accreditations` → JSON-LD `hasCredential` | *"Operated by Capital Travel Service — ETAA licence no. 2179"* — the node is now **absent**, not empty-but-present |
| `terms.html` §1 | the ETAA licence clause **and** *"registered office at Flat 6, Floor 1, Block 1, Panorama Pyramids Building, El-Ahramat Street, Giza"* |

**Both are outstanding client items**, added to the list: Online Era's own
registered address, and its tourism registration **if it holds one**. An empty
`accreditations` list is the honest state until they arrive.

> **A note on where this explanation lives.** It was first written as an HTML
> comment in `terms.html`. **HTML comments are served** — so the only place
> `ETAA 2179` and `Capital Travel Service` still appeared in production was a
> comment on the Terms page, which is the one page the change existed to clean.
> Caught by reading the live HTML after deploy rather than by any check:
> `entity-disclosure.test.js` strips comments before asserting, correctly, and
> so could not see it.

### DIR-19.3 — proposed, not applied

Capital Travel Service becomes an operator record with the founding-partner
label. **There was nowhere to put that label**: `agencies.status` is an on/off
switch, and overloading it would make one column answer two unrelated questions.

`server/db/schema_029_agency_relationship.sql` adds `relationship`, nullable with
no default, `CHECK (… IN ('founding_partner','operator'))`.

**`relationship` is not verification.** 025's `verification_state` stays NULL —
*never assessed* — and must. A row reading "founding partner" that rendered as
"verified operator" would be the fabricated-operator-card defect rebuilt from
real data, which is worse, because the company would actually exist.

### The ratchet is now the other direction

`server/entity-disclosure.test.js` tracks **Online Era** and additionally
asserts that no surface says *"operated by Capital Travel Service"*, names it as
the trading entity, or carries **ETAA 2179** — so the old disclosure cannot
return through a partial revert.
