# AA2 / AA3 — The cancellation promise

**9 August 2026.** Proposals. **Nothing changed.**

---

## AA2 — §14 does not apply, and my earlier report overstated the conflict

**§14 is titled "Changes requested by you"**, and opens: *"Ask us in writing **if
you wish** to change a traveler name, transfer a Booking, change the Departure…"*
It governs **traveller-initiated** changes. The US$50 is what a traveller pays to
move themselves.

**§15 is "Cancellation or material change by us or the Operating Partner"** —
Sawa-initiated, and carries no fee.

**The Terms do not conflict with each other.** Your reading was right and mine
was loose: I listed the $50 as one of "two contradictions" while noting it
governs traveller-initiated changes. That hedge was not enough — it does not
apply here at all and should not have been in the list.

### What the real conflict is, narrowed

| | `/how-it-works` | Terms §15 |
|---|---|---|
| Who chooses | "**your choice**", "**whichever you prefer**" | "we will **offer, as appropriate**" |
| Cost | "a **free** move" | "an equivalent or comparable alternative, **with any price difference clearly explained**" |

On fees the two agree — §15 charges nothing. On **price difference** they do not:
a move to a date that costs more is not free, and §15 anticipates exactly that.

And the third point stands, independent of the Terms: **the system offers no move
at all.** `cancellationEmail` sends a notice and a link to the departures board.

---

## AA3 — Proposed copy

### The client's decision first (AA3.1)

**Is the transfer a real offer with a person behind it, or a link to the board?**

Everything below follows from that answer, and the honest version of each is
different:

- **A person** — "we'll help you onto another date" is true, and
  `cancellationEmail` must stop being a bare notice.
- **A link** — the copy must say so plainly: "browse the other dates for this
  route".

Nothing should ship until this is answered, because both versions are writable
and only one is true.

### Surface 1 — `/how-it-works` (two places)

Current:

> "If a group doesn't form, you're refunded in full or moved to the next date —
> your choice."
> "You get a full refund or a free move to the next departure — whichever you
> prefer."

**Proposed — your wording, verbatim:**

> If your date doesn't reach its minimum, we'll tell you as soon as we know and
> help you onto another date. Nothing has been charged, so there's nothing to
> refund.

It is true today, it removes the refund question rather than answering it, and
"help you onto another date" is honest under a manual process in a way that
"your choice" and "free" are not.

### Surface 2 — `cancellationEmail`

Current body: the booking is cancelled · a "Find another departure" button · "If
you were charged anything for this booking, it is refunded in full."

**Proposed, matching the page:**

> This confirms your booking for {route} on {date} has been cancelled — it didn't
> reach the number of travellers it needed.
>
> Nothing was charged, so there's nothing to refund.
>
> [ See other dates for this route ]
>
> Reply to this email and we'll help you onto another date.

The conditional "if you were charged" was the right shape while payments were
undecided, but on a cancellation *for non-formation* nothing can have been
charged, so the plain statement is both true and stronger.

The CTA changes from the whole board to **this route's other dates**, which is
what a traveller who wanted that trip actually needs.

### Surface 3 — Terms §15: **no change proposed**

> "we will offer, as appropriate: an equivalent or comparable alternative, with
> any price difference clearly explained; credit, but only if you freely choose
> it; or a refund of amounts paid for services that will not be provided."

Accurate, appropriately hedged, and compatible with the proposed copy: "help you
onto another date" is what "offer an alternative" reads like to a traveller.

### Surface 4 — Terms §14: **no change proposed** (AA2)

Traveller-initiated changes. Untouched by this.

**So it is two surfaces, not four.** The Terms were already right — the third
time in this project that has been true.

---

## AA1.2 — Send-safety, proposed not built

The risk is narrow and specific: **the auto-cancel job is the only code path that
emails a traveller without a human action**, and email delivery is live.

Three options, weakest to strongest:

### 1. A suppression list — weakest
An allow/deny list checked in `sendEmail`. Rejected: it is one more thing that
must keep being right, and it fails open if a new address is added.

### 2. Dry-run mode for the job — recommended
`CANCEL_JOB_DRY_RUN=1` makes `runCancelUnconfirmed` log what it *would* cancel
and *would* send, and do neither. `runSafely` already logs per departure, and
`--dry-run` **already exists** in the job for manual runs — this only wires the
scheduler's tick to it.

Small, reversible, observable in `/api/modes` as `cancelJob: live|dry-run`, and
it leaves the job exercising its real query path so the logs are meaningful.

### 3. Scheduler off until the copy is settled — strongest
`DISABLE_JOB_SCHEDULER=1`. Nothing runs, nothing sends.

The cost is that departures past their deadline stay `open`, so the board shows
dates that should have closed — visible to travellers, and it accumulates.

### Recommendation

**Option 2 now, option 3 only if the seed lands before the copy is settled.**

Dry-run keeps the deadline logic exercised and gives a log of exactly which
departures *would* have been cancelled — which is also the best possible test of
the job against real seeded data, before it can act on it.

**Not built. It is a behaviour change to the one path that emails travellers
unprompted, and that decision is yours.**
