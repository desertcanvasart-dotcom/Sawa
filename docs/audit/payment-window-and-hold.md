# Payment window, hold period, and the state nobody has specified

**Recorded 10 August 2026 (LLL).** Client rules received in conversation and
written down before anything is built, per the BBB1 process rule: *chat is not a
record.*

Nothing here is implemented. This is the specification plus what checking it
against the code turned up.

---

## LLL1 — The client's rules, as given

| | |
|---|---|
| **Payment window** | 3 days from the payment link being issued |
| **Hold period** | if a seat releases, the date returns to forming and stays open until **7 days before departure**, so another traveller can take the seat |
| **At the 7-day mark** | if still below minimum: cancel and refund everyone in full |

---

## ⚠️ LLL1.1 — The 7-day figure is the day-tour default only. Packages are 30.

The brief states *"the 7-day figure matches the scheduler's existing confirm
deadline — the hold period and the auto-cancel logic agree rather than
conflicting."*

**That is true for 12 of the 16 live products and false for the other 4.**

> Restated 10 Aug 2026 — the client added two products (one package) while this
> was being written. The finding is unchanged and now covers four packages.

```
server/domain.js:58   DEFAULT_PACKAGE_CONFIRM_DEADLINE_DAYS   = 30
server/domain.js:59   DEFAULT_DAY_TOUR_CONFIRM_DEADLINE_DAYS  = 7
```

Checked against production, not inferred:

| Type | Approved products | Deadline | Override set |
|---|---|---|---|
| `day_tour` | **12** | T-7 | none |
| `package` | **4** | **T-30** | none |

`tour_products.confirm_deadline_days` may also override per listing, `CHECK
(… BETWEEN 0 AND 365)` — currently unused, so every product takes its type
default. **A single operator setting that field changes the answer for one
listing.**

### What breaks

**1. The hold and the auto-cancel job give opposite answers on a package.**
A hold that "stays open until 7 days before departure" keeps a package forming
through T-29… T-8. `cancel-unconfirmed` cancels it at **T-30**. Two rules, each
correct by its own terms, disagreeing without either failing — the DIR-5 shape
exactly.

**2. LLL2's collision table is calibrated on 7.** Against 30 the collision
starts at **T-33**, not T-10:

| Package confirms at | 3-day window ends | |
|---|---|---|
| T-35 | T-32 | fine |
| T-32 | T-29 | **past the T-30 cutoff** |
| T-25 | T-22 | **no room for a window at all** |

Packages are the expensive bookings, so the higher-value case is the one the
7-day figure does not describe.

### LLL1.2 — The correction to LLL2.1

> **Payment is due within 3 days, or by the departure's confirm deadline,
> whichever is sooner.**

Not "7 days before departure". Expressed against
`confirmDeadlineDaysFor(product, departure)` — the existing authority, which
already handles the type default and the per-listing override. Hard-coding 7
would mis-handle every package today and every override ever set.

This is the `shared/group-size.js` + `check:constants` pattern: one authority,
and nothing restating the number.

---

## LLL2 — Where the windows collide (day tours, as briefed)

| Confirms at | Window ends | |
|---|---|---|
| T-11 | T-8 | fine |
| T-9 | T-6 | **past the cutoff**; the seat cannot release in time to refill |
| T-3 | T-0 | no room for a 3-day window at all |

### LLL2.2 — Dates confirming inside the window · **CLIENT DECISION**

Both stated, neither chosen:

| Option | What it means | Cost |
|---|---|---|
| **A — pay immediately** | confirmation inside the deadline requires payment on the spot, no window | a traveller who cannot pay within minutes loses the seat; worst for the late booker who is most committed |
| **B — close bookings inside the deadline** | the date stops accepting new bookings once inside the confirm deadline, so it cannot confirm there | forfeits genuine late demand, and a date one seat short at T-8 can never fill |

**Note B interacts with LLL1.1:** on a package it would close bookings 30 days
out, which is a much larger commercial decision than closing them 7 days out.
The two product types may need different answers, and that is itself the
decision.

### LLL2.3 — Reminder before expiry

A window with no reminder is a window most people miss. **Proposed:** day 2 of
3; or 24 hours before expiry where the window is compressed by LLL1.2. One rule,
derived from `payment_due_at`, not a second schedule.

---

## LLL3 — Paid travellers during a hold

