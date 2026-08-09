# QQ4 — Migration 023: everything that must be captured at write time

**9 August 2026. Proposal. Nothing built, nothing applied.**

> ## ⚠️ SS3.2 — Merging is not applying
>
> Merging this ships a **file**. It does not touch the database. Someone must
> run the command against production:
>
> ```bash
> DATABASE_URL=<production> npm run db:migrate
> ```
>
> **Until that is run, all of the following remain false:**
>
> - `pledges.cancelled_reason` and `cancelled_at` do not exist
> - the attribution columns do not exist
> - the consent columns do not exist
> - the `blog_posts.status` constraint is not enforced
>
> **Any code written against them before it runs is an outage**, not a bug. This
> is the B5 trap in its exact shape, and it reads as done when it is not.

`pledges` holds **0 rows** — confirmed against production while writing this.
That is the asset, and it is temporary. This document exists so the schema
decisions that depend on it are taken **once, as one piece**, rather than
accumulated after the first booking makes half of them impossible.

---

## The filter — QQ1

A field goes in **only if both hold**:

1. **Capturable only at write time.** It cannot be reconstructed later.
2. **Already committed** in an approved plan. Not anticipated — committed.

Applied honestly, the filter rejects two of the six candidates and admits one on
a different argument. That is reported rather than smoothed over: a filter that
never excludes anything is decoration.

| Candidate | 1. unrecoverable? | 2. committed? | Verdict |
|---|---|---|---|
| `pledges.cancelled_reason` | ✅ | ✅ PP1 | **in** |
| Attribution on `pledges` (D3) | ✅ | ✅ D3 | **in** |
| Consent capture (QQ2.2) | ✅ | ✅ KK5 | **in** |
| `blog_posts.status` CHECK | ❌ | ✅ | **in — constraint hardening**, a different argument entirely |
| Operator verification fields (C2, P4.1) | ❌ | ✅ | **out** |
| Anchor flags on `departures` (D1) | ❌ | ✅ | **out** |

---

## ✅ In

### 1. `pledges.cancelled_reason`

**Why it cannot wait.** `'cancelled'` is one value covering two different
events: *the traveller cancelled* and *the date was cancelled under them*. LL3
spent real effort keeping those apart on the read side. Collapsed at the data
layer, "12 cancellations" means nothing until someone joins `audit_log` to find
out which kind — and `audit_log` records the **departure** being cancelled, not
which pledges were on it at the time.

Added after real bookings exist, the backfill is a guess about which
cancellations were whose choice. It cannot be recovered because it was never
written.

```sql
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
-- NULL is the normal case: a pledge that has not been cancelled has no reason.
-- The constraint therefore permits NULL and constrains only the values.
ALTER TABLE pledges ADD CONSTRAINT pledges_cancelled_reason_chk
  CHECK (cancelled_reason IS NULL OR cancelled_reason IN
    ('traveler', 'date_cancelled', 'minimum_not_reached', 'admin', 'operator'));
```

| value | written by |
|---|---|
| `minimum_not_reached` | `jobs/cancel-unconfirmed.js` `cancelOne()` — the unattended path |
| `date_cancelled` | `POST /api/admin/departures/:id/cancel` — a human cancels the date |
| `traveler` | `DELETE /api/public/departures/:id/bookings/:pledgeId` |
| `admin` | `PATCH /api/admin/bookings/:id` when staff set `cancelled` |
| `operator` | reserved — no path writes it yet, and none should until one exists |

`operator` is declared and unwritten deliberately. Adding a permitted value
later is an `ALTER … DROP CONSTRAINT` plus an `ADD` on a table that will by then
hold real rows; declaring it now costs nothing. **It must not appear in any UI
until something writes it** — an empty category rendered as a filter is the
"coming soon data that renders as if real" the ground rules prohibit.

`cancelled_at` is included because it has the same property: the moment a
booking was cancelled is not recoverable from `created_at`, and `audit_log`
records the departure event rather than the row.

---

### 2. Attribution on `pledges` — D3

**The strongest candidate on the list.** A booking's origin exists for exactly
one instant. Reconstructed afterwards it is not attribution, it is a guess, and
the bookings that most need it are the earliest ones — the evidence the content
programme works *before* there is enough volume to see it in aggregate.

**What already exists**, so this does not duplicate it:

- `pledges.ref_code` — partner/affiliate widget code (`?ref=CODE`), migration 011
- `pledges.source` — how it was created: `admin`, `public`, `public_request`

Neither answers "which article sent this person".

```sql
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS origin_article   TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS first_touch_at   TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS first_touch_path TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS last_touch_at    TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS last_touch_path  TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS referral_source  TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS referral_brand   TEXT;

CREATE INDEX IF NOT EXISTS idx_pledges_origin_article ON pledges(origin_article);
CREATE INDEX IF NOT EXISTS idx_pledges_first_touch    ON pledges(first_touch_at);
```

