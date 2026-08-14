# Legal register

**Created 9 August 2026.** Questions for counsel, stated so each can be handed
over without further explanation.

These have the **longest lead time of anything open on this project** — they are
the only items that cannot be compressed by working faster. Two have been open
since the second brief.

Nothing here is a legal opinion. Each entry records the question, the facts that
prompted it, what is blocked behind the answer, and its status.

---

## 1. Marketplace licensing

**Question.** Does a platform that collects payment for Egyptian tours require
its own Ministry of Tourism or ETAA registration, or does acting solely as an
intermediary for licensed companies exempt it?

**Why it arose.** Sawa is being positioned as a marketplace rather than a tour
operator: it lists departures run by independent Egyptian travel companies. The
site says so. Whether that positioning holds under Egyptian tourism law — and
whether it survives Sawa collecting money, which it does not yet do — is the
question.

**Facts as they stand.**
- No payment integration exists. No card is collected; deposits are quoted and
  settled off-platform. See `docs/audit/payment-flow-facts.md`.
- Every listed operator is required to hold a Ministry of Tourism license and
  ETAA registration.
- Capital Travel Service (ETAA 2179) is currently named in the footer as
  operating the platform. Under the amended Phase 2 brief, Sawa is to become its
  own entity with CTS as one operating partner.

**Blocked behind the answer.** Whether the site may continue describing Sawa as
"not a tour operator"; whether the entity needs its own registration before
collecting payment; the wording of the P2.1-R footer disclosure.

### ⚠️ This question may already have settled client answer #3

Client answer #3 — the post-GoAhead payment model — has been tracked throughout
as a **product decision**: does money move offline through the operator, or is a
gateway built?

**It may not be the client's decision to make.** If a marketplace collecting
payment for Egyptian tours requires its own Ministry or ETAA registration, then
whether Sawa *may hold the money at all* is settled by law, and the product
choice is constrained by it — possibly eliminated.

The difference is between building a payment gateway and discovering afterwards
that Sawa cannot legally hold the funds that pass through it.

**So answer #3 is reclassified: provisionally blocked on this question, not a
free product decision.**

**No payment integration work should begin until this is answered.** That
includes schema for payment state, gateway selection and any change to the
deposit displays that assumes money will be collected on-platform.

**Status:** open since the Phase 0 decisions.

---

## 2. Organiser status under package travel rules

**Question.** For a multi-day package sold to a UK or EU consumer, is Sawa the
*organiser* or an *intermediary* under the Package Travel Regulations, and what
does that require in the Terms?

**Why it arose.** Sawa sells 5-, 9- and 12-day packages combining accommodation,
transport and guiding. That is the shape the regulations were written for. If
Sawa is the organiser, insolvency protection and a defined liability regime
attach, and the Terms need to say so.

**Facts as they stand.**
- Three multi-day packages are live: Nile Majesty (5 days, $675), Egypt in Depth
  (9 days, $1,390), Egypt End to End (12 days, $1,520).
- Terms §2 currently frames Sawa as a platform that "brings travelers together"
  and names an "Operating Partner" as responsible for each departure.
- Terms §15 offers "an equivalent or comparable alternative… credit… or a
  refund" on a Sawa-initiated cancellation, which is regulation-shaped language
  already.
- No insolvency protection arrangement is described anywhere on the site.

**Blocked behind the answer.** Terms §2, §13, §15; whether packages may be sold
to UK/EU consumers at all before the arrangement exists.

**Status:** open since the Phase 0 decisions. **Highest exposure of the five** —
it is the only one where the current position could be wrong *and* already being
relied on by a buyer.

---

## 3. Consumer rating display

**Question.** What must be in place before an aggregate rating may be displayed
to UK or EU consumers — provenance, verification method, sample, and how each is
disclosed?

**Why it arose.** The site displayed "4.9 average traveler rating" and per-tour
star ratings drawn from a seeded `quality` column, with **no reviews table in the
database and zero bookings ever taken**. All of it has been removed.

**Facts as they stand.**
- No reviews table exists. Ratings remain unpublishable because no review
  mechanism exists — **not** because nobody has travelled: `pledges` held its
  first rows on 2026-08-12 (`E-2 ENDED 2026-08-12`), so the "no travellers"
  half of the old premise is historical and may only be cited for the period
  before that date.
