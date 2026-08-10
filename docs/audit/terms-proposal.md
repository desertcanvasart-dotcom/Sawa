# The Terms — DIR-22 and BBBB6

**Proposal, 10 August 2026. Nothing applied.** `site/terms.html` is unchanged.

> **HELD (CCCC3)** pending CCCC2 — whether any product may ever require more than
> four to run. That decides how §8's and §15.1's central number reads, and this
> ships with BBBB5 or not at all.

Two separate pieces of work land in the same document, and **only one of them
may proceed.**

| | |
|---|---|
| **BBBB6** — cancellation causes, and confirming vs running | **ready to propose** |
| **DIR-22** — agency structure in §2 | **held pending DIR-21**, see the last section |

---

# BBBB6

## Finding 1 — the Terms already make BBBB1.1's promise, and until BBBB4 the code broke it

**§8, final paragraph, live today:**

> Once a Departure reaches GoAhead it will not be canceled merely because another
> traveler later cancels and the group falls below the Confirmation Minimum.

That is BBBB1.1, already written, already published. **The copy work is not
adding a promise — it is bringing the site into line with a promise the Terms
have been making on their own.**

Beside it in the source sits this comment:

> *The promise below is a commercial choice, not something the code enforces:
> **nothing re-opens or cancels a date once it has passed its minimum.** Stated
> plainly here so travelers can rely on it.*

**The second half was false.** BBBB4 found that `refreshStatus` recomputed status
from live seat counts — so a confirmed date demoted itself when a traveller
cancelled — and the unattended job then read that demoted row and cancelled the
date outright. The exact thing §8 promises would not happen.

So: the Terms invited travellers to rely on an invariant, a comment beside the
promise asserted the code did not need to enforce it, and the code actively broke
it. **A comment is not a mechanism.** BBBB4's two ratchets are the mechanism;
this proposal must not merge before them.

## Finding 2 — §15 names six causes in one sentence, and one is a catch-all that swallows §8

**§15, first paragraph, live today:**

> We or the Operating Partner may cancel or materially change a Departure where
> necessary because of safety concerns, insufficient participation **before
> GoAhead**, supplier failure, government action, force majeure or **another
> legitimate operational reason**.

*"Insufficient participation before GoAhead"* is **correctly scoped** — those
three words are what keeps §15 consistent with §8, and they are easy to miss in a
list of six.

*"Another legitimate operational reason"* is scoped by nothing. A date cancelled
because four of six travellers dropped out could be described, in good faith, as
an operational reason — and a reader who reaches §15 cannot tell which clause
governs. **The promise and its exception are 140 lines apart, and the exception
is open-ended.**

## Finding 3 — the Terms distinguish six causes; the system records none

`departures` has **no cause column at all** — `cancelDepartureAndPledges` writes
`status = 'cancelled'` and nothing else. `pledges.cancelled_reason` exists with
five permitted values, and is **deliberately unwritten** (023: adding a column
and adding the code that fills it are separate changes).

The only surviving trace of *why* is the audit-log action name — `departure.cancel`
from the admin route, versus the scheduler log for the job.

**Not folded into this proposal.** Recording the cause is a code change, and this
is a Terms change; shipping them together means reviewing two things as one. It
is stated here because a Terms section that turns on which of three causes
applied should eventually be answerable from the record.

---

## The proposal

### §8 — add the confirm-versus-run distinction

Immediately after the existing promise:

> Reaching GoAhead **confirms** the Departure. Confirming a Departure and running
> it are different things: section 15.2 sets out the limited circumstances in
> which a confirmed Departure can still be cancelled, **none of which are about
> the number of travelers.**

This is BBBB1.3 in the Terms' own register. Without it, a traveller who reads §8
and then §16 has no way to reconcile them.

### §15 — three causes, separated

> **15. Cancellation by us or the Operating Partner**
>
> A Departure can be cancelled for three reasons. They are not the same, and
> which one applies decides what happens next.
>
> **15.1 Before confirmation — not enough travelers.**
> A Forming Departure that has not reached its Confirmation Minimum by its
> Confirmation Deadline closes automatically (section 9). You owe nothing,
> nothing is charged, and no Tour Price is captured. **This is the only cause
> that is about numbers, and it can only happen before GoAhead.**
>
> **15.2 After confirmation — something outside our control.**
> Once a Departure is confirmed we do not cancel it because the group falls below
> the Confirmation Minimum (section 8). That remains true if a traveler cancels
> afterwards.
>
> A confirmed Departure is cancelled only where it cannot responsibly be run:
>
> - force majeure or an unavoidable event, as defined in section 16;
> - **failure by the Operating Partner**, or by a supplier essential to the
>   itinerary, to provide the confirmed services;
> - a safety concern affecting the Departure; or
> - government action, restriction or direction.
>
> If we cancel a confirmed Departure for a reason that is not attributable to
> you, we will offer, as appropriate: an equivalent or comparable alternative,
> with any price difference clearly explained; credit, but only if you freely
> choose it; or a refund of amounts paid for services that will not be provided.
>
> **15.3 Cancellation by you.** Section 13.
>
> *(Material change: the existing paragraph, unchanged, moves under 15.2.)*

### The catch-all — bound it rather than delete it

Removing a residual clause entirely is a decision for a lawyer, not for me. But
**unbounded is the one thing it must not be**, because unbounded reads onto §8.

If a residual is needed:

> — or another reason that makes it impossible or unsafe to run the Departure as
> confirmed.

That cannot be read to include low numbers, which is the whole point.

### Cross-reference §16, do not restate it

15.2 names force majeure and **points at §16 for its definition**. §16's list —
weather, disaster, epidemic, war, unrest, government restriction, border closure,
transport disruption, industrial action, utility failure, site closure — is
already thorough. Two lists of the same thing in one document is the duplication
problem in legal clothing: they drift, and a reader finds both.

---

## Checked against the claims rules

Every proposed clause was run through `scan()` from `scripts/audit-claims.js` —
the same `guarantee`, `absolute-claim` and `universal-threshold` rules BBBB5 was
checked against. **All clean.**

`site/terms.html` is a scanned page, so this is not a courtesy: a clause added
here fails the gate exactly as a marketing line would.

---

## Order

1. **BBBB4** — the ratchets. Until they are in, §8 is a promise the code breaks.
2. **BBBB5** — the customer-facing copy.
3. **This.**

BBBB5 and this proposal say the same thing in two registers. **They should be
approved together or not at all**, or the site and the Terms will describe
different products.

---

# DIR-22 — held, and why drafting it would resolve DIR-21 by accident

**§2, live today:**

> Sawa provides a platform that brings travelers together on shared departures and
> coordinates reservations, confirmation, communication and payment. Tours are
> delivered on the ground by licensed Egyptian tour operators approved by Sawa.

That is **the agency reading**, stated as fact.

DIR-21 verified that the code implements both readings at once, and that current
practice is the principal reading: **all 16 approved products have
`agency_id IS NULL`** — every live listing was created platform-side, and every
price now on the site is one Sawa entered.

So §2 currently describes an arrangement that the live data does not match.
**Rewriting it — in either direction — answers DIR-21 by drafting**, which 21.2
explicitly forbids: *"do not resolve it by choosing."*

**§15's remedies are left exactly as they are today** for the same reason. What
Sawa owes a traveller when a confirmed trip is cancelled depends on whether Sawa
is the organiser or the agent, and the answer may change them. BBBB6 restructures
**which cause applies**; it does not move the principal/agent line, and it should
not.

DIR-22 stays held. The client's answer on pricing is what unblocks it.
