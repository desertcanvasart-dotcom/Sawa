# MMM1 — Do any operator records exist?

**Established 10 August 2026, against production. Rendered output, not schema.**

> ### ⚠️ The snapshot moved while this was being written
>
> Approved products went **14 → 16** within the hour — day tours 11 → 12,
> packages 3 → 4 — as the client added *Full Day Minya Archaeological Tour* and
> *Fayoum Oasis, Meidum & Hawara Pyramids*. Every count below is restated for 16
> and re-verified, not scaled.
>
> **The conclusions are unchanged: 0 of 16 products have an agency attached, and
> 0 of 16 name a company.** This is [OOO4](evidence-expiry.md) demonstrating
> itself — a snapshot is a fact about a moment, and this one aged in sixty
> minutes.

**Validity window (DDD1):** every number here is a reading taken on 10 Aug 2026.
`agencies` holds one row and `departures` holds none; both change the moment an
operator signs or a date is created. Recorded as [E-11](evidence-expiry.md).

**This is not a finding against the client.** He has said companies are
interested but not signed. It needs establishing as a fact rather than inferred
from a `NULL`, and that is what this is.

---

## The short answer

**No listed product has an operating company attached, and the site promises
three things per departure that no departure shows.**

---

## 1. What exists in the data

| | |
|---|---|
| `agencies` rows | **1** — `ag_6`, name **"adham"**, contact "Islam", **no phone**, status `active` |
| `app_users` linked to an agency | 1, `agency_owner`, active |
| Approved products with an agency attached | **0 of 16** |
| `departures` rows | **0**, of any status |

The one agency record is a first name with no phone number. Whatever it is, it
is not a signed operating company.

### 1.1 — The schema could not record a licence even if one existed

`agencies` has exactly five columns: `id`, `name`, `contact_name`, `phone`,
`status`.

**There is no licence field, no ETAA registration number, no insurance record
and no expiry date.** `tour_products` carries only `agency_id` and
`operating_days`.

The verification standard on `/verify` says: *"You'll need a current Ministry of
Tourism license, ETAA registration, valid insurance, and a track record we can
check."* **There is nowhere to put the answer to any of those four.**

---

## 2. What the site renders

The claim is served on **11 pages**, in strong and specific terms:

| Page | Rendered |
|---|---|
| `/` | "Sawa pools travelers from **Ministry-licensed Egyptian operators**" |
| `/how-it-works` | "**Every operator on Sawa is registered** with the Egyptian Ministry of Tourism & Antiquities and registered with ETAA **before a single departure goes live**" |
| `/goahead-promise` | "the tour is always run by a real local operator licensed by the Ministry of Tourism" |
| `/about` | "Every operator is licensed by the Ministry of Tourism and registered with ETAA" |
| `/itineraries` | "operated by an Egyptian travel company licensed by the Ministry of Tourism and registered with ETAA" |
| every product page | the same generic sentence — **16 of 16** |
| footer, sitewide | "Operated by **Capital Travel Service** · ETAA 2179" |
| `/terms` | names Capital Travel Service, ETAA 2179, registered office, and defines "Operating Partner" |

### 2.1 — The one that is checkably false

`/faq`, answering *"Who runs the actual tour?"*:

> An operator registered with the Egyptian Ministry of Tourism & Antiquities and
> with ETAA — never a freelancer or an unregistered guide. **You'll see their
> name, license status and rating on every departure.**

Checked across **all 16 product pages**:

| Promised | Rendered |
|---|---|
| their **name** | **0 of 16** — every page carries the generic sentence with no company named |
| **license status** | **0 of 16** — no field exists to hold it |
| **rating** | **0 of 16** — no reviews table exists (legal register Q3) |

**Three promises, none of them kept on any departure.** No operator profile route
exists either: `/operator/adham`, `/operators/adham`, `/agencies` and
`/verification-standard` all return 404.

---

## 3. Is the generic claim true?

**"Operated by an Egyptian travel company licensed by the Ministry of Tourism and
registered with ETAA"** — 16 of 16 product pages.

It is **plausibly true and entirely unrecorded.** The footer and Terms name
Capital Travel Service, ETAA 2179, and DIR-19.3 anticipates CTS becoming an
operator record. If CTS operates all 16 products, the sentence is true in fact.

But:

- **Nothing in the system records it.** No product is linked to any agency, and
  CTS is not in the `agencies` table at all — the only row is "adham".
- So the claim rests entirely on an arrangement held outside the system, exactly
  as MMM2.1 says the pricing arrangement does.
- **It cannot be verified by anyone, including Sawa**, from the data.

---

## 4. What this changes

| | |
|---|---|
| **The trust articles** | are built on the operator being named before booking. Today no operator is named on any departure, so the content programme cannot cite what a reader would see. |
| **The verification standard** | describes four checks and the system can record none of them. Publishing `/verification-standard` (currently 404) would document a process with no output. |
| **DIR-18 payment copy** | tells a traveller who they are paying. MMM2 asks whose number the price is; **this asks who the counterparty is.** Neither is currently recorded. |
| **DIR-22** | §22.3 requires "the contracting party, named before booking". **There is no contracting party in the data to name.** |

---

## 5. A gap in the claims auditor

`audit-claims.js` did not flag the FAQ promise, and could not: its rules test
for **unevidenced assertions in text**, not for **a promise about a UI element
that does not exist**. "You'll see their name" is a claim about the product's
own behaviour, and nothing checks those against the product.

Feeds NNN1.2. A rule of the form *"copy that promises the traveller will see X"*
→ *"assert X renders"* would have caught this on the day it was written.

---

## Recommended, not applied

1. **Do not publish `/verification-standard`** until there is somewhere to record
   a verification result.
2. **The FAQ sentence needs correcting now** — it is the only one of the eleven
   that describes a thing the traveller can immediately check and find absent.
   Suggested, pending the client: *"You'll see the operating company named on
   your booking confirmation."* — but only once that is true.
3. **The `agencies` table needs the fields the verification standard implies**
   before the first operator signs. Same argument as migration 023: cheap while
   the table holds one test row, awkward afterwards.
4. **CTS should become an operator record** (DIR-19.3) so the generic sentence
   has something behind it.

---

## A measurement that disagreed with itself

Re-checking after the count moved, a second script reported **16 of 16 pages name
a company** — flatly contradicting the first reading of 0.

The second script did not strip `<script>` blocks, so it was matching the inlined
JSON-LD and bootstrap payload rather than the copy. **It was measuring JSON and
calling it prose.**

`audit-claims` already has a `visibleText` helper for exactly this reason — its
comment reads *"script and style content is not copy"*. The first measurement
stands; the second was wrong, and is recorded rather than quietly dropped
because two measurements that disagree mean one of them is wrong and the
interesting question is which.