A traveller paid for a **confirmed** departure. A seat releases, the group drops
below minimum, the date is no longer confirmed — **and they have already paid.**

The site has never rendered this. It is a new state, not a variant of forming:
forming means *nobody has committed money yet*, and here somebody has.

### LLL3.1 — Tell them · **recommended, client to confirm**

If a traveller later discovers "confirmed" quietly stopped being true while they
made plans, that is the single failure this brand cannot absorb.

> One traveller wasn't able to complete their booking, so we're holding your
> place while we find a replacement. If the group doesn't refill by {date},
> you'll be refunded in full — nothing for you to do either way.

`{date}` is the confirm deadline, per LLL1.2 — **not** a hard-coded 7 days.

### LLL3.2 — The booking lookup must not say "confirmed"

Per the LL3 ordering, departure state is asked first and pledge state second. A
paid traveller on a below-minimum date must not see the running message with
meeting instructions.

**A fourth state**, alongside running, cancelled and forming. Needed on the
departure page, in `bookingLookupView`, and in email.

### LLL3.3 — Can a paid traveller withdraw during a hold? · **CLIENT DECISION**

**Recommended: yes, stated proactively.** Do not build the refusal path by
default — a refusal path is far harder to remove later than to add, and the
GoAhead promise's whole argument is that the traveller carries no risk while the
group is unconfirmed.

---

## LLL4 — Schema, while `pledges` is still empty

The migration-023 argument applies again: these record things that exist only at
the moment of the write, and `pledges` holding no rows is the asset being spent.
**See E-2 — that asset is spent exactly once.**

| Field | Notes |
|---|---|
| payment state | `awaiting_link`, `link_sent`, `paid`, `overdue`, `released`, `refunded` |
| `link_sent_at`, `payment_due_at` | **stored, not derived.** A later policy change must not retroactively move a deadline a traveller was already told. |
| `refund_reference` | |
| departure-level | whether in a hold, and when the hold expires |

**`payment_due_at` stored rather than derived is the load-bearing choice here**,
and LLL1.2 is why: the rule depends on the product's confirm deadline, which an
operator can change. Deriving it would let an override silently move a deadline
that has already been communicated.

Not written until LLL2.2 and LLL3.3 are answered — the permitted values of the
departure-level hold field depend on both.

---

## LLL5 — What the seed costs, restated

### LLL5.1 — Re-derive everything resting on E-2 *before* seeding

`pledges has never held a row` is load-bearing in four places. One row ends all
four **simultaneously**, so each needs a new basis written in the same commit:

| Resting on it | New basis needed |
|---|---|
| `scripts/audit-claims.js:54` — the `volume` rule's premise | a new calibration basis: what volume claim is evidenced once rows exist |
| EEE3 — "no traveller personal data was exposed" | restate as **historical**, bounded by the seed date |
| Legal register Q3 — rating display | premise updated |
| `docs/audit/cancel-job-rehearsal.md` | premise updated |

### LLL5.2 — DIR-14's real argument

Not only *clean the tests before adding data*. **DIR-14 is the last point at
which the empty-table assumption can be audited while it is still true.**

After the seed, a test that passed vacuously and a test that passes genuinely
become indistinguishable by inspection — the evidence for telling them apart is
the emptiness itself.

---

## Open, and who holds them

| | Holder |
|---|---|
| **LLL2.2** — dates confirming inside the deadline (A or B, and whether packages differ) | client |
| **LLL3.3** — can a paid traveller withdraw during a hold | client |
| ~~**LLL1.1**~~ | **ANSWERED 10 Aug 2026 — see below** |

## LLL1.1 — ANSWERED: the hold inherits the confirm deadline

**It does not flatten to 7.** Recorded with the reasoning so it is not later
"tidied" into a constant: the confirm deadline exists because a package needs
lead time — hotel rooms, cruise cabins and internal flights must be sourced. A
package confirming at T-8 cannot be delivered. Day tours are 7 because a guide
and a vehicle can be arranged quickly. The deadline already encodes operational
reality per product type, and the hold inherits it.

So LLL1.2 above is the rule, and **LLL2.2 splits by product type** — option B
closes package bookings at T-30 and day tours at T-7. Whether they warrant
different answers is itself the client decision.

Raised separately with the client: whether 30 days is the right package deadline
at all, or whether it costs bookings operators could in fact fulfil.
