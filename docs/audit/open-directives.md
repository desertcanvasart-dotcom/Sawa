# Sawa — Open Directives

**This document exists because the directives it contains have lived only in
conversation.** A merge blocker that is not in the repository does not block —
that is the BBB1 finding, and this is the fix.

> **BBB1, stated once so it is on the record.** BBB1 and BBB2 were raised as
> merge blockers for PR #85 and were not answered before it merged. They
> appeared in no commit, no branch and no document, so the session that did the
> merge had no way to know they existed. Nothing enforced them because there was
> nothing to enforce.

**Process rule from here:** anything intended to gate a merge, or to be picked
up in a later session, is written to `docs/audit/` **before the branch is cut**.
Chat is not a record.

---

## How to use this

Every item below was agreed in conversation and is not otherwise recorded.
**Verify each against the repository before starting** — some may already be
shipped under a different name. Mark those closed with the evidence rather than
redoing them.

A first verification pass was run when this document was written (10 August
2026, `49706a7`). Its results appear inline as **VERIFIED** blocks. Items with
no such block were **not** checked and must be before work starts.

---

## Immediate

### DIR-1 — Audit logging on access revocation *(new, highest value)*

`DELETE /api/agency/staff/:id` and `PATCH /api/admin/staff/:id` call `logAudit`
nowhere. `staff.create` is audited; the paths that *remove* access are not.

An audit trail with a hole exactly where access is removed is worse than none,
because it is trusted. BBB1 could only be answered from `auth.users` state plus
a code argument — the trail could not have answered it.

- Audit both paths, with actor, target, and outcome
- Sweep for other unaudited state changes, prioritising anything touching
  access, money or status
- Assert coverage in a test, since an audit gap is invisible until it is needed

> **CLOSED 10 Aug 2026 — #88 (`4208d46`).** The sweep found **eight** unaudited
> mutating routes, not two, and two defects that logging alone would not have
> fixed: `PATCH /api/agency/staff/:id` set `status='disabled'` and never touched
> the login (DIR-1.1), and `status='active'` never lifted the ban, so
> re-enabling silently did nothing (DIR-1.2). `revokeLogin` became
> `setLoginAccess`. `scripts/audit-coverage.js` + `server/audit-coverage.test.js`
> hold the line at **32 routes · 31 audited · 1 exempt · 0 unaudited**. Full
> record in `docs/audit/access-audit-coverage.md`.

### DIR-2 — The 14 claims findings

Blocked on the client. 11 `availability`, 2 `phantom-payment-process`, 1
`absolute-claim` (`"100% refund"` on `/how-it-works`).

Not a mechanical call. Fix when the answers land; do not baseline them silently.

> **VERIFIED 10 Aug 2026 — OPEN, and it is why `preflight` cannot pass.**
> `audit:claims` exits 1 on any finding. The gate has never been green.

---

## The invariant work

### DIR-3 — Latent-defect register *(was OO1.1)*

Create `docs/audit/latent-defects.md`. For each entry: what is divergent, what
invariant currently masks it, **what change would arm it**, and where that
invariant is defined.

Seed with:

- the three masked rule divergences found during the `isForming`/`isGoAhead`
  unification — masked by `pledges.seats NOT NULL` and by `/api/bootstrap`
  running `statusFor`
- the `cancelled_reason` precedence question (DIR-4)
- the Autoura mirror being complete but not reliable — nothing reconciles, and
  divergence is undetected
- the read-only session setting being defeatable by a runtime `SET`, closed only
  by the role
- the `check:status-literals` `IS NULL OR` parser gap — correct for the forms it
  knew, silently incomplete for one it did not

> **VERIFIED 10 Aug 2026 — the register does not exist; OPEN.** Two seed entries
> need restating before they go in:
>
> - **The `IS NULL OR` parser gap is CLOSED.** `scripts/check-status-literals.js:44`
>   now matches both `CHECK (col IN (…))` and `CHECK (col IS NULL OR col IN (…))`,
>   with the miss recorded in place. It belongs in the register as a *closed*
>   worked example of the class, not as a live defect.
> - **The read-only gap is half closed.** `server/db/readonly.js` (X1) sets
>   `default_transaction_read_only=on` per session, which holds today against the
>   existing write-capable credentials. Its own header states the limit: a
>   runtime `SET` defeats it, and only the role closes that. Client-blocked, #7.

