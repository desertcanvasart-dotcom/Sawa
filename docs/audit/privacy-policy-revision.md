# RR3 — The privacy policy revision

**9 August 2026. Draft. Not published, not signed off.**

Three threads have each been sitting as a footnote somewhere else, with no owner
and no single document:

| Thread | Status |
|---|---|
| **Autoura** — inventory transfer to an affiliated system | **drafted below (TT1.2)** — needed *before* the new sync paths go live |
| **Entity** — who the controller is | blocked on the client's answer |
| **Attribution** — behavioural data tied to an identified booker | blocked on this document existing, and on migration 023 being applied |

They are one revision, not three amendments. Counsel can refine the wording;
that should not gate a correction to data already flowing.

---

## 1. Autoura — drafted (TT1.2)

### Why this comes before the new paths

TT1 widens what is transmitted. Four write paths that have never emitted now do:
a price change across every date of a product, a declined request, a booking
status change, and the unattended cancel job.

**No new field crosses.** The payload is inventory only, and Y2 narrowed
`loadInventory` so pledge rows never reach the builder — the personal columns are
not in scope, structurally, rather than filtered. The field list is pinned by a
test on each of the four paths.

But **more events** cross, and legal register #4 is open on exactly this
transfer. So the paragraph is drafted before the paths ship, not after.

**One correction to the record while drafting this:** the mirror has, in fact,
never transmitted anything at all — `emitDepartureSync` called a function that
does not exist, on every path, since the feature was introduced. See the TT1
report. That does not reduce what the policy needs to say; it means the
disclosure describes what will start happening rather than what has been.

### Drafted paragraph

> **Sharing with affiliated systems.**
>
> Sawa Tours operates alongside other travel brands. When a departure is
> created, changed, cancelled or repriced, we send a summary of that departure —
> the route, its dates and times, the city, the number of seats it needs and
> allows, how many seats are taken, its status, and its price — to an affiliated
> reservation system so that the same departure can be offered through those
> brands.
>
> **We do not send your name, your email address, your phone number, your
> booking reference, or any other information that identifies you.** The seat
> count is a total. It cannot be traced back to an individual traveller.
>
> This sharing happens automatically whenever a departure changes. It is not
> marketing, and you cannot be identified from it.

### Notes for counsel, not for publication

- **"a summary of that departure"** rather than an exhaustive field list: the
  list is pinned in code and tested, and a policy that enumerates it goes stale
  the first time the pin legitimately moves. The categories are stated instead.
- **The affiliated system is not named** in the draft. Whether to name it turns
  on the entity answer, which is outstanding.
- **`seatsTaken` is an aggregate.** Worth stating explicitly because it is the
  only number that moves in response to an individual's booking, and a reader
  may reasonably wonder.
- **No legal basis is asserted** in the draft. It follows from the entity
  question and from legal register #4.

---

## 2. Entity — blocked

The footer, Terms, Privacy and Cookies all name *"Capital Travel Service, trading
as Sawa Tours"*, ETAA 2179. **So do the transactional email templates** — found
under KK3 and not previously in scope for the entity sweep.

The amended Phase 2 brief states Sawa is now its own entity. The site says the
opposite. Nothing can be drafted here until the client reports the status,
because the controller's identity is the first thing a privacy notice states.

`{{SAWA_LEGAL_NAME}}` and `{{SAWA_REGISTRATION}}` are the placeholders P2.1-R
already carries. **A privacy policy must not ship with a placeholder
controller** — the same rule that has kept the footer unshipped.

---

## 3. Attribution — blocked on this document

Migration 023 adds `origin_article`, first/last touch paths and timestamps,
referral source and brand to `pledges`. Touch paths tied to a named booker are
behavioural data about an identified person.

**The blocker is transparency, not consent** (RR2). Recording how someone
reached the booking they made is processing incidental to the transaction;
emailing them afterwards is what needs consent. Gating attribution behind a
consent flow it does not need would push it past the early bookings, which are
the entire reason for the column.

So: **the columns may exist, and nothing may write to them until this document
describes the processing.** Migration 023 writes nothing, deliberately.

Draft to follow once the controller is known — the paragraph's subject is the
controller, so it cannot be written before thread 2 resolves.

---

## What ships when

| | |
|---|---|
| Thread 1 (Autoura) | **can ship now** — drafted, and needed before TT1's paths go live |
| Thread 2 (entity) | client |
| Thread 3 (attribution) | after thread 2, and before any attribution write |

**Nothing here is published.**