**Deliberately NOT constrained by a foreign key** to `blog_posts`. An article can
be deleted or its slug changed, and losing the attribution of a real booking
because a post was renamed is worse than a dangling reference. The slug is
recorded as the historical fact it is.

`referral_brand` names the sister brand (Travel2Egypt, Sillage Égypte, Afford
Egypt, Capital Travel Service) where the visit originated. Free text rather than
an enum: the brand list is a commercial fact that changes without a migration,
and a CHECK here would make adding a brand a database change.

#### ⚠️ Personal data — and the blocker is transparency, not consent

Touch paths and timestamps tied to a named booker are behavioural data about an
identified person. The columns may land in this migration. **The writes may not
land until the privacy notice describes the processing.**

**Do not gate attribution behind `marketing_consent`.** They rest on different
lawful bases, and conflating them would be expensive:

| | the processing | basis |
|---|---|---|
| **Attribution** | recording how someone reached the booking they made | incidental to the transaction — no consent flow |
| **Marketing** | emailing them afterwards | consent |

Gating attribution behind a consent flow it does not need would push it past the
early bookings, which are the entire reason for the column.

The dependency is on the **privacy policy revision (RR3)**, which must describe
the processing *before* it happens — not on the consent fields below. Recorded
this way so it points at the right document.

---

### 3. Consent — QQ2.2

Same property as `cancelled_reason`: it exists only at the moment of the write.
Added afterwards, consent cannot be proven for existing rows, and the early
alerts list — the one the content programme depends on — becomes unmailable.

```sql
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent      BOOLEAN;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent_at   TIMESTAMPTZ;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS marketing_consent_text TEXT;
ALTER TABLE pledges ADD COLUMN IF NOT EXISTS lawful_basis           TEXT;

ALTER TABLE pledges ADD CONSTRAINT pledges_lawful_basis_chk
  CHECK (lawful_basis IS NULL OR lawful_basis IN ('consent', 'contract', 'legitimate_interest'));
```

`marketing_consent` is deliberately **nullable, with no default**. Three states
are needed and they must not collapse: *given*, *refused*, and *never asked*. A
`DEFAULT false` would turn every existing row into a refusal, which is a
different claim from having no record.

`marketing_consent_text` stores the exact wording shown at the moment of
consent. This is the part that is genuinely unrecoverable: proving consent means
proving **what** was agreed to, and the copy will change.

**The alerts table (KK5) is not designed here**, per QQ2.2 — but it must carry
the same four fields, and it should be created in the same migration so the two
cannot drift. Its shape is otherwise blocked on KK5, which is later in the order.

These fields gate **marketing**, and nothing else. Attribution has a different
basis and a different blocker — see above.

---

### 4. `blog_posts.status` — **constraint hardening**, not empty-window capture

**It fails test 1**, and I am not going to pretend otherwise: nothing is
captured, and the constraint could be added at any time.

The argument for including it is different, and weaker, so it is stated
plainly:

- The column is unconstrained today, which is why `'published'` and `'draft'`
  sit in `check:status-literals` as `APPLICATION_ONLY` exceptions. Every
  exception in that list is a place the schema is not the authority.
- Production holds **one row, `published`** — verified. The constraint is safe
  now and gets riskier with every post written.

```sql
ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_status_chk
  CHECK (status IN ('draft', 'published'));
```

**Label it constraint hardening, not empty-window capture.** The two arguments
are different and only one of them generalises. A correct change recorded under
the wrong justification is how the next person derives the wrong rule — here,
*"the empty window justifies schema"* rather than *"a constraint gets harder to
add as rows accumulate"*.

With B5 making every migration a manual production action, batching a cheap
constraint into a migration that is already being run has real value. That is
the whole argument, and it is enough on its own.

Genuinely separable if you would rather hold the migration to fields that pass
both tests.

---

## ❌ Out — and why, since both were named

### Operator verification fields (C2, P4.1)

Licence number, ETAA registration, insurance expiry, last-verified date,
founding-partner flag.

**Fails test 1.** Every one of these is a durable fact about a company that can
be entered at any time — a licence number does not stop being knowable. Nothing
is lost by adding the columns the day the operator profile template is built.

They are committed, so they will be needed. They are not *urgent*, and the empty
window is not what makes them cheap.

**One caveat.** `last_verified_at` has a whiff of test 1 about it, because a
verification performed and not recorded is not recoverable. But no verification
is being performed today — P4 has slipped, `/verification-standard` does not
exist, and P1.6's condition was never met. **There is nothing to capture yet.**
Add it with the process, not before it.

### Anchor flags on `departures` (D1)