### DIR-4 — Two questions, one ordering

When the `cancelled_reason` read path is built, **do not flip the precedence**.
There are two questions:

| Question | Asked first |
|---|---|
| Is this date running? | Departure status, always |
| Why is this person not on it? | Pledge reason, when it has one |

Reversing the order returns the earlier defect with polarity inverted: a
traveller with an active booking on a cancelled date told about their pledge
state instead of the cancellation. **Collapsing them is the shorter code**,
which is why this is written down.

> **Note.** The columns exist as of migration 023 (applied to production
> 10 Aug 2026 10:34 UTC). **Nothing writes them yet**, so this directive is
> live the moment anything does.

### DIR-5 — Enumerate invariants that hold through one door *(was OO2.2)*

Three known instances:

| Invariant | Holds only via | Skipped by |
|---|---|---|
| `emitDepartureSync` | API route handlers | the scheduled job |
| `statusFor` normalisation | `/api/bootstrap` | any other path serving departures |
| shared rules | modules that import them | anything hand-writing the rule |

**Reframed:** the productive question is not "what could fail" but **"what could
disagree without failing."** A loud incompatibility is self-limiting; a silent
one is unbounded.

> **VERIFIED 10 Aug 2026 — row 1 is CLOSED.** TT1 (`07ffff0`) moved the emit to
> the boundary: `withDepartureWrites` in `server/db/index.js:82` emits after
> COMMIT, and `server/jobs/cancel-unconfirmed.js:55` goes through it. The job no
> longer skips the mirror. Rows 2 and 3 not checked — the enumeration itself is
> still to be written.

### DIR-6 — Move invariants to the boundary *(was OO2.1)*

Propose, do not apply — it touches every read path.

`statusFor` normalisation belongs in the data access layer, where no consumer
can skip it. Same reasoning as narrowing `loadInventory()` so personal columns
never leave Postgres: structural impossibility over correct usage.

> **Note.** `withDepartureWrites` (DIR-5) is the worked precedent for this
> shape, and its own header states the honest limit: a caller still has to call
> `touch`. It is a detector, not a structural impossibility. Any proposal here
> should say which of the two it achieves.

### DIR-7 — Derived duplication catalogue *(was OO3)*

The catalogue was maintained by hand and was incomplete — five duplications
listed, six existed.

Now that `shared/` holds the authorities, add a check that **no file outside the
shared module independently computes the fields those authorities own.** A
derived catalogue cannot be incomplete the way a listed one can.

> **VERIFIED 10 Aug 2026 — OPEN.** No such script exists in `scripts/`.

### DIR-8 — Remaining duplicated rules *(was NN2.2 onward)*

In order:

1. `slugify` / `tourSlug` — **drift breaks every published article link at
   once**, on the surface meant to produce bookings
2. `livePriceFor` — agency quotes a price the server will not honour
3. `seatsTotal` — four copies, display only
4. `capacityError` — fails safe

Use the `shared/group-size.js` + `check:constants` pattern throughout.

> **VERIFIED 10 Aug 2026 — item 1 is PARTIALLY closed, and the remaining half is
> the half the risk statement is about.**
>
> - **`tourSlug` is unified.** One definition in `server/slug.js`, imported by
>   `server/seo.js:14` and `src/main.jsx:33`. No copies.
> - **`slugify` is NOT.** `src/AdminDashboard.jsx:24` holds a private
>   implementation used for **blog slugs** and referral codes. Blog slugs are
>   exactly the published-article links the risk statement names, so item 1
>   should be rewritten to target `slugify` specifically.
>
> Items 2–4 not verified beyond file presence: `livePriceFor` appears in 4
> files, `seatsTotal` in 6 (one of which is `shared/departure-state.js`),
> `capacityError` in 2. Whether each is an import or a re-implementation needs a
> per-file read — the counts alone do not distinguish them, and treating them as
> if they did is the mistake this document exists to stop.

