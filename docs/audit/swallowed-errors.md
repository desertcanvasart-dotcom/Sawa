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

# AAA1 / AAA2 — the general form, and a gate

**10 August 2026. Node v22.21.1 · TZ=UTC.**

ZZ1 closed the two paths that mattered and left the class open. AAA is the class:
the thing that would have surfaced the mirror **on the day it was written**,
rather than thirteen edits that fix the thirteen sites we happened to look at.

---

## AAA2 — a programmer error is not a slow network

`server/errors.js`. Two categories that differ in kind, not degree:

| | |
|---|---|
| **OPERATIONAL** | expected, transient, and continuing is correct. A timeout, a 5xx, a refused connection. |
| **PROGRAMMER** | the code is wrong. Continuing is **never** correct: the feature cannot work until someone changes it, and every retry is the same failure again. |

The mirror's handler was written for the first and silenced the second. It could
not tell them apart, so it treated a permanently broken feature as a hiccup, on
every departure write, for the life of the feature.

`rethrowIfProgrammerError(e)` inside a handler written for the world.
`fireAndForget(kind, promise, { record })` for a promise nobody awaits.

`ReferenceError`, `TypeError`, `SyntaxError`. **`RangeError` is deliberately
excluded** — `new Date(…)` throws it on bad *input*, and this application stores
dates as free text, so a `RangeError` is a bad row, not a build error. Written
down because an unexplained omission from a list like that reads as a mistake
and gets "fixed" later.

**The cost, stated plainly.** A programmer error in a fire-and-forget path is now
an unhandled rejection, which Node treats as fatal. A typo in an email template
takes the process down instead of being absorbed silently thirteen times a day.
Railway restarts and gives up after ten attempts, so the service fails loudly
rather than appearing to work while doing nothing. The alternative is what
produced the state we found: absorbing it, and discovering years later by
running the feature by hand.

---

## AAA1.2 — the thirteen call sites

They are gone, replaced by one `sendEmailInBackground()` in `server/email.js`,
where the contract lives next to the function it describes.

The intent behind `.catch(() => {})` was right — a booking must not fail because
a receipt did not send. The expression was not: it defended against a throw
**whose existence nobody had established**, while being the exact expression
that would have discarded it if it ever happened.

`server/email-contract.test.js` establishes it, and asserts the ordering that
matters: the programmer-error guard comes **first** in the catch, so a broken
template never writes a `failed` row to `email_log` or a failure count to
`/api/modes`. A build error must not be recorded as a mail outage.

---

## AAA1.1 — the check, and the check's own three defects

`scripts/check-catch-handlers.js`, wired into `preflight` and asserted again in
the unit suite.

> If the function does not throw by contract, the handler is redundant.
> If it can throw, the handler is a bug.

Its first run reported 28 hits, and **the check itself was wrong in three ways**,
all from one shortcut — stripping comments with `src.replace(/comment/g, "")`:

| | |
|---|---|
| **Wrong line numbers** | deleting a block comment deletes its newlines. It reported `src/main.jsx:2188`, which is a loading skeleton. The handler is at 2306. A check that points at the wrong line teaches the reader to distrust it, and a distrusted gate gets removed. |
| **Manufactured hits** | `catch { /* DB optional */ }` became `catch {  }`. Those turned out to be real findings — see AAA1.3 — but they were real **by accident**, and the check was reporting them for the wrong reason. |
| **No string handling** | the `EMBED_SCRIPT` template literal in `src/AgencyDashboard.jsx` ships widget source to third-party sites, and that source contains `catch(e){}`. Not this project's handler. |

Replaced with a position-preserving blanker: comments, strings, template
literals and regex literals become spaces, newlines kept, asserted by a
length invariant at run time.

A fourth defect appeared only at real size. The blanker re-derived its parser
state from the whole of the output on every `/`, which is quadratic, and it
**did not finish on `src/main.jsx`** — while passing every fixture test, because
a three-line fixture cannot show it. A gate that hangs is worse than one that
fails: it reads as a stuck machine, and the fix people reach for is to stop
running it. The repository scan is now bounded and asserted at 10s (it takes
~0.2s).

The scan also found one the line-based version could not see at all: a two-line
empty `catch` block in the `/llms-full.txt` live section — the block ZZ1 had to
fetch by hand to prove was working.

---

## AAA1.3 — a comment is not an observable effect

The rule the 28 hits forced into the open. `catch { /* DB optional */ }` is
banned on exactly the same argument as `catch {}`: it reads as a decision, and
it *is* one, but it is a decision taken at write time and **never reported at
run time**.

The clearest case is the sitemap. During a database outage that block drops
every tour and blog URL, and what comes out — the 23 static routes, HTTP 200,
well-formed — is indistinguishable from a correct sitemap. Production serves 38
URLs, so crawlers would watch well over a third of the catalogue disappear and
nothing in the process would have said a word.

What is still permitted is a handler that **substitutes a value and says why**:
`.catch(() => ({ ok: false }))`, or `catch (e) { if (e.code !== "ENOENT") throw e; current = ""; }`.
Those have an outcome the rest of the program can act on.

---

## AAA1.4 — three cases the sweep had not named

| | |
|---|---|
| **The rollbacks** | `provisionUser` deletes the auth user if the profile insert fails; `POST /api/admin/agencies` deletes the agency if owner provisioning fails. If the *rollback* also failed it was discarded — leaving an auth user no `app_users` row will ever match (they can sign in; the app cannot say who they are), or an ownerless agency. Both are recorded now. Both still throw the **original** cause: a rollback's own error must not replace the reason the operation failed. |
| **The login revoke** | disabling an account is two writes — our row, and the Supabase ban. Only one was allowed to fail out loud, so every admin screen would read `disabled` while the account could still sign in. A failure printing exactly what success prints, on the one path where that is a security question. `revokeLogin()` returns `revoked` / `failed` / `no-auth-provider` and the response carries it. Three states, because collapsing them is how `autoura: on` came to mean "working". |
| **The auditors** | `scripts/audit-claims.js` skipped its sitemap fetch in silence, which narrows coverage from the 38 URLs production serves to its 23 hard-coded routes — no tour page, no package, no blog post — and then prints a finding count and exits 0, reading exactly like an audit that looked at everything. It says so now. |

---

## AAA1.5 — the browser's one honest objection

Some browser failures are expected, unfixable **and continuous**: `postMessage`
to a parent frame runs on every resize; blocked storage throws on every attempt
for a whole session. Logging each occurrence buries the console, and a console
nobody can read is the argument the next person uses for deleting the logging.

`src/warn-once.js`. Said the first time and not again — still observably
different from never, which is the whole requirement.

---

## Still open

| | |
|---|---|
| The page warmer's three `console.warn` handlers | a warm failure is genuinely non-fatal and visible as a slow page. Guarded against programmer errors under AAA2, still not wired to `effect-log`; recorded here so the decision is a decision. |
| `effect-log` is per-process, in memory | a restart clears the counters. A durable store is the better answer and a bigger change; what this had to beat was `console.warn`. |
| `${…}` interpolation is blanked with its template | the checker cannot see a handler written inside a template expression. There are none in this repository. An unstated limit in a checker is how you get a green run that checked nothing, so it is stated. |
| The `if (x) /re/` case | the regex-vs-division heuristic reads `)` as a value. A regex literal immediately after a closing paren would be misread as division. No such line exists here. |
