# DIR-8 — `slugify` / `tourSlug`: the divergence report

**10 August 2026.** Reported before any fix, per instruction. Behavioural, not
textual: each hand copy was extracted from its page and **evaluated** against the
live catalogue plus the edge cases `server/slug.js` documents. Two copies that
read differently but behave identically are not a defect; two that read the same
and behave differently are the worst case.

---

## There are **nine** copies, not two

`server/slug.js`'s own header says:

> *"The same logic is mirrored on the frontend (src/main.jsx) and in the static
> site scripts (site/index.html, site/departures.html) — keep them in sync."*

Both halves of that are now wrong.

- **`src/main.jsx` no longer mirrors it** — it imports `tourSlug` from
  `server/slug.js`. The header is stale in the safe direction.
- **It names two static files. There are eight**, each with its own hand-written
  copy:

```
site/index.html          site/goahead.html        site/departures.html
site/destinations/cairo.html      site/destinations/luxor.html
site/destinations/aswan.html      site/destinations/siwa.html
site/destinations/abu-simbel.html
```

A comment asking the next person to keep nine copies in sync, naming three of
them.

### Two naming conventions, which is the hand-copy signature

| Files | Declares |
|---|---|
| `index`, `goahead`, `departures` | `SLUG_STOP`, `SLUG_CITY` |
| the five `destinations/*` | `STOP`, `CITY` |

Same logic, different variable names — copied at different times, by hand.

---

## 20 of 23 cases agree. **Three diverge, and all three are the same branch.**

Every real catalogue title agrees across all eight copies. The divergence is
confined to the fallback branch — and that branch is the one `server/slug.js`
documents as a **301-redirect-loop fix**.

| Case | `server/slug.js` | the five `destinations/*` pages |
|---|---|---|
| Arabic title (slugifies to nothing) | `cairo-tour-abc123` | **`-from-cairo`** |
| Title of only stop-words | `luxor-package-xyz789` | **`pkg_xyz789`** |
| Empty title | `aswan-tour-zzz` | **`-from-aswan`** |

**The five destination pages carry the pre-fix version.** The fix reached
`server/slug.js`, `index.html`, `goahead.html` and `departures.html`, and never
reached `destinations/`.

Both failure modes are described, in advance, in the authority's own comments:

> *"Appending to an empty one gives the malformed `-from-cairo` for any title
> that slugifies to nothing — an Arabic title, or one made entirely of
> stop-words."*

> *"Falling back to the raw id emitted an id-shaped slug (`tour_…` / `pkg_…`),
> and the legacy-URL redirect in app.js rewrites exactly those to their slug —
> i.e. to itself. **That is a 301 loop, which browsers cache permanently.**"*

---

## What masks it — and what would arm it

**Every one of the 16 live product titles contains at least one non-stop-word
ASCII token.** That is the invariant holding the defect closed, and it is not
enforced anywhere: no constraint, no check, no validation on the admin form.

This is the third time this pattern has appeared. The `isForming` / `isGoAhead`
unification found three real divergences, all masked by unrelated invariants.
**Three again, masked again.**

**What would arm it:** one product with an Arabic title, or a title made only of
stop-words. The catalogue is being extended right now — two products were added
during this session — and an Arabic title on an Egyptian operator's listing is
not an edge case anyone would think to avoid.

**Where it would land:** the destination pages are the SEO landing pages the
content programme is built on. A visitor clicking a card there would reach a URL
the server 301s to itself, and the browser caches that permanently.

Recorded in [the evidence register](evidence-expiry.md) as **E-13**.

---

## The fix, not yet applied

The `shared/group-size.js` + `check:constants` pattern, exactly as `check:rules`
already does it for the board rules:

| | |
|---|---|
| **One authority** | `shared/slug.js` |
| **Generated** | `site/assets/slug.js`, the way `site/assets/rules.js` is generated from `shared/departure-state.js` — the static pages cannot import |
| **A check** | `check:slug` fails on a stale generated file, in `preflight` |
| **A parity test** | evaluates the file the browser actually loads against the server authority, over the live catalogue and every edge case above |
| **Proven both ways** | it fires on a planted divergence and stops on a correct one (NNN1) |

Nine copies become one authority and one generated artefact, and there is
nothing left to keep in sync.

---

## A note on how this was measured

The first run of the extractor reported **five files throwing `STOP is not
defined`** and would have been filed as "the destination pages are broken". They
are not: the extractor only knew the `SLUG_STOP` naming and not the `STOP`
naming. Checked before filing, per NNN3 — the third time in this session that
verifying the tool before the finding was the right move.