---

## Traveller-facing

### DIR-9 — Cancellation email copy *(was KK2)*

The email never states the minimum was not reached — the moment the GoAhead
promise is being *kept* reads as a service failure.

Proposed:

> {route} on {date} didn't reach the four travelers it needed, so it won't be
> running. That's the GoAhead promise doing its job — you were never charged, so
> there's nothing to refund.
>
> **[ See other dates on this route ]**

Route-scoped, not the whole board. Both changes stand regardless of the transfer
decision; the remainder waits on it.

### DIR-10 — One delivered cancellation email *(was KK4)*

From a Railway shell, to an internal address. No synthetic departure needed.

Report the delivered content verbatim including headers and footer — templates
were scanned as rendered fixtures, never inspected as actually delivered.

### DIR-11 — Timezone on displayed deadlines *(was Y3)*

Report every place a cutoff, confirm deadline, departure time or booking window
is **displayed**, and whether the timezone is named. Travellers book from other
timezones; a deadline without one is an ambiguous promise.

> **Note.** YY3 pinned `TZ=UTC` in the suite and asserts Cairo at the
> boundaries — that is the *computation* side. This directive is about what a
> traveller **reads**, which is untouched by it. The two must not be confused
> for one another.

### DIR-12 — Privacy policy *(was RR3)*

Three threads, one document:

1. **Autoura** — inventory transfer. **Publishable now, decoupled from the
   entity answer.** Publish, then bring the four new sync paths live.
2. **Entity** — controller identity. Blocked on the client.
3. **Attribution** — behavioural data tied to an identified booker. The blocker
   is **transparency**, not marketing consent; do not gate attribution behind a
   consent flow it does not need.

> **Note.** Migration 023 added the attribution columns
> (`origin_article`, `first_touch_*`, `referral_*`) and the consent columns to
> production on 10 Aug 2026. **Nothing writes any of them.** Thread 3's blocker
> is therefore live: the columns exist, and the first write is what needs the
> notice to be published first.

---

## Gates and tests

### DIR-13 — W3 retrofit *(was NN5)*

Proven-fires tests for the three checks predating the W3 rule. Recorded as
*pending*; it is **half done**, which is the more dangerous label — "not done"
invites work, "looks done" invites nobody.

> **Partially verified 10 Aug 2026.** `server/status-literals.test.js` carries
> the proven-fires pattern (deliberately-invalid fixtures, asserted to be
> caught), as do `server/catch-handlers.test.js` and
> `server/preflight-contract.test.js` added since. **Which three checks the
> directive means was not established** — that list needs naming before the
> retrofit can be called done, and naming it is the first task.

### DIR-14 — Vacuous-test sweep *(was Z2)* — before any seeding

A test passed for the life of the codebase because the tables it checked were
empty. It asserted nothing, and a vacuous pass renders identically to a real one.

`departures` and `pledges` are empty. Every test written against them is
suspect.

- Find every test whose assertions could hold trivially given current data
- Fix by making emptiness a failure — assert the data is present first
- Where practical, make the suite report **unverified** rather than green when a
  subject set is empty

**Must complete before the seed**, or new failures and never-testing tests
become indistinguishable.

> **LLL5.2 — the sharper statement of why.** This is not only *clean the tests
> before adding data*. **DIR-14 is the last point at which the empty-table
> assumption can be audited while it is still true.** After the seed, a test
> that passed vacuously and one that passes genuinely are no longer
> distinguishable by inspection — the evidence for telling them apart is the
> emptiness itself. See [E-2](evidence-expiry.md).

> **Note.** `scripts/run-tests.js` already applies the principle one level up —
> a suite that finds no test files refuses to report a pass. That is the shape
> to copy, not a reason to think the sweep is done.

---

## Build

