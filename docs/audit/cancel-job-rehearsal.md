# JJ2 — Rehearsing the auto-cancel job before real data exists

**9 August 2026.**

BB3 shipped the scheduled tick as dry by default, and the report closed with an
admission: the dry path had never been observed **refraining on a candidate**.
`departures` is empty, so every tick production has ever run found nothing. The
branch that matters had never been entered. It had been verified by reading the
function, which this project does not accept as evidence.

The plan was to confirm it at step 3 of the staged seed. That was the wrong
place. **A safety mechanism verified against real customers' bookings is
verified in the one place where failing is expensive** — if it fails there, it
fails on a person. And while both tables are empty there is no possibility of
confusing a synthetic row with a real one; once the seed lands, that ambiguity
is permanent.

So it was brought forward.

---

## Where it was run, and why not against production

**Run against an ephemeral local Postgres 17 cluster, destroyed afterwards.**
Not against the production database.

The brief allowed for this: *"If any step cannot be done safely against
production, say so and propose an alternative."* Three reasons, in order of
weight.

### 1. The live email leg is not executable from here at all

The rehearsal's step 3 wanted a real delivery through Resend. `RESEND_API_KEY`
exists only in the Railway environment. Locally `emailMode` resolves to `log`.

**Pointing at the production database would not have changed that** — the key is
read from the environment, not the database. Production access buys nothing for
the one step that needed it, and costs everything below.

### 2. Synthetic rows in production would have been publicly visible

`/api/state` serves every departure matching the public scope. A synthetic
departure with `status = 'open'` would have been in that payload, on the live
boards, for the duration of the rehearsal — and the page cache and the warmer
could have held a rendered copy of it past the purge.

*Not* a risk, checked and ruled out: the Autoura mirror. Every `emitDepartureSync`
call site is an API route handler in `app.js`. Neither a raw insert nor the job's
own `UPDATE` triggers it, so nothing synthetic would have crossed that boundary.

### 3. It would have destroyed the cleanest evidence this project has

*"`pledges` has never held a row"* is load-bearing. The legal register cites it
under the ratings question; the seed-precondition document opens with it. Writing
a synthetic pledge to production ends that sentence permanently — sequences
advance, `audit_log` records an auto-cancel for a departure that never existed,
and every future reader has to be told which rows to disbelieve.

The brief's own reasoning supports this: doing it now avoids the ambiguity **by
timing**. Doing it in a separate database avoids it **completely**.

### The schema is not a stand-in — it is the same schema

`schema.sql` plus all 21 numbered migrations were applied to the ephemeral
cluster, and its columns were diffed against production:

```
116 columns across departures, pledges, tour_products, agencies,
cities, email_log, audit_log
diff (rehearsal vs production): SCHEMAS IDENTICAL
```

The job code is unmodified and the domain rules are the same functions. The only
difference between this run and a production run is which host answers the
queries.

---

## The candidate

One departure, one pledge, both marked so no reader could mistake them:

```
departure 999001  "REHEARSAL-JJ2 — synthetic departure, DO NOT SHIP"
                  start 2026-08-12, status open, 1 of 4 seats
pledge            "REHEARSAL-JJ2-PLEDGE", 1 seat, hello@sawa.tours
```

The address is the brand's own mailbox. No traveller address, real or plausible,
was used at any point.

---

## Step 2 — dry, with something to act on

**This is the assertion that had never been observed.**

```
1 departure(s) past their GoAhead deadline (dry run)
  #999001 2026-08-12 — 1/4 seats — REHEARSAL-JJ2 — synthetic departure, DO NOT SHIP  [would cancel]
```

State immediately after:

| | |
|---|---|
| departure 999001 | still `open` |
| pledge | still `confirmed` |
| `audit_log` | **empty** — `cancelOne()` was never reached |
| `email_log` | **empty** — `sendEmail()` was never reached |

**Not vacuous.** The candidate count is 1, and the job named the departure it
would have cancelled. It found the thing, described it, and touched neither the
database nor the mail path.

---

## Step 3 — live, on the same candidate

```
1 departure(s) past their GoAhead deadline
[email:log] to=hello@sawa.tours | Cancellation — REHEARSAL-JJ2 — synthetic departure, DO NOT SHIP
  #999001 ...  [cancelled, 1 traveller(s) emailed]
cancelled 1, emails sent 1
```

| | |
|---|---|
| departure 999001 | `cancelled` |
| `audit_log` | `departure.auto_cancel` by `system@sawa.tours` |
| `email_log` | one `cancellation` row to `hello@sawa.tours`, status **`logged`** |

`sendEmail()` was reached and carried the right recipient and subject. **Resend
delivery was not verified** — see the gap below.

A second dry tick afterwards reported `0 departure(s)`, confirming the terminal
state holds and a re-run cannot re-cancel or re-email.

---

## Step 4 — purge

```
departures: (none)   pledges: (none)
agencies: 0   cities: 0   tour_products: 0
```

`audit_log` and `email_log` rows were left in place deliberately — they are the
evidence, and the cluster was destroyed afterwards. `email_log` holds exactly one
row: one cancellation, to the internal address, and nothing else.

---

## ❌ What is still NOT verified

**That Resend accepts and delivers a cancellation email.**

`email_log` in production tells the story: of 27 rows, **exactly one has status
`sent`** — a `departure_request_received` on 5 August 22:01 UTC, the self-test.
Every other row is `logged`, from before delivery was live. The single
`cancellation` row, from 7 June, is `logged`.

**No cancellation email has ever left the system.** This rehearsal proved the
job reaches the send with the right arguments; it did not prove the send lands.

That gap needs the production environment, and the cheapest way to close it is
not a database at all: one `cancellationEmail(...)` passed to `sendEmail(...)`
from a Railway shell, addressed to the internal mailbox. It needs no synthetic
departure and touches no table but `email_log`. **Recommended before the seed,
not after.**

---

## 🔴 Finding — the pledge stays `confirmed` after its departure is cancelled

Observed, not inferred. After the live run:

```
departure 999001            status: cancelled
REHEARSAL-JJ2-PLEDGE        status: confirmed
```

`cancelOne()` updates `departures.status` and writes the audit row. It never
touches `pledges`. The only `UPDATE pledges SET status` in the codebase is
`app.js:1913`, an admin action.

So the traveller receives *"your booking has been cancelled"* while the row
recording their booking still reads `confirmed`. This is the shape of defect the
project exists to catch — **the message and the record disagree** — and it is
invisible today only because no pledge has ever existed.

Not fixed here: it is a write to the booking path, which is out of scope without
an instruction. Filed for a decision.

---

## Reproducing

```bash
npm run rehearse:cancel-job
```

The script refuses to run against any `DATABASE_URL` but the ephemeral rehearsal
cluster. It is not capable of writing to production.
