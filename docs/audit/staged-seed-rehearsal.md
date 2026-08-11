# DIR-16 — the staged seed, rehearsed before it happens

**11 August 2026.** `npm run rehearse:staged-seed` — an ephemeral cluster on
127.0.0.1:55433, the real schema and all 30 migrations, destroyed on exit.
Same argument as [cancel-job-rehearsal.md](cancel-job-rehearsal.md): the first
time the staged load runs must not be the first time anyone watches it.

## The input, and what it is not

The client's booking sheet arrived 11 August: 11 bookings across 10 live
products. Validation flagged **9 of 11 phone numbers as sitting in officially
reserved fictional ranges** (US 555-01xx, UK 07700 900xxx, DE 030-23125xxx,
FR/ES placeholder patterns), and the client confirmed the same day: **test
data, rehearsal only.**

So `data/bookings-rehearsal.json` is a rehearsal fixture, not the seed. It is
**untracked** — fabricated names, but gmail addresses that could belong to real
strangers — and the driver refuses to run without it rather than passing over
nothing (EEEE1). **E-2 is still LIVE. The real booking CSV is still awaited**,
and when it arrives it gets the same validation before anything else.

Two semantics questions the sheet raised, resolved by the client 11 August:
`amount_agreed` is the agreed **per-person tour price**, stored as whole
dollars (the money columns are INTEGER); and `paid (yes/no)` had no column at
all — migration **030** adds `pledges.paid`, threaded through `insertPledge`,
`seed.js` and `mapPledge`.

## What was observed

The load ran in the order [seed-preconditions.md](seed-preconditions.md)
prescribes, each phase judged by exit code, not by reading output:

| phase | observed |
|---|---|
| **Stage 1** — one departure, chosen below minimum | `open` at 1/4 seats — the forming-below-minimum state, rendered nowhere before this, held by a real row. No GoAhead. `email_log` 0. |
| **Remainder** — the other ten | 7 forming (`open`), 4 at exactly minimum → `minimum_reached`, all computed by `refreshStatus` inside the insert transaction — never by the rehearsal script. |
| **GoAhead** | `departure.goahead` audit rows for **exactly** the four at-minimum departures, written in the same transaction as the status change (DIR-20.1). |
| **`check:seed-expiry`** | went **red on the first pledge row** — `ENDED`, naming all four E-2 claims. EEEE3.1 now proven to fire on data, not only in its unit tests. |
| **paid** | $1,870 received / $945 outstanding across 11 bookings — the 030 column carrying real values through the whole path. |

## What this does not prove

- Nothing about **production**: RLS under the real roles, the real catalogue
  ids, and the Supabase side were not exercised.
- The **P3.3 renders** were not observed — no web server ran against the
  rehearsal cluster. The staged load's step 3 (boards showing a real forming
  count, no bare zero) remains unobserved and is still a gate before the real
  remainder loads.
- The four E-2 restatements were **not** applied — the claims still stand, and
  must, because `pledges` in production still holds no rows.

## Standing between here and the real seed

| | |
|---|---|
| the real booking CSV | awaited from the client |
| password rotation | **still unconfirmed** — the connection string pasted into chat 10 Aug remains treated as compromised until the client says it was rotated |
| CTS founding-partner insert | **client stated 11 Aug 2026 that it has been run.** Recorded as a claim per EEEE1.4 — verify with one `SELECT` from a credentialed session before anything asserts it |
| migration 030 | applied here, **not** applied to production. Apply before deploying the code that writes `paid`, or the first public booking after deploy 500s (B5: migrations do not run on deploy) |
