# The GoAhead deadline

Every departure has to reach its minimum by a deadline, or it is cancelled and
everyone holding a seat is emailed and refunded.

The booking conditions and the GoAhead promise page have always described this.
Until now nothing enforced it: no deadline existed in the data model, and the
only way a departure became `cancelled` was an admin clicking cancel. A date
that never filled simply sat at `open` until its departure day passed, and the
travellers holding seats were never told.

## The rule

| Product type  | Deadline before departure |
| ------------- | ------------------------- |
| Package       | 30 days                   |
| Day tour      | 7 days                    |

Packages get longer because travellers book flights around them and operators
hold hotels and boats. Day tours get less because travellers are usually already
in Egypt, and a 30-day deadline would kill dates that would have filled.

Per-listing override: `tour_products.confirm_deadline_days`. `NULL` — the normal
case — means "use the type default", so the policy lives in one place
(`server/domain.js`) rather than being frozen into every row.

The deadline is measured from the departure's own start **time** in Egyptian
local time, not from midnight, so it never drifts with the server's timezone.

## What gets cancelled

Deliberately narrow — see `missedConfirmDeadline()`. A departure qualifies only
when **all** of these hold:

- status is exactly `open` (at or above minimum it has already advanced to
  `minimum_reached`; `pending_review` is waiting on a human, not on travellers)
- booked seats are below the minimum
- the deadline has passed
- the date parses

A malformed date cancels nothing. The cost of a false positive is destroying
sellable inventory, so every ambiguous case leaves the departure alone.

## When it runs

**Automatically, inside the web process.** `server/jobs/scheduler.js` runs it 60
seconds after boot and every 24 hours after that. Nothing to schedule and no
second service to keep configured.

That is normally the wrong shape for a background job — it ties job health to
web health, and every instance runs its own copy. It is right here because the
job is idempotent and concurrency-safe by construction: each departure is
re-read `FOR UPDATE` inside its own transaction and re-checked against the rule,
so running it twice, or from two instances at once, cancels nothing extra. A
booking that lands between the scan and the update is honoured — the date no
longer qualifies and is left open.

The first run waits a minute so a deploy is not doing database work while the
app is still warming, and so a crash-loop does not run it on every restart.

Look for `[job:cancel-unconfirmed]` in the Railway logs.

### Where it does *not* run

Off unless `NODE_ENV=production`, or `ENABLE_JOB_SCHEDULER=1` is set
deliberately. This is not tidiness — migrations and dry runs in this project are
done by pointing a **local** process at the production database
(`railway run node …`). Without the guard, anyone starting the API that way
would silently cancel live departures from their laptop a minute later.

`DISABLE_JOB_SCHEDULER=1` turns it off even in production: the lever to pull if
it ever misbehaves against live data, without a code change or a rollback.

## Running it by hand

```bash
DRY_RUN=1 npm run job:cancel-unconfirmed  # list what would be cancelled
npm run job:cancel-unconfirmed            # cancel + notify
```

Same code path as the scheduled run. Useful for checking what the next tick will
do before it does it.

## What it records

Every cancellation writes a `departure.auto_cancel` row to `audit_log` with the
seat count, the minimum and the deadline instant. Email failures never block a
cancellation: the status change is committed first, because a mail outage must
not leave a date open past its deadline.
