# LL4 / KK1.2 — Proposal: the pledge transitions with its departure

**9 August 2026. Nothing built.** This touches the booking path, so it is
written out and left for review.

Four parts. The first is the one that was asked for; the second turned out not
to be a single omission; the third is independent; the fourth is the answer to
"do other job-path writes have the same hole".

---

## 1. `cancelOne()` cancels the pledges with the departure

**Today:** `cancelOne()` sets `departures.status = 'cancelled'`, writes the audit
row, and never touches `pledges`. The traveller is emailed that the booking is
cancelled; the row recording it still reads `confirmed`.

**Proposed**, inside the transaction that already exists:

```js
await c.query("UPDATE departures SET status = 'cancelled' WHERE id = $1", [dep.id]);

// NEW — the seats are released with the date. Not a separate statement in a
// separate place: the row that says a traveller holds a seat and the row that
// says the date is running have to change together or not at all.
await c.query(
  `UPDATE pledges SET status = 'cancelled'
    WHERE departure_id = $1 AND status <> 'cancelled'`,
  [dep.id]
);
```

### ⚠️ The ordering trap

`cancelOne()` computes its recipient list **inside** the same transaction, from
`current.pledges`, filtered on `status !== "cancelled"`:

```js
const recipients = current.pledges
  .filter((p) => p.status !== "cancelled" && p.customerEmail)
```

`current` is read **before** the update, so the list is built from the
pre-update state and survives. But it is one refactor away from being re-read
after, at which point **the cancellation email goes to nobody** — silently, with
`emails sent 0` in the log looking exactly like a date that had no travellers.

The proposal is therefore to compute recipients explicitly **before** the
`UPDATE`, with the reason in a comment, rather than relying on where a variable
happens to have been assigned.

### Why `'cancelled'` and not a new reason column

`'cancelled'` is the only terminal value the CHECK constraint permits, and it
conflates two different things: *the traveller cancelled* and *the date was
cancelled under them*.

That distinction matters to reporting, and LL3 spent effort keeping it on the
read side. Two options:

| | |
|---|---|
| **(A) Use `'cancelled'` now** | No migration. The reason stays recoverable from `audit_log`, which already records `departure.auto_cancel` with the departure id, seats, minimum and deadline. |
| **(B) Add `pledges.cancelled_reason`** | Cleaner. But **migrations do not run on deploy** (B5), so the column would not exist in production until someone ran it by hand, and the code would have to tolerate its absence in the meantime. |

**Recommend (A) now, (B) when reporting actually needs it.** Filed rather than
deferred silently.

### The same change is needed on the admin path

`POST /api/admin/departures/:id/cancel` has the identical gap. A human cancelling
a date leaves its pledges `confirmed` exactly as the job does. Both should use
one helper, so this cannot be fixed in one place and not the other.

### What it repairs

`/api/admin/stats` counts `livePledges` with no departure filter, so a cancelled
date's travellers currently inflate `bookings`, `seatsPooled`, `revenue`,
`depositsDue` and `bookingsThisWeek`, and deflate `cancelledBookings`. All of
those come right without touching the stats endpoint — because they filter at the
pledge level, and the pledge level would then be true.

**The traveller-facing risk is already covered** by the LL3 read guards, which is
why this could wait for review rather than shipping the same day.

---

## 2. The Autoura correction — an OO2 instance, not an omission

`cancelOne()` does not call `emitDepartureSync`, so an auto-cancelled departure
is never corrected in the external system: Autoura keeps it **open, with its
seats, permanently**.

Adding the call to the job would fix that one case and leave the class. Every
write path was enumerated instead. `emitDepartureSync` is called from **nine**
route handlers and from nowhere else, and four writers never reach it:

| Writer | Writes | Mirror learns |
|---|---|---|
| `POST /api/admin/tour-products/:id/pricing` | `UPDATE departures SET published_rate, break_price` for **every** departure of a product | ❌ never — and the payload carries `priceFrom` |
| `POST /api/admin/departure-requests/:id/decline` | `UPDATE departures SET status='cancelled'` | ❌ never — the date stays open in the mirror |
| `PATCH /api/admin/bookings/:id` | `UPDATE pledges SET status`, then `refreshStatus` | ❌ never — `seatsTaken` and `status` both move |
| `jobs/cancel-unconfirmed.js` `cancelOne()` | `UPDATE departures SET status='cancelled'` | ❌ never |

One more is correct, and it is worth naming because of *why*:
`POST /api/public/departure-requests` inserts a `pending_review` departure and
does not sync — which is right, because `buildDeparturePayload()` returns `null`
for `pending_review`. **The payload builder decided, not the caller.** That is
the whole OO2 argument in one line: the invariant held because it was at the
boundary, not because the author remembered.

### Proposed shape

Do not add a fifth call site. Put the sync where a caller cannot skip it —
a `writeDeparture(client, id, fn)` wrapper, or an emit inside the transaction
helper for any statement touching `departures` or `pledges`, so the sync is a
consequence of the write rather than a courtesy from the writer.

Same reasoning as narrowing `loadInventory()` under Y2: **structural
impossibility over correct usage.**

This is a larger change than the rest of this document and touches every write
path, so it is proposed and not applied — consistent with OO2.1.

**If you want the narrow fix first**, adding `emitDepartureSync(dep.id)` to
`cancelOne()` after the transaction commits is one line and strictly better than
today. It should be recorded as a partial under MM2.1 rather than as done.

---

## 3. The `/api/admin/stats` loop guard — independent of everything above

```js
for (const d of deps.rows) {
  const seats = seatsByDep.get(d.id) || 0;
  const min = Math.max(1, d.min_seats || 4);
  if (d.status === "supplier_confirmed") confirmed++;
  else if (seats >= min) readyToConfirm++;
  else { open++; /* … atRisk … */ }
}
```

No status guard. **A cancelled or closed departure is counted as `open`, or as
`readyToConfirm` if it still has seats** — and `atRisk` will flag a cancelled
date whose start is within fourteen days, putting it in front of ops as something
to chase.

Fixing pledge status does not fix this. It needs its own guard:

```js
if (["cancelled", "closed"].includes(d.status)) continue;
if (d.status === "pending_review") continue;   // waiting on a human, not on travellers
```

Better still: `statusFor` from `shared/departure-state.js` — the authority that
now exists — rather than a third hand-written reading of the same rule.

---

## 4. Do other job-path writes have the same hole?

**No — because there are almost no other job-path writes.**

Every write to `departures` or `pledges` outside `server/app.js`:

| File | |
|---|---|
| `jobs/cancel-unconfirmed.js` | the only one that runs unattended — **has the hole** |
| `db/seed.js`, `db/add-package*.js`, `db/set-package-dates.js`, `db/reset-fabricated-inventory.js` | one-off scripts, run by hand against a chosen database |

The one-off scripts do not need the mirror: they are development and migration
tools, and one of them (`reset-fabricated-inventory.js`) exists precisely to
remove rows that should never have been mirrored.

So the hole is one job — but the shape is not "the job forgot". It is that
**the sync is a rule that holds only through one door**, and the job walks
through a different one. Adding a call to the job closes today's instance and
leaves the door.

---

## Recommended order

1. **The stats loop guard** — self-contained, no booking-path risk, and it is
   currently putting cancelled dates in front of ops as at-risk.
2. **`cancelOne` + the admin cancel route**, sharing one helper, with recipients
   computed before the update.
3. **The sync at the boundary** — the largest change, proposed separately under
   OO2.1.

Nothing here is built.
