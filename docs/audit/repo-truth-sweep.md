# V5 — Repo-truth sweep

**8 August 2026.** Inverts the method that failed four times. Instead of starting
from a public claim and asking whether it is true, this starts from statements
the builders wrote about what the system does, and asks which public claims they
bear on.

Collected by `node scripts/audit-repo-truth.js` across `server/`, `src/`,
`scripts/`, `docs/`, `site/` and `.env.example` — code comments, migration notes,
markdown and env documentation. **5 statements** met both filters (a build-truth
signal *and* a topic the public site claims).

Register: `docs/audit/repo-truth-register.json`. Verdicts are keyed by a hash of
the statement text, so re-wording one forces a fresh review rather than
inheriting the old verdict.

---

## The most important result is a negative one

`docs/STATUS.md:12` says email is in **log-mode**. **It is not.** Production has
been delivering since 6 August 2026.

| `email_log` | |
|---|---|
| `logged` | 26 rows, all on or before **24 Jul 2026** |
| `sent` | 1 row, **6 Aug 2026** |
| non-sent rows after the first successful send | **0** |

Had I trusted that statement as ground truth — which is what V5 was set up to do
— I would have reported that booking confirmations are never delivered. That
would have been confidently wrong, and it is the same failure mode as trusting
the source: **an internal statement is a lead, not ground truth.** Each one here
was verified against runtime or database evidence before a verdict was recorded,
and the script's own header now says so.

(The 14 logged `booking_confirmation` rows belong to test bookings since purged —
`pledges` is empty — so no real traveller went without a confirmation.)

---

## Findings

| Verdict | Statement | Bears on |
|---|---|---|
| **AGREES** | `server/domain.js:160`<br>pending_review: traveler-requested, not yet approved by ops — never… | — |
| **CONFIRMED** | `docs/production-readiness/10-decisions-needed.md:10`<br>Right now deposits are shown but not *collected* online. Do you want real payment collection (card/Fawry/etc.) in this build, or do agencies keep sett… | the deposit displays inventoried in V1.3 |
| **CONTRADICTS** | `docs/PACKAGES_ASSESSMENT.md:37`<br>The unique value of Sawa is **pooled pricing**: when multiple small agencies (or direct travellers) book seats on the same day tour, the **price per p… | the corrected GoAhead model (B1) and the removed guarantee language |
| **STALE** | `docs/STATUS.md:12`<br>Phase 5 — Email** | Invite, booking-confirmation, GoAhead, cancellation. Log-mode; real delivery one env var away. |… | — |

## Detail

### AGREES — `server/domain.js:160`

> pending_review: traveler-requested, not yet approved by ops — never

pending_review departures are excluded from the anonymous bootstrap payload and from buildBody. Verified in rendered output: no pending_review row reaches a public surface.

### CONFIRMED — `docs/production-readiness/10-decisions-needed.md:10`

> Right now deposits are shown but not *collected* online. Do you want real payment collection (card/Fawry/etc.) in this build, or do agencies keep settling payment off-platform for now? *(Adds significant scope and compliance if in.)*

Duplicate of the PRODUCTION_READINESS_ASSESSMENT statement, in the decisions register.

### CONTRADICTS — `docs/PACKAGES_ASSESSMENT.md:37`

> The unique value of Sawa is **pooled pricing**: when multiple small agencies (or direct travellers) book seats on the same day tour, the **price per person drops automatically** as the group grows. When the group hits a minimum (currently hard-coded to **4 sea

Says the minimum is 'hard-coded to 4 seats' and the tour is 'guaranteed to run'. Both are wrong now: min_seats is per product with a floor of 4 (schema_022), and 'guaranteed' was removed sitewide under P1.5. Internal strategy doc, not public — no live claim depends on it, but it is the document a writer would reach for.

### STALE — `docs/STATUS.md:12`

> Phase 5 — Email** | Invite, booking-confirmation, GoAhead, cancellation. Log-mode; real delivery one env var away. |

Says email is in log-mode. It is NOT: email_log shows 26 'logged' rows all dated on or before 24 Jul 2026, one 'sent' on 6 Aug 2026, and ZERO non-sent rows after that. Delivery is live in production. Had this been trusted as ground truth it would have produced a confident false report that confirmation emails are not delivered. The 14 logged booking_confirmations belong to test bookings since purged — pledges is empty — so no real traveller is affected.


---

## What this changes

Nothing was fixed under V5 — it is a reporting task. The two actionable items:

1. **`docs/PACKAGES_ASSESSMENT.md:37`** states the minimum is "hard-coded to 4
   seats" and the tour is "guaranteed to run". Both are now wrong, and it is an
   internal strategy document — the kind a writer reaches for when drafting.
   Correcting it is cheap and prevents the corrected model being un-corrected by
   someone reading it in good faith. **Needs approval.**

2. **`docs/STATUS.md:12`** is stale and should say email delivery is live.
   **Needs approval.**

Neither contradicts a live public claim, which is the honest headline: the two
serious contradictions this method was built to find — the Terms comment and the
payments note — had already been found and actioned under V1 and U3.

## What it did not find

No further statement of V1's severity. The sweep covered the categories asked
for, with one gap: **commit messages** are not scanned. `git log` is not part of
the working tree and a claim recorded only in a commit message is not something
a future audit can be expected to read. Flagged rather than silently skipped.

---

## Standing check (V5.4)

`node scripts/audit-repo-truth.js` fails when a build-truth statement appears
that nobody has reviewed. Wired into `npm run preflight`.

**One bug worth recording:** the first version used `fs.globSync`, which does not
exist on Node 20 — the version `npm test` runs. It returned **zero findings and
exited 0**. A check that silently passes is the exact failure class this project
keeps finding, so the walker is now `readdirSync`-based, verified to return
identical results on Node 20 and Node 22, and `collect()` throws rather than
returning empty if it finds no source files at all.
