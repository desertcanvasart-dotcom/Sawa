# Latent-defect register

**Created 10 August 2026 (DIR-3).**

A latent defect is a divergence that is real in the code and cannot currently be
reached, because some unrelated invariant is holding it closed. It is not a bug
report — nothing is failing. It is a list of **what would have to change for
something to start failing**, and where that thing is written down.

The failure this prevents: an invariant is relaxed for a good reason by someone
who has no idea what was resting on it. Every entry below is a defect that a
future, correct, well-intentioned change turns on.

Sibling of the [evidence-expiry register](evidence-expiry.md). That one records
**claims** that stop being true; this records **defects** that start being
reachable. Same shape, opposite direction.

## The rule

Each entry records, without exception:

| | |
|---|---|
| **What is divergent** | the defect itself, stated as it would be hit |
| **What masks it** | the invariant currently holding it closed |
| **What would arm it** | the change that makes it reachable |
| **Where that is defined** | the file or migration that would move |

`server/latent-defects.test.js` asserts the shape.

---

### L-1 — A pledge with no seats counts as one traveller

| | |
|---|---|
| **What is divergent** | The hand-written board copies read `Number(x.seats \|\| x.pax) \|\| 1`, so a pledge carrying no `seats` became **one traveller**. The server counts zero. |
| **What masks it** | `pledges.seats INTEGER NOT NULL CHECK (seats >= 1)` — a database row always has a seat count. |
| **What would arm it** | Relaxing that column, or **any in-memory pledge object built without `seats`** — a mapper default, an API payload, an import. The mask is on the *table*, not on the *objects the rule sees*. |
| **Where that is defined** | `server/db/schema.sql`, the `pledges` table |

Closed for the browser by NN2.1's generated `assets/rules.js` and its parity
test, which pins this exact case. Kept because the mask still explains why it
never fired, and because a pledge object is not always a pledge row.

---

### L-2 — A pledge row using `pax`

| | |
|---|---|
| **What is divergent** | The same expression read `x.pax` as a seat count. **`pax` is not a column and never has been.** |
| **What masks it** | Nothing in this system produces a `pax` field. |
| **What would arm it** | An external payload that does — a partner feed, an import, a migration from another system. The reader would be a rule that silently accepts a field the schema has never had. |
| **Where that is defined** | nowhere, which is the point: **this mask is an absence, not a rule**. Nothing enforces it and nothing would report its end. |

---

### L-3 — A stored status trusted instead of recomputed

| | |
|---|---|
| **What is divergent** | A departure stored `minimum_reached` whose bookings were later cancelled. The copies trusted the stored value and called it **confirmed and running**; the server recomputes and calls it **open**. |
| **What masks it** | Every read path enriches. `loadDeparture` calls `enrichDeparture`, which recomputes `status` before anything is served. |
| **What would arm it** | A new query that maps rows directly and presents them — see [DIR-6](boundary-proposal.md), which found this holds through **two doors**, not fourteen sites of discipline. |
| **Where that is defined** | `server/app.js` — `loadDeparture`; `server/domain.js` — `enrichDeparture` |

**⚠️ INVERTED 10 August 2026 by BBBB1, hours after this entry was written.**

The client settled the opposite rule: **once a date reaches GoAhead it runs.** So
the stored value is now *authoritative*, and recomputing downward is the defect.
`minimum_reached` is terminal in both `statusFor` and `refreshStatus`.

The entry stays, because what it revealed outlives it: **the old hand-written
copies trusted the stored value, and were therefore accidentally right about a
policy that did not exist yet.** They were replaced for diverging from the
server, and that divergence was in the server's favour only until the business
rule was decided.

It surfaced as a failing test rather than as an opinion. The NN2.1 parity proof
asserted three known divergences and now finds two, with the reason recorded
there and a new assertion that the case **must** agree — *"a confirmed date that
dropped below its minimum is diverging again — the BBBB1 ratchet is gone."*

**The severe failure is now the mirror of what this entry described.** It was: a
cancelled date shown as running. It is now: **a confirmed date shown as forming,
or cancelled by the unattended job** — which it could be, until BBBB4 fixed it.

---

### L-4 — `cancelled_reason` precedence

| | |
|---|---|
| **What is divergent** | Two questions share one field: *is this date running* and *why is this person not on it*. Answering them in the wrong order tells a traveller with an active booking on a cancelled date about **their pledge state** instead of the cancellation. |
| **What masks it** | Nothing writes `cancelled_reason`. The columns exist — 023 was applied on 10 Aug 2026 — and no code path fills them. |
| **What would arm it** | **The first write.** Departure status must be asked first, always; pledge reason second, when it has one. Collapsing them is the shorter code, which is why this is written down. |
| **Where that is defined** | `server/db/schema_023_write_time_capture.sql`; [DIR-4](payment-window-and-hold.md) |