- Ratings were removed under U1 and are not live.
- The client has said ratings may return "later at the operator profile level,
  tied to records, with the source stated".

**Blocked behind the answer.** Whether ratings return at all, and what the
schema must capture at the point of collection — which is cheaper to get right
before the table exists than after.

**Status:** open. Not currently causing exposure, since nothing is displayed.

---

## 4. Autoura disclosure

**Question.** Does an inventory-only data transfer to an affiliated system
warrant a line in the privacy policy?

> ### ⚠️ ZZ3.3 — this question's premise was wrong, and the register carried it
>
> It was framed **retrospectively**: *has an undisclosed transfer been
> occurring?* It has not. The mirror has never transmitted anything —
> `emitDepartureSync` called a function that does not exist, on every path,
> since the feature was introduced.
>
> Restated **prospectively: this transfer is about to begin.** That is the better
> position to be in, and the paragraph now documents new processing rather than
> existing processing.
>
> **The register carried an inferred fact.** `/api/modes` reported `autoura: on`,
> which says the mirror is *configured*; I read it as evidence data was flowing
> and wrote that here as established. This document is meant to be the reliable
> one, so the failure is recorded rather than quietly corrected — and it is the
> same failure the whole project keeps finding: a representation read as the
> system.

**Why it arose.** When `AUTOURA_SYNC_URL` and `AUTOURA_SYNC_SECRET` are set,
every departure write is mirrored to an external system at getautoura.net.
Common ownership does not make two systems one system.

**Facts as they stand.**
- **No personal data crosses the boundary.** The payload is route, type, dates,
  city, min/max seats, an aggregate `seatsTaken` integer, status and price.
- Verified by test, and the boundary was narrowed under Y2 so the payload
  builder never receives pledge rows — `loadInventory()` selects only
  `status, seats`, so personal columns never leave Postgres.
- The privacy policy names no affiliated system.
- **The mirror is CONFIGURED but has never transmitted.** `/api/modes` reports
  `autoura: on`, which says the env vars are set. Verified 9 August by running
  the emitter end to end against a listener: every call threw a `ReferenceError`
  and the `.catch()` logged it at warn level. Nothing has ever crossed.
- **It will start transmitting on the next deploy.** TT1 fixed the emitter and
  widened which write paths reach it. `/api/modes` now also reports
  `effects.autouraSync` — last success, last failure, and `neverWorked` — so
  "configured" and "working" are no longer the same answer.

**Blocked behind the answer.** A possible privacy policy line — now **drafted**,
in `privacy-policy-revision.md`, ahead of TT1 widening which write paths
transmit. No new field crosses; more events do.

**⚠️ Correction to the facts above, established 9 August by running it:** the
mirror has never transmitted anything. `emitDepartureSync` called a function
that does not exist, on every path, since the feature was introduced — every
call threw and the error was downgraded to a `console.warn`. `autoura: on` in
`/api/modes` reports that the mirror is *configured*, which is what it has
always meant; it was read here, and by me, as evidence that data was flowing.
It was not. Fixed under TT1, and verified end to end against a listener.

**Status:** open, and **prospective**. The paragraph is drafted in
`privacy-policy-revision.md`.

**ZZ3.1 / ZZ3.2 — it publishes alone, and it publishes first.** It needs no
entity answer: it describes what is shared and what is not, and neither depends
on who the controller is. Threads 2 and 3 of that revision stay blocked; this one
does not wait behind them.

**Sequence: the paragraph is published, THEN the four new sync paths go live.**
Not the reverse, and not held indefinitely behind an unrelated open question.

---

## 5. Entity disclosure

**Question.** Once the Sawa entity's status is settled, what must be named,
where — footer, Terms, Privacy, Cookies, and the JSON-LD `Organization` block?

**Why it arose.** The amended Phase 2 brief states Sawa is now its own legal
entity and a marketplace, not operated by Capital Travel Service. The site still
says the opposite.

**Facts as they stand.**
- Footer, Terms, Privacy and Cookies all name "Capital Travel Service, trading as
  Sawa Tours", ETAA 2179, with a Giza address.
