# W1.2 — Check register: verdict or pointer

**9 August 2026.**

**A check that reads a representation of the system produces a pointer, never a
verdict. A verdict requires observation of the running system.**

Five confident wrong answers in this project, all from reading a representation:

| Method | Failure |
|---|---|
| Source pattern-matching | Missed minified code |
| Database table read | Missed hardcoded operator names |
| Source inspection | Declared live config dead; broke three routes |
| Unit tests | 176 passed while 19 routes served a raw shell |
| Internal documentation | Said log-mode; production had been sending for three days |

Route-fetching and production queries have not produced a wrong answer yet.

---

## `preflight` steps

| Step | Reads | Class | Runtime observation that would confirm it |
|---|---|---|---|
| `check:constants` | static HTML **source** | **POINTER** | Fetch every route and assert no group-size number contradicts `shared/group-size.js`. **Added** — see below. |
| `check:status-literals` | JS/JSX/HTML **source**, against the schema's CHECK constraints | **POINTER — but a sound one** | Both sides are read from source, and that is the point: the schema file IS the contract, so a mismatch between them is decidable without a running system. What it cannot tell you is whether the deployed database matches the schema files — migrations do not run on deploy (B5). Confirmed by rendering: a departure whose only pledge is `cancelled` shows State A rather than "3 of 4 joined". |
| `audit:repo-truth` | comments and docs | **POINTER by definition** | It collects notes; each verdict in the register is a separate runtime check. This is the one check that is *supposed* to be a pointer. |
| `test` | modules in isolation | **POINTER** | `smoke` — and this exact gap is proven: 176 passed while 19 routes served a raw shell. |
| `smoke` | **running server, all 39 routes** | **VERDICT** | — |
| `audit:claims` | mixed — see below | **mixed** | — |

## `audit:claims` sources

| Source | Class | Note |
|---|---|---|
| Rendered routes — visible text, meta, JSON-LD, attributes | **VERDICT** | Fetched from the running server |
| `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml` | **VERDICT** | Fetched |
| Meta-description length | **VERDICT** | Measured on served output |
| Dead-config check | **VERDICT** | Compares config against what each route serves |
| Database columns | **VERDICT** for content, **POINTER** for reach | Reads production rows. Whether a column *reaches a public surface* is inferred, not observed — a column could be clean and still be rendered somewhere unaudited, or carry a claim that never renders. **Accepted gap.** |
| **Email templates** | **VERDICT** | Templates are **invoked** with fixture data, so what is scanned is the rendered subject, HTML and text a recipient receives — not the source |
| Built JS bundles | **POINTER** | The SPA's client-rendered DOM is not executed. Bundle text is a *superset* of what the DOM can show, so a miss is impossible but a false positive is not — dead code counts. **Accepted gap:** closing it needs a headless browser. |

## Test suite

| File | Class | Note |
|---|---|---|
| `domain`, `slug`, `dates`, `page-cache`, `canonical`, `inline-json` | **VERDICT of the unit** | Pure logic, no representation in between. Says nothing about the site. |
| `constants.test.js` | **POINTER** | Reads files. Confirmed by the new runtime group-size check. |
| `partials.test.js` | **POINTER** | Reads files. **Accepted gap:** a served-footer assertion would close it. |
| `seo.test.js`, `static-seo.test.js` | **POINTER** | Build strings from fixtures; do not observe a served page. Also the two that reach the database — see V3. |
| `spa-shell.test.js` | **POINTER** | Asserts `index.html` contains the guard. The rendered proof was done by hand in the browser and is not automated. **Accepted gap.** |
| `smoke-routes` `checkRoute()` | **VERDICT** | — |

---

## Closed under W1.2

**`check:constants` was a pointer and is now backed by a verdict.** `smoke-routes.js`
gains a group-size assertion over served output: every route is scanned for a
number stated as the GoAhead threshold or the ceiling, and any value contradicting
`shared/group-size.js` fails.

This is not theoretical — it is the `/how-it-works` "group of 4–8" bug, which the
source-reading check could not see because its rule expected a different phrasing.
A served-output check catches it regardless of phrasing.

## Accepted gaps

Recorded rather than closed, each with what would close it:

1. **Built bundles** — needs a headless browser to execute the SPA. Bundle text is
   a superset, so no claim can hide; dead code can produce a false positive.
2. **Database reach** — a column's *content* is observed; whether it reaches a
   public surface is inferred.
3. **`partials.test.js`** — footer drift is checked in source, not in served HTML.
4. **`spa-shell.test.js`** — the flash guard is asserted in the template, not
   observed in a browser.
5. **Commit messages** — out of scope by agreement.