---

### L-5 — The mirror is complete but not reliable

| | |
|---|---|
| **What is divergent** | Nothing reconciles Sawa against Autoura. A departure whose sync exhausted its retries stays wrong in the partner system indefinitely. |
| **What masks it** | Nothing. **This one is not masked — it is simply not yet reachable at scale**, because no traveller data exists. Its own module says so: *"This does not reconcile anything. The mirror is complete after TT1; it is not reliable."* |
| **What would arm it** | Volume. `syncDivergences()` remembers at most **50** divergences, **in memory, since boot** — so the count that `/api/modes` reports is a floor, and a restart sets it to zero. |
| **Where that is defined** | `server/autoura-sync.js` — `MAX_REMEMBERED = 50`, `recordDivergence` |

Listed here rather than in the evidence register because the defect is the
absence of reconciliation, not a claim about it.

---

### L-6 — The read-only auditor connection is defeatable

| | |
|---|---|
| **What is divergent** | `default_transaction_read_only=on` is a **session setting**, not a permission. |
| **What masks it** | Nothing in the audit tooling issues a `SET`. |
| **What would arm it** | One `SET default_transaction_read_only = off`, anywhere on that connection. The module's own header says so. |
| **Where that is defined** | `server/db/readonly.js`. Closed properly only by a least-privilege role — **client item, outstanding** |

---

### L-7 — Audit coverage is per-route, not per-write

| | |
|---|---|
| **What is divergent** | `check:audit-coverage` reads route handlers. A state change made inside a job, a helper or a one-off script is invisible to it. |
| **What masks it** | The scheduled job happens to audit itself, and the operator scripts are run by hand by one person. |
| **What would arm it** | A second person, or a script that runs unattended. `server/db/reset-fabricated-inventory.js` **deletes rows and writes no audit row.** |
| **Where that is defined** | `scripts/audit-coverage.js`; the eleven `server/db/*.js` operator scripts |

---

### L-8 — The US English standard reaches only files in git

| | |
|---|---|
| **What is divergent** | `constants.test.js` iterates `pages()` — static files. **All 16 product descriptions come from the database and have never been checked**, and 30 British spellings are live. |
| **What masks it** | Nothing. This one is **already armed and firing**; it is here because the mechanism that would catch it does not reach the surface that produces it. |
| **What would arm it** | Already armed. What would *worsen* it: the content programme, which writes into the same unchecked surface at volume. |
| **Where that is defined** | `server/constants.test.js`; [PPP1](data-bypasses-gates.md). Held pending [QQQ1](open-directives.md). |

---

### L-9 — Two implementations of the referral code rule

| | |
|---|---|
| **What is divergent** | `server/app.js`'s `cleanRefCode` and `src/main.jsx`'s `cleanRef` are the same rule under two names. A code generated client-side and cleaned server-side by separate implementations can disagree, and a partner's attribution is a commission. |
| **What masks it** | They currently agree. |
| **What would arm it** | Either being edited. **The derived duplication catalogue cannot see this**, because neither is in `shared/` — it answers *"is an authority being copied"*, not *"is this thing an authority"*. |
| **Where that is defined** | `server/app.js:322`; `src/main.jsx:2286`; the limit is recorded in [invariant-doors.md](invariant-doors.md) |

---

## Closed, kept as worked examples

Removing these would lose the reasoning that makes the live entries legible.

| | What masked it | Closed by |
|---|---|---|
| **`check:status-literals` could not read `CHECK (col IS NULL OR col IN (…))`** — correct for the forms it knew, silently incomplete for one it did not, hiding five permitted values | no migration used that form until 023 | the parser now reads both shapes |
| **Five static pages carried a pre-fix `tourSlug`** emitting a 301 loop for a title that slugifies to nothing | **every live title happening to contain a non-stop-word ASCII token** — enforced nowhere | DIR-8; one authority, one generated file, `check:slug` |
| **Instructions that were wrong when written.** `server/slug.js`'s header asked the next person to keep the copies in sync and named **three of nine** | — following it correctly still left six stale | DIR-8 |
| **A table created after 024 has no RLS.** 024's `REVOKE` carries forward via `ALTER DEFAULT PRIVILEGES`; **RLS does not** | 024 was the most recent migration for three days | 026 enables it on itself; a test asserts every later table does |
| **`consent.js` dropped a throwing consent listener**, so consent could be granted and the thing it grants never happen | the listeners did not throw | AAA1 fix; the scanner's roots now include `site` |