### DIR-15 — Route alerts table *(was KK5)*

Currently "tell me when a group forms" points at `/contact`, correctly — a form
that captures an address and tells nobody is fabrication in a politer shape.

But this is the **primary conversion action for the content programme's first
six months**. It must exist before any article publishes.

Schema: email, itinerary, optional preferred month, source URL, timestamp, plus
consent fields per DIR-12. Plus the admin view — which routes and months are
accumulating demand is the signal that decides which departures get scheduled.

### DIR-16 — Staged seed *(was II3)*

**Preconditions, all required:**

0. **EEE4 — migration 024 applied and verified against production, with an
   anonymous request confirmed to return `401` or empty on every table.**
   Ahead of the others. Seeding travellers into an openly readable database is
   the one version of this that cannot be undone. Verification procedure in
   `docs/audit/data-api-exposure.md`.
1. DIR-14 vacuous-test sweep complete
1b. **LLL5.1 — every conclusion resting on E-2 re-derived, in the same commit as
   the seed.** `pledges has never held a row` is load-bearing in four places and
   one row ends all four at once: the `volume` rule's calibration in
   `scripts/audit-claims.js:54`, EEE3's exposure-scope finding (restate as
   historical, bounded by the seed date), legal register Q3, and
   `docs/audit/cancel-job-rehearsal.md`.
2. Scheduler resolved state verified — done, was `on`, now dry by default
3. Cancellation copy corrected — DIR-9, remainder on the client
4. Zero-suppression shipped — done
5. Pledge status transitions with the departure — done

**Then stage it:**

1. Seed **one** departure — choose one expected to sit below minimum, since that
   state has never rendered with real data
2. Run the full gate against the now-non-empty states
3. Confirm the three designed states render with a real count
4. Confirm the dry cancel path refrains **on a real candidate** — structural,
   but never observed with something to act on
5. Only then load the remainder

The first real traveller data should enter a system verified **with** data. Every
failure in this project came from something correct in a state it was not going
to stay in.

> **VERIFIED 10 Aug 2026 — precondition 2 confirmed.**
> `server/jobs/scheduler.js:67` — `CANCEL_JOB_DRY_RUN !== "0"`, so the scheduled
> run is dry unless explicitly switched live (BB3). Precondition 4's mechanism
> is present (`reportNotifications` in `server/departure-cancel.js:84`, PP2).
> Preconditions 1, 3 and 5 not verified.

---

## Recorded, not scheduled

Folded into DIR-3's latent-defect register when it is written; kept here so they
are not lost in the meantime.

| | |
|---|---|
| **DDD3 — the cancel job is audited. CLOSED.** | And better than the routes were: `server/jobs/cancel-unconfirmed.js:69` writes `departure.auto_cancel` **inside the same transaction** as the cancellation, with reason, seats, minimum, pledges cancelled and the deadline. It uses a raw `INSERT` rather than `logAudit` **deliberately** — `logAudit` uses the pool, not the transaction client, so switching it would turn an atomic record into a race. Needs a comment and a test asserting the audit row and the cancellation share a transaction, so a later tidy-up does not "fix" it. |
| **11 unaudited operator scripts** | every `server/db/*.js` one-off, including `reset-fabricated-inventory.js`, **which deletes**. A destructive unattended script with no record is the DIR-1 shape outside route scope, and the route scanner cannot see it. |
| **DDD4's honest limit** | no ban was ever applied and both `app_users` rows are `active`, so DIR-1.2 could not have fired and no *persisting* DIR-1.1 instance exists. But a disable-then-reenable through the then-unaudited PATCH would have left **no trace at all** — `audit_log` holds exactly one user-related row ever, a `staff.create` from 2 June. A transient instance cannot be ruled out, only a persisting one. Expiry discipline per DDD1. |
| **DDD1 — evidence expires. DONE.** | [`docs/audit/evidence-expiry.md`](evidence-expiry.md) — ten entries, each recording what would arm it and where that thing is defined. `server/evidence-expiry.test.js` re-checks the ones a commit can arm, so those fail the gate rather than going quiet. E-1 (the BBB1 proof) is recorded EXPIRED 2026-08-10, pinned from both sides. E-2 — *"`pledges` has never held a row"* — turns out to be load-bearing in **four** places including the claims auditor's own `volume` rule. |