- JSON-LD carries `hasCredential: "Operated by Capital Travel Service — ETAA
  licence no. 2179"` and **no `legalName`**.
- P2.1-R's replacement copy is written and waiting, with
  `{{SAWA_LEGAL_NAME}}` and `{{SAWA_REGISTRATION}}` as placeholders.
- **Nothing has been built**, deliberately: a footer must not ship with a
  placeholder entity name.

**Blocked behind the answer.** All of Phase 2 — P2.1-R, P2.2-R, P2.3-R, P2.4-R.

**Status:** open. Gated on incorporation, which is the client's to report.

---

## 6. Data API exposure — personal data readable by anyone

**Question.** Does a period during which staff identities, email recipient
addresses and a full activity log were readable over the internet by anyone
holding a public key constitute a notifiable personal data breach, and if so to
whom and within what period?

**Why it arose.** Found 10 August 2026 while auditing `audit_log` integrity.
Four facts composed: row-level security was disabled on all 13 tables, `anon`
and `authenticated` held full DML on every one, the Supabase Data API was live,
and the anon key is published in the site's JavaScript by design. A request
carrying that key returned rows.

**Facts as they stand.** Full technical record in
`docs/audit/data-api-exposure.md`.

| Table | Rows | Personal data readable |
|---|---|---|
| `app_users` | 2 | email, full name, role, status — staff identities, including which account is `super_admin` |
| `email_log` | 28 | recipient addresses and subjects of real sends |
| `audit_log` | 63 | actor email, action, entity, timestamp — a full activity history |
| `pledges` | **0** | traveller name, email, phone — **none exposed; the table is empty** |
| `operator_applications` | **0** | applicant contact details — **none exposed; empty** |

- **No traveller personal data was exposed**, because no traveller data exists
  yet. That is a fact about timing, not about the control.
- **Period:** from project creation until migration 024 is applied to
  production. The earliest firm date available internally is 2026-05-22.
- **Evidence of access:** `pg_stat_statements` records **seven** Data API
  requests by `anon` in its retained window (since 2026-05-31 14:37 UTC), and
  all seven are the probes issued during this investigation. Nothing else.
- **The limit of that evidence, stated:** it covers 71 days, not the whole
  period, and Postgres attributes no request to an IP, origin or user-agent.
  **"No evidence of access within the retained window" is not "no access
  occurred."** Supabase's dashboard API logs are the only source that can
  narrow this further, and they must be pulled before their retention expires.

**Blocked behind the answer.** Whether notification is required, and to whom.
Note this does **not** block the fix: 024 should be applied regardless of the
legal answer, and applying it does not concede anything.

**Status:** open. **Two actions are time-sensitive and independent of counsel:**
apply 024, and pull the dashboard API logs before they roll off.

---

## Summary

| # | Question | Exposure now | Blocks |
|---|---|---|---|
| 1 | Marketplace licensing | Low today — **but may govern answer #3** | Footer disclosure, **all payment work** |
| 2 | Organiser status | **Highest** — packages are on sale | Terms §2/§13/§15 |
| 3 | Rating display | None — nothing displayed | Reviews schema |
| 4 | Autoura disclosure | Low — inventory only, and **prospective**: nothing has ever been transmitted | A privacy policy line, **drafted**, publishes alone |
| 5 | Entity disclosure | Site currently states the pre-change position | All of Phase 2 |
| 6 | **Data API exposure** | **Live until 024 is applied** — staff identities, email recipients and the activity log readable by anyone. No traveller data, because there is none yet | Notification decision. **Does not block the fix.** |

## Send 1 and 2 together

**#2 is the most urgent** — the only question where the current live position
could be wrong and a consumer could already be relying on it.

**#1 must go with it, and not merely for efficiency.** Until it is answered, the
client is being asked to decide something the law may have already decided.
Sequencing them apart risks the payment model being chosen, built, and then
constrained.

### Dependency

```
Legal Q1 (marketplace licensing)
        └── constrains or determines ──> Client answer #3 (payment model)
                                                └── gates ──> deposit displays,
                                                              refund copy,
                                                              payment schema
```

Client answer #3 is **provisionally blocked on legal question 1**, not open for
decision.
