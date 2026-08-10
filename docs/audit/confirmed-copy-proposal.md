# BBBB5 — copy for "confirmed means confirmed"

**Proposal, 10 August 2026. Nothing applied.**

Every string below was run through `audit-claims`' own rules before being
written down — `guarantee`, `absolute-claim`, `universal-threshold`, and the
rest. **All clean.** That check is not decoration: this is the most likely place
in the whole project for a removed claim to come back in new clothes, because
the sentiment is the same as the P1.5 guarantee and only the scoping makes it
defensible.

---

> ## ⛔ SUPERSEDED BY CCCC1 — the hedge below is withdrawn
>
> The finding stands; **the remedy does not.** *"Usually four"* solves a data
> problem with words. The site already says *"four"* flatly in eight places, so
> the hedge would have introduced vagueness, not avoided a claim.
>
> Four is to be made true **by rule** — held on CCCC2, with migration 027
> prepared and verified. See `docs/audit/group-size-decision.md`. **Wherever this
> document says "its minimum travellers — usually four", read "four".**
>
> **SHIPPED 10 Aug 2026** with BBBB6, as one change. CCCC2 was answered *no*, so
> the copy says **four**, plainly — the hedge was never applied.

## ⚠️ One thing the rules did not catch, and I think it matters

**"Four to confirm" is a universal claim about a per-product number.**

`tour_products.min_seats` is per listing, `CHECK (min_seats >= 1)`, default 4.
`goAheadSeatsFor` reads it from the departure. Checked against production: **all
16 approved products currently use 4** — so the sentence is true today, and true
by coincidence of data rather than by design.

The project has already decided this question once. The `universal-threshold`
rule exists with the stated reason *"the threshold is per product; only the
ceiling is universal"*, and its `ok` predicate accepts *"its minimum
travellers"*. The live FAQ says **"usually four"** for the same reason.

So the client's phrasing is recorded, and the wording below **names the rule and
lets the number follow it.** If you would rather say "four" plainly, that is a
defensible product decision — but it should be taken knowingly, and the day an
operator sets a minimum of six it becomes false on every page at once.

*(Recorded as **L-10** in the latent-defect register.)*

---

## The promise — BBBB1.1

> **Once your date is confirmed, we don't cancel it for low numbers. If someone
> drops out, your trip still runs.**

Checkable, true, and it answers the actual anxiety: that a half-full group
quietly gets pulled.

## The distinction — BBBB1.3

> **A date confirms at its minimum travellers — usually four. Once confirmed, it
> runs.**

Both events stated, or a reader assumes a group of three was never valid.

---

## Per surface

### Departure page — on a confirmed date

> **Confirmed — this date is running.** We don't cancel a confirmed date for low
> numbers.

The second sentence only appears once a date is confirmed. On a forming date it
would be answering a question nobody has yet asked.

### `/how-it-works` — after the GoAhead step

> Reaching the minimum is what locks the date. After that we don't cancel it for
> low numbers — if someone drops out, your trip still runs.

### `/goahead-promise`

> **Confirmed means confirmed.** Reaching its minimum travellers is what confirms
> a date. From that moment we don't cancel it for low numbers: if someone drops
> out afterwards, your trip still runs.

### `/faq` — extend the existing GoAhead answer

Append to *"What is the GoAhead?"*:

> From then on it runs — we don't cancel a confirmed date for low numbers.

And a new question, because this is the thing a traveller will actually wonder:

> **What if someone drops out after my date is confirmed?**
>
> Your trip still runs. Reaching the minimum is what confirms a date, not a level
> it has to stay at — we don't cancel a confirmed departure for low numbers.

---

## What is deliberately absent

**The rare cases.** Force majeure, operator failure and safety belong in the
Terms under cancellation cause 2, per BBBB1.2 — not in the promise.

The scoping does the work: *"we don't cancel it for low numbers"* does not say
*"we never cancel"*, so no sentence here needs a caveat to stay honest. **Adding
one would weaken the promise without making it more true**, and a promise
hedged in its own paragraph reads as a promise nobody means.

**The client's "no matter what".** Not written anywhere. If a site closes or a
vehicle fails, the trip does not run — that is the exact shape of *"100%
guaranteed to run"*, removed under P1.5 for promising something outside Sawa's
control.

---

## Before this ships

The copy is only true because BBBB4 is fixed. Until that PR is in, the unattended
job can still cancel a confirmed departure — and this wording would be a promise
the system actively breaks. **Order: BBBB4 first, then this.**
