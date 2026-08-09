# ZZ1 — The swallowed-error sweep

**9 August 2026. Node v22.21.1 · TZ=UTC · PostgreSQL 17.10 (ephemeral).**

The mirror was configured for the whole life of the feature and never once
transmitted. `emitDepartureSync` called `loadEnriched` — a function that has
never existed — and the `.catch()` turned every `ReferenceError` into a
`console.warn`.

Found by **running it against a listener**, not by reading it. So the rest of
this sweep does not rely on reading either: the top candidates were exercised.

---

## ZZ1.1 — The pattern, enumerated

| Shape | Found | Notes |
|---|---|---|
| `.catch(() => {})` — empty | **19** | 13 are `sendEmail(...)`; the rest are Supabase admin cleanup and SPA fetch fallbacks |
| `.catch(...)` logging at `warn` | **4** | the page warmer (3) and the Autoura capacity feed |
| `try`/`catch` not rethrowing or surfacing | **20 candidates**, **6 real** | the detector over-reports; see below |
| fire-and-forget, untracked | **1** | `emitDepartureSync` — fixed under TT1 |
| failure output identical to success | **2** | the mirror (fixed), the cancel job's zero (fixed under PP2) |

**The detector over-reports and that is worth stating.** `server/auth.js:45` was
flagged and is correct — it calls `next(err)`, which surfaces through Express.
Four of the `scripts/` hits are `try { readdirSync } catch { continue }` around a
filesystem walk, where continuing is the intent. A pattern match is a **pointer**;
each had to be read.

---

## ZZ1.2 — Ranked by whether the path is ever exercised

| Path | Exercised | Rank |
|---|---|---|
| `sendEmail(...).catch(() => {})` ×13 | **every booking, every confirmation, every invite** | **1** |
| `emitDepartureSync` | every departure write | **1** — was the bug |
| `unavailableDates()` — the westbound capacity feed | every traveller-initiated date request | **2** |
| `seo.js` sitemap DB block | every `/sitemap.xml` | **3** |
| `seo.js` llms live block | every `/llms-full.txt` | **3** |
| page warmer | every 45s | 4 |
| Supabase admin cleanup `.catch(() => {})` | account creation rollback only | 5 — dormant |
| SPA `.catch(() => ({ …empty }))` | admin dashboard loads | 5 — renders empty, visible |

---

## ZZ1.3 — The top candidates, run

### ✅ The westbound capacity feed — works

The other half of the same feature, and the one most likely to share the fault.
Run against a listener:

```
capacity feed hit: /capacity?brand=sawa-tours&days=120 | secret header: present
returned: [ '2026-09-01', '2026-09-02' ]
```

It requests, authenticates, parses and caches. **It also has two live callers**
(`app.js:1172`, `1198`) — checked, because a working function nobody calls is the
same class of nothing-happens.

### ✅ The sitemap's database block — works

Against **production**:

```
38 <url> entries
<loc>https://sawa.tours/tour/giza-pyramids-sphinx-grand-egyptian-museum-from-cairo</loc>
```

Tour URLs are present, so the `catch { /* DB optional */ }` is not swallowing.

### ✅ The llms live block — works

**And a correction to my own first reading.** I fetched `/llms.txt`, found no live
section, and took that as evidence the block was being swallowed. Wrong route:
`/llms.txt` serves the static text by design, and the live block is on
`/llms-full.txt`. Against production:

```
68 lines
## Live tours (current)
## Departures forming now (live)
- No public departures forming at the moment — travellers can start a date …
## Destinations we cover
```

The empty-state line is correct — `departures` holds no rows. **The same
shortcut-verification mistake the runbook already warns about** (DD1/WW2), made
while auditing for exactly that class.

### ⚠️ `sendEmail` — works, but its 13 call sites swallow

`email_log` holds one row with status `sent` (5 August), so delivery has worked
at least once. `sendEmail` is written never to throw: it catches internally and
returns `{ ok: false }`.

So the 13 `.catch(() => {})` are belt-and-braces — **and they are the mirror's
shape exactly**. If anything in that function ever throws outside its own
handlers, every call site discards it silently, and nothing anywhere would say
so.

That is what ZZ1.4 addresses rather than deleting the catches: the catches are
correct, the silence is not.

---

## ZZ1.4 — The class is now loud

`server/effect-log.js`. A non-fatal failure is still **recorded and counted**,
and every failure is a `console.error` with a reason — never `warn`.

Wired to the two paths that matter: **email**, because it reaches a named person,
and **the mirror**, because it is the one that was configured and inert.

The state it exists to surface:

```
neverWorked: successes === 0 && failures > 0
```

Configured, tried, and never once succeeded. That is the state the mirror was in
for its entire life, and nothing reported it.

`lastSuccess` is a **timestamp, not a boolean**, so *"never since boot"* and
*"not for three days"* stay distinguishable — and *"worked once and is now
failing"* is a different state from *"never worked"*, because they call for
different responses. Both asserted.

---

## Still open

| | |
|---|---|
| The 13 `sendEmail(...).catch(() => {})` call sites | left as-is. `sendEmail` now records its own effect, so the information exists whether or not a caller discards it — but the *call sites* still swallow, and a future non-throwing-by-contract function will not. |
| The page warmer's three `console.warn` handlers | a warm failure is genuinely non-fatal and visible as a slow page. Not wired; recorded here so the decision is a decision. |
| `effect-log` is per-process, in memory | a restart clears the counters. A durable store is the better answer and a bigger change; what this had to beat was `console.warn`. |