`is_anchor`, `anchor_month`.

**Fails test 1.** An anchor date is an editorial decision made by an admin, in a
UI, whenever they choose. Marking a departure as an anchor next month records
exactly the same fact as marking it today.

It is committed (D1, P3.5) and it will be needed before content publishes. It
belongs with the admin toggle that sets it, in the migration that ships that
feature.

---

## 🚫 Excluded on principle — QQ3

**No payment schema.** Not deposit state, not transaction records, not refund
state, not gateway identifiers.

This is not a deferral on cost. Legal question 1 asks whether a marketplace
collecting payment for Egyptian tours requires its own Ministry or ETAA
registration. If the answer is that Sawa may not hold the funds, then payment
schema is not merely premature — **it encodes a model that may be prohibited,
and it reads as intent.**

Schema is a statement about what the system is designed to do. A future auditor
reading `pledges.gateway_transaction_id` will not find a comment explaining that
nobody had decided yet.

The empty-table argument is strong and it does not apply here. It is a reason to
capture what cannot be recaptured, not a reason to build ahead of a decision
that has not been made.

**Legal question 1 now gates this migration's boundary as well as answer #3.**

---

## What becomes impossible if this is deferred

| Deferred field | What is lost, permanently |
|---|---|
| `cancelled_reason` | Which cancellations were the traveller's choice and which were Sawa's. Churn becomes unreadable, and the distinction LL3 protects on the read side has nothing behind it. |
| Attribution | Every booking taken before the migration is unattributable — and they are the ones the content programme most needs, because early evidence cannot be recovered from aggregate volume later. |
| Consent | Consent cannot be proven for existing rows. The early alerts list becomes unmailable, which is the list KK5 exists to build. |
| `blog_posts` CHECK | Nothing permanent. Only riskier, one post at a time. |

---

## The migration, and how to run it

**Migration 023.** One file, `server/db/schema_023_write_time_capture.sql`,
registered in `server/db/migrate.js` like every other. Idempotent — `IF NOT
EXISTS` on every column, and the `pg_constraint` guard used by 021 and 022 on
every constraint.

**Migrations do not run on deploy** (B5). After merging, run by hand:

```bash
DATABASE_URL=<production> npm run db:migrate
```

Safe on current data, verified against production while writing this:

- `pledges` holds **0 rows** — every new column and constraint is trivially
  satisfied.
- `blog_posts` holds **1 row**, status `published` — inside the proposed CHECK.

**Nothing writes any of these columns in this migration.** Adding a column and
adding the code that fills it are separate changes, and shipping them together
would mean a schema change and a behaviour change reviewed as one. The write
paths follow, per field, in the work that needs them — and for attribution, not
before the consent fields and the privacy-policy line exist.

---

## SS2 — when this lands, split the question rather than flipping the precedence

`cancelled_reason` closes a real imprecision: a traveller who cancelled their
own booking **before** the date later died currently reads *"this date didn't
reach the four travelers it needed"* — true, but it implies the date's failure
rather than their choice.

**The fix must not be a reversal of LL3's ordering.** One ordering is currently
answering two different questions, and they have different correct answers:

| Question | What decides it |
|---|---|
| **Is this date running?** | The **departure's** status, always. This is LL3 and it must not weaken. |
| **Why is this person not on it?** | The **pledge's** reason, when it has one. |

An implementation that simply asks the pledge first brings LL3's defect back in
a new form: a traveller holding an **active** booking on a cancelled date would
be told about their pledge state instead of the cancellation — which is the
original bug with the polarity reversed.

The shape that works:

```
if departure is cancelled  -> the date is not running   (LL3, unchanged)
     and if the pledge's own reason is `traveler`
         -> add that they had already cancelled, without
            changing what the date's status says
```

Recorded here, while the reasoning is available. **An implementation written
later from a one-line note will collapse the two questions**, because collapsing
them is the shorter code.

---

## What each field is waiting on before anything WRITES it

The columns are independent. The write paths are not.

| Field | Blocked on |
|---|---|
| `cancelled_reason`, `cancelled_at` | nothing — PP5 writes them |
| Attribution | **the privacy policy revision (RR3)** — transparency, not consent |
| Consent fields | KK5's capture flow, and the same RR3 revision |
| `blog_posts` CHECK | nothing — it constrains, it does not capture |

RR3 is one document revision carrying three threads that have each been sitting
as a footnote elsewhere: the Autoura inventory transfer, the controlling entity,
and this. It is in the legal register as an item with a dependency of its own —
the entity naming, which is the client's to report.

## Recommendation

Take all four. If you want the migration to hold only fields that pass both
tests, drop the `blog_posts` constraint — it is the one that does not, and it is
the one that separates cleanly.

**Nothing here is built or applied.**
