# PP4 / OO2.1 — Moving the mirror to the boundary

**9 August 2026. Proposal. Nothing built.**

`emitDepartureSync` is called from **nine route handlers and nowhere else**.
Four writers change a departure and never reach it, and one is correct **by
accident of what the payload builder does rather than by anything the caller
decided**.

That last one is the whole argument, so it goes first.

---

## The case that settles it

`POST /api/public/departure-requests` inserts a departure and does not sync.
**That is right** — the row is `pending_review`, and:

```js
export function buildDeparturePayload(inventory) {
  const dep = inventory;
  if (!dep || dep.status === "pending_review") return null;   // <- here
```

The **payload builder** decided. The route author did not — and could equally
have added a sync call that would have been silently discarded, or omitted one
for a status that *should* have been mirrored, and nothing would have told them
either way.

Four callers got this wrong. The one that got it right did so without knowing.
That is not a set of omissions to be patched one at a time; it is a rule that
holds through one door.

---

## Where it is missed today

| Writer | Writes | The mirror is told |
|---|---|---|
| `POST /api/admin/tour-products/:id/pricing` | `published_rate`, `break_price` on **every** departure of a product | ❌ never — and the payload carries `priceFrom` |
| `POST /api/admin/departure-requests/:id/decline` | `status = 'cancelled'` | ❌ never — the date stays **open** externally, forever |
| `PATCH /api/admin/bookings/:id` | pledge status, then `refreshStatus` | ❌ never — `seatsTaken` **and** `status` both move |
| `jobs/cancel-unconfirmed.js` `cancelOne()` | `status = 'cancelled'` | ❌ never — the unattended path |

Two of these leave an **externally advertised departure that Sawa has cancelled**
sitting open in a partner system indefinitely. There is no reconciliation job and
no expiry: the only correction the mirror ever receives is one Sawa sends.

---

## The proposal

### 1. The sync becomes a consequence of the write, not a courtesy from the writer

Every write to `departures` or `pledges` already happens inside
`withTransaction`. Add a transaction wrapper that records which departures were
touched, and emits **once per departure, after commit**:

```js
// server/db/index.js
export async function withDepartureWrites(fn) {
  const touched = new Set();
  const result = await withTransaction((c) => fn(c, (id) => touched.add(Number(id))));
  // After COMMIT, never inside it. A mirror told about a row that then rolled
  // back is worse than one told late.
  for (const id of touched) emitDepartureSync(id);
  return result;
}
```

Callers mark the departure they changed rather than remembering to sync it. The
mark is next to the write, in the same statement's scope, which is the one place
it cannot be forgotten without the write also being wrong.

**Why not emit inside the transaction:** a rollback after the emit tells the
mirror about a state that never existed, and `emitDepartureSync` is
fire-and-forget with retries — there is no way to recall it.

**Why not a database trigger:** it would be the most airtight option and it is
rejected for a specific reason. Triggers do not run through `migrate.js` review,
they fire for the one-off scripts in `server/db/` too — including
`reset-fabricated-inventory.js`, which exists to remove rows that should never
have been mirrored — and B5 means the trigger and the code could disagree in
production for as long as nobody runs the migration.

### 2. A write that should NOT sync is expressed once, and out loud

This is the part PP4 asks for specifically, because today it is invisible.

**Today:** `buildDeparturePayload` returns `null` for `pending_review`. The
decision is real, correct, and buried in the builder, where no caller can see it
and no test names it.

**Proposed:** the rule moves to one exported predicate with the reasons attached,
and the emitter consults it:

```js
// server/autoura-sync.js
//
// Every reason a departure is NOT mirrored. One list, stated, testable.
// The alternative is what exists now: the knowledge lives inside the payload
// builder, and a caller cannot tell a deliberate silence from a forgotten call.
export const NOT_MIRRORED = {
  pending_review: "traveller-requested and not yet approved by ops — it is not "
    + "inventory until a human says so, and a partner must not be able to sell it",
  // Add a reason, or do not add the status. An entry with no reason is how the
  // next person learns the wrong general rule.
};

export function mirrorDecision(departure) {
  if (!departure) return { mirror: false, reason: "no such departure" };
  const withheld = NOT_MIRRORED[departure.status];
  if (withheld) return { mirror: false, reason: withheld };
  return { mirror: true };
}
```

Three things follow that do not follow today:

1. **A deliberate silence is distinguishable from a forgotten call.** The emitter
   logs `[autoura-sync] #123 withheld: <reason>` rather than doing nothing.
   Today both look identical — which is to say, both look like nothing.
2. **A cancelled departure IS mirrored**, and must be. It is not on the list.
   That is how the partner system learns the date is off, and it is the
   correction that has never been sent.
3. **The list is testable.** A test can assert that every status the schema
   permits is either mirrored or has a stated reason not to be — the same shape
   as `check:status-literals`, where the schema is the authority and the code is
   the consumer.

### 3. What the four missing writers get

| Writer | After |
|---|---|
| pricing | marks every departure it repriced |
| decline | marks the declined departure — and it **is** mirrored, so the partner learns it is off |
| booking status change | marks the departure whose seat count moved |
| `cancelOne()` | marks it inside the existing transaction, which is where PP5 already put the pledge transition |

---

## What this does not fix, and should be said

**Nothing reconciles.** If a sync fails all three retries, `postWithRetry`
returns `false`, the failure is a `console.warn`, and the two systems are
divergent with nothing scheduled to notice. Moving the emit to the boundary makes
the mirror *complete*; it does not make it *reliable*.

That is a separate piece of work — a periodic reconciliation, or at minimum a
recorded outbox with a retry — and it should not be folded into this change. It
is noted here so "the sync is at the boundary now" is not read as "the mirror is
correct now".

**This is also a live-egress change.** `/api/modes` confirmed `autoura: on` on
9 August, so this proposal increases what leaves the system: four write paths
that currently transmit nothing would begin transmitting. The payload is
inventory only — route, type, dates, city, seat counts, status, price — and Y2
narrowed `loadInventory` so pledge rows never reach the builder. No new **field**
crosses the boundary. But more **events** would, and legal register #4 is open on
exactly this transfer.

**Recommendation:** land the boundary change and the withheld-list together, and
treat the increase in transmitted events as something to note in the privacy
policy revision (RR3), which is already open and already covers this transfer.

---

## Order within this piece

1. `mirrorDecision` + `NOT_MIRRORED`, with the test that every schema status is
   accounted for. No behaviour change — it only makes the existing decision
   visible.
2. The transaction wrapper, and the four writers marking their departures.
3. Reconciliation — **separate**, later, and not implied by either of the above.

Nothing here is built.
