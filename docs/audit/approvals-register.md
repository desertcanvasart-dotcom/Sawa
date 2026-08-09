# EE1 — Approvals register

**9 August 2026.** Every decision approved from Phase 0 onward, and whether it is
**observable in the deployed system** — verified by fetching production or
reading merged code, never from a commit message or one of my own reports.

**An approval is a representation of work. Only shipped code is the system.**
P1.4 was approved with a stated default action, never happened, and surfaced
five phases later only because a meta description was too long.

A task is not closed until its effect is observable in production.

---

## 🔴 Approved and NOT shipped

### 1. B4 / P3.4 — zero-suppression on the boards

**Approved:** Phase 0 decisions, B4 — *"Build State A/B/C (P3.3) and the
zero-suppression logic (P3.4) **now**, so the board behaves correctly the moment
data lands."*

**Live on production right now:**

```
homepage still shows "Loading…"        : True
homepage still shows "0 more forming"  : True
```

**Never started.** This is the most serious gap in the register, and it is the
same shape as P1.4: approved, given a "do it now", and quietly not done.

It is also a **P3.2 precondition nobody has been counting.** The brief's own
words: *"A departures module showing '0 travellers joined' is worse than no
module."* Seeding real bookings into a board that renders a permanent "Loading…"
and a literal zero is the failure the requirement was written to prevent.

### 2. Section 2 — the founder paragraph

**Approved with `[EXACT COPY]`:**

> Sawa was built by people who have worked in Egyptian tourism since 1993 —
> starting as a guide, then running an agency, now building the thing the
> industry has been missing.

**Verified:** the string "since 1993" appears **nowhere** in the repo.

I removed the "30 yrs operating" statistic as part of the U1 fabricated-operator
card and **never added the replacement**. The instruction was explicitly
*"attribute, don't delete"* — I deleted and did not attribute. The one piece of
this project's history that is true and evidenced is the only claim that ended up
with nothing in its place.

### 3. U4.3 — US English site-wide, and the restored spelling test

**Approved:** *"Existing copy is US… amend 'travellers' to 'travelers' in
anything I have supplied, including previously applied copy. Restore the deleted
test. Do not weaken or drop it."* Ordered *"early in the run rather than last."*

**Verified:** UK spelling still live in `site/goahead-promise.html` and
`site/operators.html`. The deleted assertion has **not** been restored — the only
match in `constants.test.js` is the comment explaining why it was removed.

Never actioned in five subsequent phases.

### 4. Y4 — the legal register

**Approved:** *"Record it in the legal register alongside the entity and
organiser questions."*

**Verified:** no legal register exists. The questions for counsel — marketplace
registration, Package Travel Regulations organiser status, consumer rating
display, and now the Autoura inventory transfer — are scattered across four
audit documents with no single list.

### 5. ⚠️ P1.6 — "verified" should already have come down

**Approved:** *"'Verified' may remain **only** once the verification page in P4.1
is live. **If P4 slips, P1.6 blocks and 'verified' comes down in the meantime.**"*

**Verified:** `/verification-standard` does not exist. P4 has slipped
indefinitely. `/about` still serves "verified Egyptian operators".

**This reclassifies 27 of the 41 remaining findings.** They have been reported —
by me, repeatedly — as *blocked on the client's answer #1*. Under the approval as
written they are **not blocked**: the condition for keeping the word was never
met, so it should have come down while P4 waits.

Answer #1 governs when "verified" may **return**, not whether it may stay.

### 6. W3 — proven-fires retrofit

**Approved:** *"No check may enter `preflight` without a test proving it fires on
a case it should catch… **retrofit it to every check already in the gate**."*

**Partially done.** Every check added *after* W3 was proved. The retrofit to
`check:constants`, `audit:repo-truth` and `smoke`'s pre-W3 assertions was not.

### 7. DD1 / DD2 — this turn's items

DD1's runbook line ("never verify with a shortcut when the tool exists") and
DD2's filing of X4 as its own finding. Both approved this turn, neither written
yet. Listed for completeness rather than as failures.

---

## ✅ Approved and shipped — verified in production

| Item | Evidence |
|---|---|
| B1 — per-product minimum kept, ceiling universal | `min_seats` per product; `MAX_GROUP_SIZE` renders from constant |
| B2 — build-time injection + CI check | `sync-constants.js`, `check:constants` in preflight |
| B5 — migration note in runbook | `docs/RUNBOOK.md` |
| Section 2 — 4.9 rating removed | audit: `rating 0` live |
| Section 2 — "100% guaranteed to run" removed | audit: gone |
| Section 3 — seed operators purged | audit: `seed-operator 0` live |
| Section 3 — "verified" fallback inverted | no record, no badge, all 8 sites |
| P1.2 / P1.3 / P1.5 | live and verified |
| P1.4 — marquee | **shipped only in #63, five phases late** |
| T1–T3, U1–U3, V1, V3, V5, W1, W2, X2, X3, Y1, Y2, Z1, Z3, AA1–AA2, BB1–BB2 | verified at the time; see individual reports |
| DD3 | **open in #63, not yet merged** |

## ⏸ Approved and correctly waiting

| Item | Waiting on |
|---|---|
| U4.1 — availability config | built, `null`, renders nothing — correct |
| P2.1-R … P2.4-R — entity disclosure | entity status |
| AA3 — cancellation copy | AA3.1 |
| BB3 — dry-run wiring | next in order |
| Z2, X1, Y3, U5 | queued in the agreed order |

---

## Why these were missed

Three distinct causes, worth separating:

1. **P1.4 and B4** were approved inside a long decisions document, alongside
   items that generated their own follow-up briefs. Nothing carried them forward
   into a subsequent brief, so they fell out of the order and no check covered
   them. **The register is the fix.**

2. **The founder paragraph** was a *replacement* attached to a *removal*. I did
   the removal in the U1 sweep, where the surrounding items were all deletions,
   and the "and then add this" half did not survive the context switch.

3. **P1.6's "verified"** was not forgotten — it was **misread**. I treated a
   conditional ("may remain only once… if P4 slips it comes down") as a
   dependency ("blocked on P4"). Every subsequent report I wrote repeated that
   reading, including in the last three PR descriptions.

Cause 3 is the one worth dwelling on: the register would not have caught it,
because I would have recorded it as correctly-blocked. It took re-reading the
original wording against the current state.

---

## EE2.2 — Productless destination pages: one, not three

| Page | Products |
|---|---|
| `/destinations/cairo` | ✅ 5 |
| `/destinations/luxor` | ✅ 6 |
| `/destinations/aswan` | ✅ 3 |
| `/destinations/abu-simbel` | ✅ (Aswan → Abu Simbel day tour) |
| **`/destinations/siwa`** | ❌ **none** |

Dahab and the White Desert have **no pages** — they existed only in the homepage
marquee, removed in #63. So EE2's treatment applies to Siwa alone.