---

## Current order

Revised by the client 10 Aug 2026, after the consolidated directives below were
issued. Every label now has a home in this repository.

| # | Item | State |
|---|---|---|
| 1 | Capture the consolidated directives, then merge #91 | **done — this document** |
| 2 | **DIR-17** availability — 11 findings | gated on the WhatsApp number being live |
| 3 | **DIR-18** payment copy — 3 findings | gate goes green |
| 4 | **DIR-21** pricing authority | **report only** — do not resolve by choosing |
| 5 | **DIR-19** entity disclosure | once the registered name and number arrive |
| 6 | **DIR-14** vacuous-test sweep | per LLL5.2 |
| 7 | **LLL4** payment, refund and hold schema | corrected per LLL1.1 |
| 8 | **DIR-20** the payment-link alert | |
| 9 | **LLL3** the hold state across page, lookup and email | |
| 10 | **DIR-3** latent defects, **DIR-5** invariant enumeration | |
| 11 | Staged seed | LLL5.1 re-derivations first |

**Held:** DIR-22, pending DIR-21.

---

## Client-blocked

**Clocked — these two lose value with time:**

| | Why it cannot wait |
|---|---|
| **`DATABASE_URL=<production> npm run db:migrate`** | the Data API exposure is **live** until 024 runs. Then the anonymous verification block in [data-api-exposure.md](data-api-exposure.md). |
| **Supabase dashboard API logs** | retention is rolling, and [E-4](evidence-expiry.md) records that the `pg_stat_statements` evidence is destroyed by any database restart. Legal register entry 6 turns on which claim can be made. |

**Decisions:**

| # | Answer needed | Unblocks |
|---|---|---|
| 1 | **LLL1.1 — does the hold period follow the confirm deadline per product type (7 for day tours, 30 for packages), or flatten to 7?** | **LLL2 and LLL4 are both shaped by it.** New question; the brief did not know it was one. |
| 2 | **JJJ1** — who chooses the traveller-facing price | Terms rewrite is held on this |
| 3 | **LLL2.2** — dates confirming inside the deadline | payment window rule |
| 4 | **LLL3.3** — can a paid traveller withdraw during a hold | the hold state |
| 5 | Registered legal name and number | GGG1, DIR-12 threads 2 and 3, JSON-LD `legalName` |
| 6 | **Is the WhatsApp number live?** | gates GGG3 |
| 7 | Support availability | 11 of the 14 findings |
| 8 | Post-GoAhead payment model — provisionally gated on legal question 1 | 3 findings, all deposit displays |
| 9 | Failed date: a person follows up, or a link | DIR-9 remainder, Terms alignment |
| 10 | Legal questions 1 and 2 to counsel | payment model, organiser status |
| 11 | Verification checks performed today | `/verification-standard` |
| 12 | Read-only role, `DATABASE_URL_READONLY` | closes the runtime-`SET` gap (DIR-3, E-8) |
| 13 | `PRODUCTION_DB_HOST` | upgrades the schema check to its strong form |

---

# Consolidated directives — availability, payment copy, entity, alert, pricing, agency

**Issued in chat 10 August 2026 and captured here before any of it is worked.**
BBB1's shape a fourth time; refusing to guess at the labels was the right call
and this is the fix.

Verification pass run at capture time. **VERIFIED** blocks are what was checked
against the repository; anything without one was not.

---

## LLL1.1 — ANSWERED: the hold inherits the confirm deadline

**The hold period inherits `confirmDeadlineDaysFor`. It does not flatten to 7.**

The reasoning, recorded so it is not later "tidied" into a constant: the confirm
deadline exists because a package needs lead time — hotel rooms, cruise cabins
and internal flights must be sourced. A package confirming at T-8 cannot be
delivered. Day tours are 7 because a guide and a vehicle can be arranged
quickly. **The deadline already encodes operational reality per product type,
and the hold inherits it.**

