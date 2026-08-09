# X3.2 — The auto-cancel job versus what the site promises

**9 August 2026.**

## What the job is

`server/jobs/cancel-unconfirmed.js`, scheduled in-process by
`server/jobs/scheduler.js`.

| | |
|---|---|
| **Enabled when** | `NODE_ENV === "production"` **or** `ENABLE_JOB_SCHEDULER=1`, and not `DISABLE_JOB_SCHEDULER=1` |
| **Schedule** | first run 60s after boot, then every 24h. Timers `unref()`d |
| **Scope** | `SELECT * FROM departures WHERE status = 'open'` |
| **Cancels when** | seats taken < the departure's GoAhead number **and** now is past the confirm deadline |
| **Deadline** | 30 days before departure for packages, 7 days for day tours; a per-listing `confirm_deadline_days` overrides |
| **On cancel** | status set to cancelled in a transaction, then `cancellationEmail` to every traveller on the date. Email never blocks the cancellation |
| **Safeties** | an unparseable date is skipped rather than cancelled — "cancelling on it would destroy real inventory over a data error"; each departure is re-read and re-checked inside its own transaction, so a double run cancels nothing extra |

**Resolved state in production: UNVERIFIED.** `/api/modes` reports it but is not
yet deployed. The rule says it is **on** if `NODE_ENV=production`, which is
Railway's default — but that is an inference from a representation, which is
exactly what this project keeps getting wrong. One request answers it after
deploy.

---

## Copy that the job supports

| Claim | Verdict |
|---|---|
| "30 days before departure on a multi-day package, 7 days on a day tour" (`/goahead-promise`) | ✅ matches the defaults exactly |
| "the date is cancelled automatically" | ✅ **if the scheduler is on** — unverified |
| "you're emailed" | ✅ `cancellationEmail` to every traveller, and delivery has been live since 6 Aug |
| "You're never charged for a trip that doesn't run" | ✅ trivially — nothing is ever charged |

## 🔴 Copy the job does not support

### "a free move to the next departure — whichever you prefer"

`/how-it-works`, twice:

> "If a group doesn't form, you're refunded in full **or moved to the next date —
> your choice**."
> "You get a full refund or **a free move to the next departure — whichever you
> prefer**."

**The Terms say something different.** §15:

> "we will **offer, as appropriate**: an equivalent or comparable alternative,
> **with any price difference clearly explained**; credit, but only if you freely
> choose it; or a refund…"

Two contradictions:

1. **Who chooses.** Marketing: "your choice", "whichever you prefer". Terms:
   "we will offer, as appropriate."
2. **Cost.** Marketing: a **free** move. Terms: "any price difference clearly
   explained" — and §14 charges **US$50 per person** to transfer a booking to
   another departure, though that governs traveller-initiated changes rather
   than a Sawa cancellation.

**And the system offers neither.** `cancellationEmail` says the booking is
cancelled, links to the departures board, and adds "if you were charged
anything… it is refunded in full". There is **no move, no credit, no alternative
offered, and no choice presented**. A traveller is told to go and find another
date themselves.

So a traveller reading `/how-it-works` expects to be offered a transfer at no
cost and to pick. What arrives is a cancellation notice and a link.

This is V1's class — copy describing a process that does not occur — and it
follows V6: the Terms are nearer the build. **Not changed; it needs your
decision.**

### The refund half is vacuous

"refunded in full" appears in all of this copy. Nothing is ever charged, so
there is nothing to refund — already reported under U3, unchanged here.

---

## The decision this forces

Either the site stops promising a free traveller-chosen transfer, or the product
starts offering one. Both are real options and the choice is not mine:

- **Copy changes** — bring `/how-it-works` in line with Terms §15: Sawa offers an
  alternative where appropriate, with any price difference explained.
- **Product changes** — the cancellation flow offers a transfer, and §14/§15 are
  rewritten to match.

This is the fifth item blocked on you, and it is the one that binds the GoAhead
promise: what happens to a date that never fills is the other half of the
proposition.
