# CCCC — Don't hedge the number. Pin it.

**10 August 2026.** The hedge is withdrawn. Both branches are prepared. **Nothing
is applied and BBBB5/BBBB6 are held.**

---

## CCCC1 — the hedge is withdrawn, and the objection was sharper than I put it

Accepted in full. *"Its minimum — usually four"* solves a data problem with
words, and spends the clearest sentence on the site to do it.

**And there is a fact I should have surfaced when I proposed it: the site already
says "four" flatly, in eight places.**

| | |
|---|---|
| `site/departures.html` | *"when four travelers commit, the trip is confirmed"* |
| `site/about.html` | *"the minute four people commit to the same date"* |
| `site/about.html` | *"Below four it's a plan — at four it's a trip."* |
| `site/goahead.html` | *"A date reaches GoAhead when four travelers have joined it."* |
| `site/goahead-promise.html` | meta description, ×2 |
| `site/goahead-promise.html` | *"Payment only becomes due when four travelers confirm the same date"* |
| `site/goahead-promise.html` | *"Every date has a deadline to reach four travelers"* |
| `site/how-it-works.html` | *"Four travelers, and it's confirmed for everyone."* |

So the hedge was not a cautious choice about one new sentence. **It would have
introduced vagueness into copy that has been specific since the site existed** —
and the only reason the L-10 coincidence looked like a copy problem is that I
found it while writing copy. It is a data problem, and it has a data fix.

---

## CCCC2 — the question for the client

> **Does Sawa ever want a product requiring more than four travellers to run?**

Put in that form, not inferred from the data. All 16 approved products hold 4
today; that is the coincidence, not the answer.

### Two findings that make the question sharper than it looks

**1. The code already knows four is the promise, and permits five to twelve anyway.**

`server/app.js` validates `minSeats` as a **range**:

```js
minSeats: z.coerce.number().int().min(MIN_GROUP_SIZE).max(MAX_GROUP_SIZE)  // 4..12
```

and its own error message reads: *"Minimum group size is 4 travellers — **what
the booking conditions promise a departure confirms at**."*

The validator names four as the promise and then enforces it only as a **floor**.
A product at six passes every check in the system and breaks every sentence in
the table above. **That is the whole defect, stated by the code itself.**

**2. There are two `min_seats` columns, and the one that decides is not the obvious one.**

```js
export function goAheadSeatsFor(item) {
  return Math.max(1, Number(item?.minSeats || item?.min_seats || DEFAULT_GO_AHEAD));
}
```

It is called with a **departure**, not a product. `departures.min_seats` is a
separate column with its own default. Pinning `tour_products` alone would leave
the number that actually decides confirmation unconstrained — **and would read,
to anyone auditing later, as though the question had been settled.**

### A naming divergence, reported rather than quietly fixed

The directive says `min_travellers`. **No such column exists.** It is `min_seats`,
on both `tour_products` and `departures`. Migration 027 uses the real names;
flagged here per DIR-8 in case the intended change was a rename as well.

---

## CCCC2.1 — if the answer is NO: prepared and verified

**`server/db/schema_027_pin_group_minimum.sql`** — proposed, **not applied** (B5).
`CHECK (min_seats = 4)` on **both** tables.

**Safe to apply today if approved:** all 16 approved products hold 4, and
`departures` holds no rows at all, so nothing existing violates it.

### Verified against an ephemeral Postgres 17 cluster

Full `schema.sql` plus all 27 migrations, then:

```
control — these MUST be accepted, or the check proves nothing:
  tour_products min_seats = 4      ACCEPTED  ✓
  departures    min_seats = 4      ACCEPTED  ✓
the constraint — these must be rejected:
  tour_products min_seats = 6      REJECTED by "tour_products_min_seats_pinned"  ✓
  tour_products min_seats = 2      REJECTED  ✓
  departures    min_seats = 6      REJECTED by "departures_min_seats_pinned"     ✓
  UPDATE an approved product to 6  REJECTED by "tour_products_min_seats_pinned"  ✓
  UPDATE a live departure   to 5   REJECTED by "departures_min_seats_pinned"     ✓
idempotent: re-ran 027 cleanly ✓
```

Cluster destroyed afterwards. **`ALTER TABLE ... ADD CONSTRAINT` validates
existing rows**, so if production held a row at six the migration would fail
rather than silently accept it.

### The first run of this verification was vacuous, and it is worth recording

The cluster failed to start — a missing `LANG=C`, then a redirect that created a
file inside the data directory before `initdb` ran. My first harness treated any
non-zero exit as `REJECTED`, so **six connection failures rendered as six clean
constraint rejections.** A dead database looked exactly like a working
constraint.

It was caught by the **control cases** — `min_seats = 4` also read `REJECTED`,
and that is impossible if the constraint is working. DIR-14's class, in a script
written to verify a fix for a different one: *a check that cannot be shown to
pass is not evidence, and a check that reports the same thing whether or not it
ran is worse than none.* The harness above now distinguishes three states —
`ACCEPTED`, `REJECTED by <named constraint>`, and `ERROR` — and asserts the
controls.

---

## CCCC2.2 — if the answer is YES: what it would take

Not "usually". **Render the real number**, per product and per departure.

**The blocker, checked:** `minSeats` is **not exposed on the public side at all**.
Only `src/AdminDashboard.jsx` reads it; `presentDeparture` does not carry it, and
the static boards in `site/` have no access to it. So CCCC2.2 is:

1. add `minSeats` to the public departure/product presenters;
2. render *"this date confirms at N travellers"* from that value, **never a
   literal**;
3. remove the eight literals in the table above;
4. keep *"never more than twelve"* as the universal half — `MAX_GROUP_SIZE`
   already exists in `shared/group-size.js` and is genuinely universal;
5. a check that fails if a group-size digit reappears as a literal in `site/`.

**This is materially more work than CCCC2.1**, and worth knowing before the
answer is given rather than after.

---

## CCCC3 — BBBB5 and BBBB6 are held

Both are merged as **proposals**; neither is applied to `site/`. They stay held
until CCCC2 is answered, because the central sentence in each is the one this
decides, and they must be approved together or the site and the Terms will
describe the product differently.

---

## What closes when the answer arrives

| | |
|---|---|
| **NO** | apply 027; L-10 closes — *"four"* becomes true by rule; BBBB5/BBBB6 ship saying **four**, plainly |
| **YES** | delete 027; L-10 closes the other way — the number stops being universal and starts being rendered; BBBB5/BBBB6 ship with the number from data and *"never more than twelve"* as the universal claim |

Either way **the reader gets a specific number**, and L-10 stops being an open
coincidence. That is the point of the question.