- **LLL2.1 final:** payment is due within 3 days, or by the departure's confirm
  deadline, whichever is sooner — against `confirmDeadlineDaysFor`, never a
  literal.
- **LLL2.2 splits by product type.** Option B closes package bookings at T-30
  and day tours at T-7. Whether the two warrant different answers is itself the
  client decision.
- The collision table starts at **T-33** for packages.

Separately with the client: whether 30 days is the right package deadline at
all, or whether it costs bookings operators could in fact fulfil.

---

## DIR-17 — Availability copy *(was GGG3)*

Client confirmed: **support is genuinely staffed 24/7, via WhatsApp.**

- **17.1** — one string from the config already built, replacing all four live
  variants. Locations: `/contact`, `/faq`, the `/faq` JSON-LD,
  `/goahead-promise` ×2, `/terms`, `llms.txt`, `llms-full.txt`, bundle ×3.
- **17.2** — name the channel: **"WhatsApp, answered 24/7"**. "24/7 support" is
  not checkable; naming the channel makes it verifiable on a first message.
- **17.3** — **do not publish before the number is reachable on the site.** A
  24/7 promise with no visible way to reach anyone is worse than no promise.
  Verify the number renders in served output first.

Expected: **11 findings clear.**

> **VERIFIED — the config exists and is null, as briefed.**
> `shared/site-copy.js:35` → `"support-availability": null`, with the header
> already recording *"live in six places saying four different things"* and a
> sync that refuses to render a null. The four strings appear across
> `site/contact.html`, `site/faq.html`, `site/goahead-promise.html`,
> `site/terms.html`, `server/seo.js`, `shared/site-copy.js` and `src/main.jsx`.
> **The mechanism is built; only the value and the gate are missing.**

---

## DIR-18 — Payment copy *(was FFF2.1)*

Model: **secure payment link after GoAhead, into Sawa's own merchant account,
sent manually for now.** Balance in cash on arrival or by a further link.

- **18.1** — deposit displays can now be true: *due once your date confirms,
  paid by secure link.* Propose per location.
- **18.2** — split `"100% refunded if a date never confirms"`, which cannot
  cover all three cases: (1) never reached minimum — nothing charged, nothing to
  refund, DIR-9's wording; (2) cancelled after confirmation and payment — a real
  refund with a stated timeframe; (3) **dropped below minimum after payment**
  because a traveller did not pay — those who paid are refunded in full, and the
  copy must explain why a confirmed date stopped being confirmed **without
  blaming the traveller who did not pay.**
- **18.3** — `/terms` refund lines aligned to the same three cases.

Expected: **3 findings clear. Gate goes green.**

---

## DIR-19 — Entity disclosure *(was GGG1)*

Client confirmed **Sawa is separately incorporated**, and counsel has cleared it
to collect payment under Egyptian law. **Registered name and number to be
supplied. Do not proceed with placeholders.**

- **19.1** — footer, About "Who runs Sawa" (carrying the restored 1993 founder
  history), JSON-LD `legalName`/`address`/registration identifiers, privacy
  controller identity and the attribution paragraph, and the mail templates
  reading *"Capital Travel Service, trading as Sawa Tours"*.
- **19.2** — sweep for the old entity string using the **response-derived**
  method; it appears in transactional email and may sit in a partial or a
  database field rather than obvious source.
- **19.3** — Capital Travel Service becomes an **operator record** with the
  founding-partner label, no longer the operator of the platform.

> **VERIFIED — the sweep is larger than "the footer".** `Capital Travel Service`
> appears in at least **10 `site/*.html` files**: index, about, goahead-promise,
> contact, cookies, terms, how-it-works, departures, operators, goahead. 19.2's
> response-derived method is the right instrument — a source grep alone will
> miss the mail templates and anything stored in a column.

---

## DIR-20 — The payment-link alert *(was GGG4)*

