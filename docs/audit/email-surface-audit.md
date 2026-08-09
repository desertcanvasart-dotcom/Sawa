# W2 — Email as a public surface

**9 August 2026.** Email was outside every prior sweep. It is also the only
surface where a correction corrects nothing: a sent message cannot be edited.

---

## W2.1 — Actual exposure: closed

**One email has ever been delivered, and it went to the client's own address.**

| | |
|---|---|
| Delivered (`sent`) | **1** — 6 Aug 2026, 01:01 |
| Kind | `departure_request_received` |
| Recipient | `islamjp69@gmail.com` — the account owner |
| Subject | "Request received — Aswan Highlights — Unfinished Obelisk, High Dam & Philae on 2026-08-25" |

It was a self-test. **No third party has received an email from this system.**

The 26 `logged` rows were never delivered. Their recipients are test addresses
(`@example.com`, `@test.com`, `*.sawatours.test`) plus three real-looking
addresses that still received nothing, because log mode does not send. 14 of them
were `booking_confirmation` for bookings that no longer exist — `pledges` is
empty, so that inventory was purged.

**Nothing is unrecoverable. The exposure closes.**

---

## W2.2 — Every template audited

12 templates, **invoked with fixture data** so what is scanned is the rendered
subject, HTML and text a recipient would receive — a verdict on output, not a
pointer at source.

`inviteEmail`, `bookingConfirmationEmail`, `departureRequestReceivedEmail`,
`departureRequestApprovedEmail`, `departureRequestDeclinedEmail`, `goAheadEmail`,
`listingApprovedEmail`, `listingRejectedEmail`, `operatorApplicationEmail`,
`operatorApplicationReceiptEmail`, `operatorApplicationText`, `cancellationEmail`

**Result: zero findings in every serious class** — no phantom payment process, no
guarantee language, no company-shaped names, no ratings, no volume or tenure
claims, no availability claims, no absolute claims.

The templates are the cleanest surface in the project. `cancellationEmail`'s
"**If** you were charged anything for this booking, it is refunded in full" is
the conditional shape the rest of the site had to be corrected into.

### One rule was wrong, not the templates

Six `universal-threshold` hits fired on "reaches **its** minimum travellers".
That is the *correct* per-product framing under B1 — possessive to the date,
naming no number. The rule was too blunt; it now ignores the possessive form and
still fires on the generic one ("confirmed at minimum travellers", "every date
confirms at four"). A rule with known false positives is one people learn to
ignore.

---

## W2.3 — In the gate

Email templates are now a scanned surface class in `audit-claims.js`, wired into
`preflight`, and listed in the surface inventory.

**A mistake worth recording.** The first version selected templates by name
pattern — `/Email$|Text$/` — which matched **`sendEmail` itself**. The audit
called it, and it wrote a row to the production `email_log` table. Nothing was
delivered (no API key locally, so it took the log branch) and the row has been
deleted, but an auditor must have no side effects. Selection is now an explicit
allow-list, and a template present in `email.js` but missing from that list is
**reported, not skipped**.

---

## W2.4 — The drift channel

`STATUS.md` was accurate when written. Something changed on 6 August that nobody
recorded.

**What changed:** `RESEND_API_KEY` and `EMAIL_FROM` became set in the Railway
environment. `server/email.js:29` reads `emailMode = RESEND_API_KEY ? "live" :
"log"` — a single env var flips the entire system from logging to delivering,
at boot, with no migration, no deploy marker and no code change.

**Why nothing recorded it:** the channel is Railway's environment variables.
Nothing in the repo observes them, no check asserts what mode the app is in, and
`docs/STATUS.md` is hand-maintained.

**What else moves through the same channel** — every one of these changes live
behaviour with no code change and no record:

| Variable | Effect when set/unset |
|---|---|
| `RESEND_API_KEY` | log mode ↔ **live email delivery** |
| `EMAIL_FROM`, `REPLY_TO` | the address recipients see and reply to |
| `TRUST_PROXY` | unset in production means every visitor shares one rate limit |
| `CANONICAL_HOST` | unset means no canonical redirect |
| `AUTOURA_*` (3 vars) | all three set enables a departure mirror to an external system |
| `ENABLE_JOB_SCHEDULER` / `DISABLE_JOB_SCHEDULER` | whether unconfirmed departures are auto-cancelled |
| `TOUR_TIMEZONE` | the timezone every booking cutoff is computed in |
| `PAGE_WARM_INTERVAL_MS` | whether pages are kept warm |

**Recommendation:** `/api/health` should report the effective mode of each — not
the values, just the resolved state (`email: live|log`, `scheduler: on|off`,
`autoura: on|off`, `trustProxy: on|off`). A smoke assertion could then observe
the running configuration rather than assuming it, which is W1's rule applied to
config. **Not built — this is a proposal, and it touches the health endpoint.**

The `AUTOURA_*` row is worth a second look independently: if those three are set
in production, departure data is being mirrored to an external system, and
nothing in this project has audited what that sends.
