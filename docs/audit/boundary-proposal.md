# DIR-6 — Move the normalisation to the boundary

**Proposal, 10 August 2026. Nothing applied.** It touches every read path, which
is exactly why it is a proposal.

---

## First, a correction to the DIR-5 entry

DIR-5 recorded that *"a departure served to a client has been normalised"* holds
through **caller discipline**, because `presentDeparture(enriched, user)` names
its parameter `enriched` and spreads whatever it is given.

That is true about the function and **overstated about the risk.** Traced
properly:

| | |
|---|---|
| `presentDeparture` call sites | **14** |
| Sites whose departure came from `loadDeparture` | 13 — and `loadDeparture` **enriches internally** (`app.js:200`) |
| Sites that enrich explicitly | 1 — the bulk list at `app.js:545` |
| Paths that reach `presentDeparture` un-enriched | **none, today** |

`mapDeparture` — the thing that produces an un-enriched departure — is called in
exactly **three** places, and two of them wrap it in `enrichDeparture` on the
same line.

So the defect is **latent, not live.** The invariant holds through two doors
rather than through discipline spread across fourteen sites. That is a materially
better position than DIR-5 stated, and worth correcting before anyone plans work
against the worse version.

**What would arm it:** a fifteenth call site whose departure comes from a new
query that maps rows directly. Nothing detects that — the response would simply
be missing `status`, `livePrice`, `confirmDeadline`, `breakPrice`,
`depositPercent` and `type`, and every consumer would read the absence as data.

---

## The worked precedent, and the distinction it draws

Y2.1 narrowed `loadInventory()` so the mirror's payload builder never holds a
pledge:

> *"A field added here cannot leak a traveller's details because those details
> are not in scope — structural impossibility rather than a guard that has to
> keep being right."*

`withDepartureWrites` is the other half of the lesson, and its own header is
honest about which it achieved:

> *"a caller still has to call `touch`. This is a detector, not a structural
> impossibility."*

**Every proposal below states which of the two it achieves.** That is the whole
point of the distinction: a detector that is described as an impossibility is
worse than either, because it stops being watched.

---

## The options

### A — Guard inside `presentDeparture` · **detector**

Throw if the object lacks the fields enrichment adds.

Cheap, and it fails on the first request rather than serving a half-response
forever. But it is a run-time failure on a live path, and it can be satisfied by
an object that happens to carry the right keys.

### B — Fold enrichment into `mapDeparture` · **impossibility, and it does not fit**

If `mapDeparture` always enriched, no un-enriched departure would exist.

**It does not fit.** `enrichDeparture(departure, product)` needs the product row
for the confirm deadline and the price; `mapDeparture` has only the departure and
its pledges. Threading the product through would push a database concern into a
pure mapper — and `autoura-sync.js` deliberately maps and enriches separately,
for the Y2.1 reason.

Recorded because it is the obvious idea and the reason it fails is not obvious.

### C — Brand the enriched object, and refuse anything unbranded · **recommended**

`enrichDeparture` attaches a non-enumerable symbol; `presentDeparture` throws
without it.

> **What it achieves:** not structural impossibility — a determined caller could
> attach the symbol. It makes the mistake **impossible to make by accident**,
> which is the realistic threat: the fifteenth call site written in good faith by
> someone who did not know enrichment existed.

Non-enumerable so it never reaches JSON, and a symbol so no spread or
`JSON.parse(JSON.stringify(...))` round-trip carries it — a departure that has
been through the wire is correctly *not* branded.

Cost: one line in `enrichDeparture`, one in `presentDeparture`, and a test.

### D — Return presentable objects from the data layer · **impossibility, and too large**

`loadDeparture` returns something already shaped for a client.

Genuinely closes it, and touches every read path plus the mirror, which needs the
*un*-presented shape. **This is the change DIR-6 was written to be cautious
about.** Not recommended now.

---

## Recommendation

**C**, plus keeping A's error message as the failure text.

It converts "the caller must remember" into "the caller cannot do it by
accident", costs three lines, and is reversible. **It is a detector with a very
high floor, not an impossibility, and the header must say so** — that is the
lesson `withDepartureWrites` already paid for.

**D is the right end state** and should wait until something else forces the read
paths open. Doing it now would be a large diff whose only visible effect is that
a defect nobody has hit stays un-hit.

---

## What this does not address

`presentDeparture` also decides **what a given user may see** (`viewPledges`).
That is a second invariant through the same door, and a stronger one: getting it
wrong exposes traveller names, emails and phone numbers rather than omitting a
price.

It is *not* in this proposal because it deserves its own, and because branding
the enrichment does nothing for it. **Recorded here so the omission is a decision
rather than an oversight.**