When a departure reaches GoAhead, email the portal that a payment link needs
creating.

- **20.1** — trigger **from wherever the transition is authoritative, not from a
  route handler.** It must fire whether the departure confirms via a booking, an
  admin action, or any future path.
- **20.2** — contents sufficient to act without opening anything else: route,
  date, operator, travellers confirmed, seats, each traveller's name, contact
  and amount due, and a direct portal link to the departure.
- **20.3** — **email is the prompt, not the record.** Pair with a payment-state
  queue in the portal: an unread email is indistinguishable from no departure
  needing a link — the mirror's shape, and here it costs revenue directly.
- **20.4** — PP2 discipline: record intended sends, assert they happened, fail
  loudly on shortfall. A GoAhead with no alert sent is an **error**, not a quiet
  success.

> **VERIFIED — 20.1 has a specific home.** `refreshStatus(c, departureId)` at
> `server/app.js:1653` is where status is recomputed after a write, and it is
> already called from inside transactions by multiple paths. That, or the
> `withDepartureWrites` boundary that TT1 established for the mirror, is the
> "authoritative" place 20.1 is asking for — and the mirror is the worked
> precedent for exactly this mistake.

---

## DIR-21 — Pricing authority *(was III2 / JJJ1.3)*

**A contradiction in the client's answers. DIR-22 is held on it.**

- *"the operator prices the package and Sawa takes a commission out of it"*
- *"sawa admin change the price — no matter what"*

| Version | Position |
|---|---|
| Operator agrees the retail price; Sawa enters it because operators cannot | administrative data entry — **agency intact** |
| Operator quotes a net rate; Sawa decides the traveller-facing price | buying net, reselling at a margin — **principal** |

"Commission" does not settle it. **Who chooses the number** settles it.

- **21.1** — report what the system permits.
- **21.2** — **do not resolve it by choosing.** Record both statements in the
  legal register, dated, with the reconciliation question stated. The pricing
  route is audited as of this week, so the record will now accumulate evidence
  about the arrangement — the code and the contract should agree before it does.

> **VERIFIED — the code implements BOTH statements simultaneously, so it cannot
> settle the question. That is the finding.**
>
> | | |
> |---|---|
> | **Operators *can* price** | `upsertTourProduct` writes `published_rate`, `break_price`, `base_cost` and `price_tiers`, and is reachable from `POST /api/agency/tour-products`. `validatePriceTiers`' own comment: *"the server charges what this returns."* |
> | **In practice they do not** | **All 14 approved products have `agency_id IS NULL`** — every live listing was created platform-side, and every price on the site is one Sawa entered. Two `listing.submit` events exist (July); neither is a currently-approved agency listing. |
> | **Sawa can override anything** | `POST /api/admin/tour-products/:id/pricing` rewrites the product **and every departure under it** in one request. |
> | **⚠️ The absence of `product.pricing` audit rows proves nothing** | that route was **unaudited until #88 (10 Aug 2026)**. Zero rows is the expected reading of a counter that started this week, not evidence the route was never used. |
>
> So: the permission model supports the agency reading, and **current practice
> is the principal reading** — Sawa chose every number now live. Recorded, not
> resolved, per 21.2.

---

## DIR-22 — Agency structure in the Terms *(was HHH2 / III4)* — **HELD pending DIR-21**

Client's position: Sawa is the **agent**, the operator is the contracting party,
Sawa collects payment **on the operator's behalf**, and the booking confirmation
must say so.

- **22.1** — §15 currently reads as **principal**: *"we will offer, as
  appropriate: an equivalent or comparable alternative, with any price
  difference clearly explained."* An agent's version states what the **operator**
  will do and that Sawa will assist. Identical outcome for the traveller,
  opposite legal posture.
- **22.2** — review the whole Terms for the same pattern. Report every clause
  where Sawa is stated or implied to provide, supply, arrange or stand behind
  the tour. **Expect several** — Terms written before a structure is settled
  default to principal language because it sounds reassuring.
