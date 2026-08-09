# P3.2 — Seed preconditions, and the staged load

**9 August 2026.**

Seeding real bookings from real people is the point at which this system stops
being verifiable by inspection and starts having consequences it cannot retract.
`departures` and `pledges` have never held a row.

---

## The compound risk

Three facts, each established separately:

1. **Email delivery is live** — confirmed 6 August, one send, to the account
   owner.
2. **The auto-cancel job** cancels a departure that misses its deadline and
   **emails every traveller on it**.
3. **P3.2 seeds real bookings from real people.**

If the scheduler is on, a seeded departure that does not fill sends a **real
cancellation email to a real traveller**, describing a refund that cannot occur.
That is the one output class this project cannot retract.

---

## The four preconditions

| # | Precondition | Status |
|---|---|---|
| 1 | Z2 vacuous-test sweep complete | **not started** |
| 2 | Scheduler resolved state verified via `/api/modes` | **needs an admin token** |
| 3 | Cancellation copy corrected and consistent with the Terms | **blocked on AA3.1** |
| 4 | B4 / P3.4 zero-suppression shipped, with the three P3.3 states | **not started** |

---

## The circularity, and how the staged seed resolves it

Precondition 1 cannot be fully met while the tables are empty.

- The claims audit cannot verify data-dependent states, because they render
  nowhere.
- Z2 will find tests that pass vacuously — and cannot tell which ones would fail
  with real rows, for the same reason.
- Precondition 4's whole purpose is to make the board behave correctly **when
  data lands**, which is unobservable until it does.

So the checks are gated on data and the data is gated on the checks.

### Resolution — stage the load

1. **Complete the four preconditions as far as empty data allows.**
2. **Seed exactly one departure.**
3. **Run the full gate against the now-non-empty states** — `audit:claims`,
   `smoke`, the P3.3 renders, and every Z2 candidate identified as possibly
   vacuous.
4. **Confirm the forming-below-minimum state renders with a real count**, and
   that no bare zero or persistent loading state appears anywhere.
5. **Only then load the remainder.**

### Why this order

The first real traveller data enters a system verified **with** data, rather than
one verified only while empty.

Every failure this project has found came from something that looked correct in a
state it was never going to stay in: a sitemap test asserting no `<lastmod>`
anywhere, which passed only because the tables were empty; 176 unit tests passing
while 19 routes served a raw shell; a rule that matched nothing and reported
clean.

### Choosing the first departure

It must be one where a **forming, below-minimum** state is expected — not a date
that will confirm immediately and not one already past its deadline.

That is the state P3.3 designs for, the state the model sells on, and **the state
nothing has ever rendered**. Seeding a departure that skips straight to confirmed
would leave the most important screen on the site still unobserved.

Practically: a date far enough out that its deadline is not close, on a day tour
rather than a package, with one or two travellers against a minimum of four.

### Before step 5

The scheduler must be in dry-run (BB3) or off, so that if the single seeded
departure passes its deadline during the staging window, no cancellation email
reaches the traveller on it.
