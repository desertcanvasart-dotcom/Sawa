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
| **DDD1 — evidence expires** | Every finding of the form *"this never happened, because nothing does X"* records what would have to become true for the argument to stop holding, and where that thing is defined. First entry is already known and dated: the BBB1 proof rested on *nothing in the repository lifts a ban*, and **#88 made that premise false on 10 Aug 2026**. Valid for everything before; the audit log answers it from here. |

---

## Client-blocked

| # | Answer needed | Unblocks |
|---|---|---|
| 1 | Support availability this week | 11 of the 14 findings |
| 2 | Post-GoAhead payment model — provisionally gated on legal question 1 | 3 findings, all deposit displays |
| 3 | Failed date: a person follows up, or a link | DIR-9 remainder, Terms alignment |
| 4 | Entity status | DIR-12 threads 2 and 3, JSON-LD `legalName` |
| 5 | Legal questions 1 and 2 to counsel | Payment model, organiser status |
| 6 | Verification checks performed today | `/verification-standard`, and when "verified" may return |
| 7 | Read-only role, `DATABASE_URL_READONLY` | Closes the runtime-`SET` gap (DIR-3) |
| 8 | `PRODUCTION_DB_HOST` | Upgrades the schema check to its strong form |