- **22.3** — three things become explicit: the **contracting party** named
  before booking on the departure page (the operator name is shown; the
  statement of **role** is missing); **payment collected on the operator's
  behalf**, which is what makes collecting money consistent with not being the
  organiser; and **the booking confirmation** saying both, or it undoes what the
  Terms establish.
- **22.4** — **propose only.** Client and counsel approve before anything is
  applied. Bundle with DIR-19.2 and DIR-9 — one review, not three.

---

## OOO2 / OOO3 — the interface promises, and what blocks the verification standard

### OOO2 — the rating promise is removed, and it is not scheduled

Two live promises, not one. The OOO1.1 sweep found the second and it was the
stronger:

| Where | Was |
|---|---|
| `site/faq.html` | "You'll see their **name, license status and rating** on every departure." |
| `site/goahead-promise.html` | "References and **traveler reviews are checked**, and **ratings stay visible** on every departure." |

**All three parts of the FAQ sentence were removed, not just the rating.** Name
and licence status render on **0 of 14** departures today, and OOO5's rule is
that copy says what is true rather than what is intended. They are recorded here
as reinstatable once OOO3 lands and an operator record carries those fields —
**the rating is not.** Reviews do not exist, no reviews table exists, and
displaying aggregate consumer ratings carries evidencing obligations for UK and
EU consumers (legal register Q3). Reinstate only with a real review mechanism
and the source of the rating stated.

> Two further hits in `goahead-promise.html` were **HTML comments** documenting a
> *previously removed* fabricated "Verified Operator" card — a named company, a
> licence checkmark, "30 years", "a 4.9 traveler rating", "4,700+ travelers
> hosted". That comment already recorded *"No such operator exists in the
> agencies table"*. **This class has been found before, in a narrower form.**

### OOO3 — `/verification-standard` is blocked on the schema, not only the answer

The client has been asked repeatedly what checks he performs before listing an
operator. **There is nowhere to record the answer.** `agencies` has five
columns: `id`, `name`, `contact_name`, `phone`, `status`. No licence number, no
ETAA registration, no insurance, no expiry, no last-verified date, no evidence
reference.

Even answered tomorrow, **a verification performed and unrecorded is the
`last_verified_at` problem: unrecoverable the moment it is done.**

So the page cannot publish until the table can hold what it describes. **That is
the real dependency and it was not previously identified** — client answer 5 is
now blocked on OOO3.1 as well as on the client.

- **OOO3.1** — propose the schema now, while the table holds one test row. After
  operators sign it is a migration *plus* going back to companies for documents
  that should have been collected at onboarding. Fields mirror what `/verify`
  asks an operator to produce, so the page and the record cannot describe
  different things.
- **OOO3.3** — Capital Travel Service is not in `agencies`. DIR-19.3 makes it an
  operator record; that work now also closes this gap, and **should carry the
  OOO3.1 verification fields rather than being added bare.**

---

## PPP1 — data changes bypass every gate

Full record: [data-bypasses-gates.md](data-bypasses-gates.md).

**16 of 16 product pages carry British spellings — 30 findings.** U4.3 is
enforced on static files and on nothing that reaches the reader from the
database. `server/constants.test.js` iterates `pages()`; `audit:claims` has no
spelling rule at all.

| | |
|---|---|
| **PPP1.1** | scheduled production audit — `audit:claims` + `smoke` against `https://sawa.tours`, reporting findings **and route-count change**. Route count 39 → 41 was the signal production had moved and nothing was watching. |
| **PPP1.3** | done. The two new products were clean on every rule except spelling; the class covers all 16. Package deadline inheritance, price-from-data and GoAhead-from-constants all verified. |
| **PPP1.4** | done — six surfaces write claim-bearing text with no check between the write and the reader, including `blog_posts.tldr`, which has already carried a finding. |
| **The 30 spellings** | a **data** fix, 16 rows in `tour_products`. Proposed as a reviewable script for the client to run, like a migration. **Not applied.** |
| **New client question** | who is adding products in production, and under what process? |
