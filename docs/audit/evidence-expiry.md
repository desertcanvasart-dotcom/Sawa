# Evidence expiry register

**Created 10 August 2026 (DDD1).**

Every finding of the form **"this never happened, because nothing does X"** is
an argument from absence. It is often the strongest evidence available — and it
stops being true the moment X exists, silently, with nothing to announce it.

The failure this prevents: **a proof cited later as though still valid, by
someone who was not present when the premise was true.** It already nearly
happened. The BBB1 proof — "no login was ever revoked while the session stayed
live" — rested on *nothing in this repository lifts a ban*. The very next commit
made that false. Left unrecorded, E-1 would have been quoted in three months as
a standing fact.

Same shape as the latent-defect register's *what change would arm it*, applied
to a proof rather than a defect. The two are siblings; see
[latent defects](latent-defects.md) when DIR-3 writes it.

---

## Two kinds of statement, and they must not be quoted alike — OOO4

| | |
|---|---|
| **NEVER** | true for all time so far. `pledges` has never held a row ([E-2](#e-2--no-traveller-has-ever-been-carried)). |
| **SNAPSHOT** | true at a stated moment. `departures` held 0 rows on 10 Aug 2026 — but 95 inserts and 65 deletes sit behind that zero ([E-11](#e-11--no-listed-product-has-an-operating-company-attached)). |

A never supports an argument about history. **A snapshot supports an argument
about today and nothing else.** Quoting them the same way lets the weaker claim
inherit the stronger one's authority, which is the precise failure this register
exists to prevent — one level down from an expired proof.

Every entry states which it is in **Rests on**.

---

## The rule

Each entry records, without exception:

| | |
|---|---|
| **Status** | `LIVE`, or `EXPIRED <date> (<what expired it>)` |
| **The claim** | stated as it would be quoted |
| **Rests on** | the absence the argument depends on |
| **What would arm it** | what must become true for the argument to stop holding |
| **Where that is defined** | the file, line or document that would change |

An entry missing any of those is not an entry. `server/evidence-expiry.test.js`
asserts the shape, and re-checks the conditions that are repository facts — so
the ones that can be armed by a commit fail the gate rather than going quiet.

---

### E-1 — No account was ever revoked while its login stayed live

| | |
|---|---|
| **Status** | **EXPIRED 2026-08-10** — #88 (`4208d46`) |
| **The claim** | BBB1: nobody was ever shown as `disabled` in `app_users` while their Supabase session kept working. |
| **Rests on** | `banned_until IS NULL` on every row of `auth.users`, **and** nothing in the repository ever lifting a ban — so NULL could only mean *never banned*, not *banned and released*. |
| **What would arm it** | Any code path that clears a ban. |
| **Where that is defined** | `server/app.js` — `setLoginAccess(id, allowed)` now issues `ban_duration: allowed ? "none" : "876000h"`. The `"none"` branch is what expired it. |

**Still true for everything before 2026-08-10.** From that date the audit trail
answers the question instead, which is what DIR-1 was for. Anyone citing E-1
must date the citation.

---

### E-2 — No traveller has ever been carried

| | |
|---|---|
| **Status** | **LIVE** — and the most load-bearing sentence in the project |
| **The claim** | `pledges` has never held a row. |
| **Rests on** | the table being empty since creation. |
| **What would arm it** | **One row.** DIR-16, the staged seed. |
| **Where that is defined** | `docs/audit/open-directives.md` → DIR-16 |

More depends on this one sentence than on any other in the repository:

- **Legal register Q3** (rating display) — "no reviews table exists; `pledges`
  has never held a row"
- **`scripts/audit-claims.js:54`** — the `volume` rule's stated premise is
  *"pledges has never held a row; no traveller has been carried"*. The auditor's
  own calibration expires with it.
- **`docs/audit/cancel-job-rehearsal.md`** — the rehearsal was run against an
  ephemeral database specifically so this sentence would survive
- **EEE3** — "no traveller personal data was exposed" during the Data API
  window is true *because of this*, not because of any control

When the seed happens, all four need revisiting in the same commit. That is why
EEE4 put migration 024 ahead of the seed: the sentence that protects the
exposure scope is the sentence the seed ends.

---

### E-3 — The Autoura mirror has never transmitted anything

| | |
|---|---|
| **Status** | **LIVE**, and deliberately scheduled to expire |
| **The claim** | No inventory has ever crossed the boundary to Autoura. |
| **Rests on** | `emitDepartureSync` calling `loadEnriched`, which never existed, so every emit failed before sending — plus `effect-log`'s `neverWorked` confirming zero successes. |
| **What would arm it** | The first successful emit. |
| **Where that is defined** | `server/autoura-sync.js`; effect kind `autouraSync` in `/api/modes` |

**Legal register Q4 already turns on this.** ZZ3 restated the question from
retrospective (*"has an undisclosed transfer been occurring?"* — it has not) to
prospective (*"this transfer is about to begin"*) precisely because the answer
was about to change. The privacy paragraph must publish **before** the four sync
paths go live, or the claim expires while the disclosure is still in draft.

---

### E-4 — The only Data API requests on record are this investigation's own

| | |
|---|---|
| **Status** | **LIVE**, and the most fragile entry here |
| **The claim** | EEE1: in the retained window, `anon` executed exactly seven PostgREST statements, one call each, and all seven were the probes issued on 2026-08-10. |
| **Rests on** | `pg_stat_statements` having neither reset nor evicted — window opens 2026-05-31 14:37 UTC, ~1,300 statements tracked against a default cap of 5,000. |
| **What would arm it** | **A database restart resets it. Reaching the statement cap evicts.** Neither is announced, and both destroy the evidence rather than changing the fact. |
| **Where that is defined** | `pg_stat_statements_info.stats_reset`; `docs/audit/data-api-exposure.md` |

Two limits that were never covered and never will be by this source: **anything
before 2026-05-31**, and **attribution** — Postgres records no IP, origin or
user-agent. Supabase's dashboard API logs are the only source for both, and
they have their own retention clock. **This entry argues for pulling them now
rather than later.**

---

### E-5 — No `service_role` key is public

| | |
|---|---|
| **Status** | **LIVE**, point-in-time |
| **The claim** | EEE2: the only key-shaped string on any public surface is the anon key, which is public by design. |
| **Rests on** | a scan on 2026-08-10 of 354 tracked files, 1,371 history blobs, the entry bundle, three lazy chunks, every `site/assets` file, and the ai/robots/sitemap files. |
| **What would arm it** | **Any commit or deploy.** Specifically: any secret given a `VITE_` prefix, which Vite inlines into the bundle by design and without warning. Also publishing source maps, which are currently all 404. |
| **Where that is defined** | `.env` / Railway variables; `vite.config.js` |

A key committed once and removed later is still public, which is why the scan
covered history and not only the working tree. **Re-running the scan is cheap
and it is the only thing that renews this entry.**

---

### E-6 — No empty handler lives inside a template expression

| | |
|---|---|
| **Status** | **LIVE** |
| **The claim** | `scripts/check-catch-handlers.js` blanks the interior of `${…}` along with its template, so it cannot see a handler written there. There are none. |
| **Rests on** | reading the repository, not on any check. |
| **What would arm it** | Writing one. **Nothing would detect it** — that is the whole point of recording the limit. |
| **Where that is defined** | `scripts/check-catch-handlers.js` — the `blankNonCode` comment |

Re-checked mechanically by `server/evidence-expiry.test.js`, which scans
template-literal spans directly. This entry is armed the moment that test fails.

---

### E-7 — No regex literal immediately follows a closing parenthesis

| | |
|---|---|
| **Status** | **LIVE** |
| **The claim** | The blanker's regex-vs-division heuristic reads `)` as a value, so `if (x) /re/.test(y)` would be misread as division and blanked to end of line — hiding any real violation on that line. No such line exists. |
| **Rests on** | reading the repository. |
| **What would arm it** | One line of that shape, anywhere under `server/`, `src/`, `scripts/` or `shared/`. |
| **Where that is defined** | `scripts/check-catch-handlers.js` — `opensRegex` |

---

### E-8 — The read-only auditor connection cannot write

| | |
|---|---|
| **Status** | **LIVE**, defeatable |
| **The claim** | X1: the audit tooling holds a connection on which a write raises `25006`. |
| **Rests on** | `default_transaction_read_only=on` being set per session **and nothing issuing a runtime `SET` to turn it off**. |
| **What would arm it** | One `SET default_transaction_read_only = off`. The module's own header says so. |
| **Where that is defined** | `server/db/readonly.js`; closed properly only by the read-only role — client item 7 |

---

### E-9 — `audit_log` has never been altered

| | |
|---|---|
| **Status** | **LIVE**, and strengthening rather than expiring |
| **The claim** | 63 inserts, 0 updates, 0 deletes since 2026-05-22, against 63 rows held. |
| **Rests on** | `pg_stat_user_tables` counters, which a stats reset would clear. |
| **What would arm it** | A stats reset destroys the **evidence**, not the property. Migration 024's append-only triggers make the property **structural**, so from the day 024 is applied this stops being an argument from absence and becomes an enforced invariant. |
| **Where that is defined** | `server/db/schema_024_lock_down_data_api.sql` |

The one entry here that gets *better* with time. Recorded because the reasoning
is worth copying: the fix for an expiring proof is usually to make the thing it
proves impossible instead.

---

### E-10 — Migration 023 was safe on the data as it stood

| | |
|---|---|
| **Status** | **EXPIRED 2026-08-10** by application — superseded, retained as the pattern |
| **The claim** | 023's `blog_posts_status_chk` could be added without failing, because production held one row with status `published`. |
| **Rests on** | a count taken immediately before writing the migration. |
| **What would arm it** | Any row with another status, written between the check and the run. |
| **Where that is defined** | `server/db/schema_023_write_time_capture.sql` |

Applied 2026-08-10 10:34 UTC, so the observation is now a constraint. **Retained
because every future migration makes a claim of this shape**, and each one has a
window between the check and the run in which it can quietly stop being true.

---

### E-11 — No listed product has an operating company attached

| | |
|---|---|
| **Status** | **LIVE** |
| **The claim** | MMM1: `agencies` holds one row ("adham", no phone), no approved product is linked to any agency, and no product page names an operating company. |
| **Rests on** | **SNAPSHOT** — a reading of production on **10 August 2026**, plus all 16 rendered product pages. It moved from 14 to 16 products within an hour of being taken. |
| **What would arm it** | **The first signed operator.** One `agencies` row with a real company, or one product with `agency_id` set, ends it — and at that point the site's eleven "Ministry-licensed operators" claims start being backed by a record instead of an arrangement held outside the system. |
| **Where that is defined** | `docs/audit/operator-records.md`; `agencies`; `tour_products.agency_id` |

Also expires the narrower reading in the same document: `departures` held **0
rows** at the reading. It has held rows before (95 inserts, 65 deletes since
2026-05-22), so this one is a snapshot rather than a never — **unlike
[E-2](#e-2--no-traveller-has-ever-been-carried), which is a never.** The two
must not be quoted as though they were the same kind of statement.

---

### E-12 — "No drift reported" means the site has not drifted

| | |
|---|---|
| **Status** | **LIVE**, and conditional in a way the others are not |
| **The claim** | The scheduled claims audit reported nothing, therefore production has not drifted from the baseline. |
| **Rests on** | **SNAPSHOT + a running monitor.** The watcher writes an `audit.watch` row on every run; silence means either "nothing changed" or "the watcher did not run", and only one of those is good. |
| **What would arm it** | The web process being gone. A monitor running inside the process it monitors **cannot report that the process is gone** — nothing fires and nothing says so. Railway's healthcheck covers uptime, which is why the gap is accepted rather than closed. |
| **Where that is defined** | `server/watchdog.js`; `/api/modes` → `watchdog.stale` |

Mitigated, not eliminated: staleness beyond 48 hours is itself a finding and is
reported by `/api/modes`, so the silence has a stated shelf life. **48 rather
than 24 deliberately** — a 24-hour threshold fires on every ordinary deploy that
lands near the tick, and a signal that fires when nothing is wrong stops being a
signal (TTT1).

---

## What this register does not do

It does not make any of these arguments stronger. An argument from absence is
still an argument from absence — recording its expiry condition only means the
day it stops holding is a day someone notices.
