# X2 / X3 — Environment-gated behaviour

**9 August 2026.**

---

## ⚠️ First: a correction to my W2.4 report

I reported `TRUST_PROXY` as *"unset in production ⇒ every visitor shares one rate
limit"*. **That is wrong.** `server/app.js:64`:

```js
const trustProxy = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === "production" ? "1" : "false");
```

It **defaults to `"1"` when `NODE_ENV === "production"`**, so it does not need to
be set. Verified by running the server with `NODE_ENV=production` and no
`TRUST_PROXY`: `trustProxy: "on"`.

I read the comment in `.env.example` — "production needs '1' — without it every
visitor shares a single rate-limit" — and reported it as current behaviour. That
comment explains *why the default exists*. It is a representation, I treated it
as a verdict, and it is the sixth instance of W1's rule in this project. Mine
this time.

---

## X3.1 — `TRUST_PROXY`: no defect found, but the state is not yet observable

Rate limiting in production, observed from outside:

```
ratelimit-limit: 300   ratelimit-policy: 300;w=60
three requests → remaining 299, 298, 297   (exactly one per request)
```

The limiter is live at 300/min. **Whether the bucket is per-visitor or shared
cannot be determined from outside** — with no other traffic on the site, a shared
bucket and a per-visitor bucket look identical, and a spoofed `X-Forwarded-For`
does not discriminate either (Express takes the hop the proxy appends, whichever
setting is active).

So: the default makes it safe **if** `NODE_ENV=production` on Railway, which is
Nixpacks' default but is not observable from here. **`/api/health` now reports
it.** Once deployed, `curl https://sawa.tours/api/health` answers this in one
request, and the smoke check asserts it.

---

## X2 — `/api/health` resolved modes

```json
{ "ok": true, "modes": {
    "email": "live|log", "scheduler": "on|off", "autoura": "on|off",
    "trustProxy": "on|off", "canonicalHost": "on|off",
    "tourTimezone": "Africa/Cairo", "nodeEnv": "production|unset" } }
```

Modes only. No key material, no partial keys, nothing revealing more than the
resolved state.

`npm run smoke -- --expect=email=live,trustProxy=on` asserts the running
configuration and fails on drift. Proved: run against a local server it reports
`modes.email is "log", expected "live"` and exits non-zero.

**On auth:** left unauthenticated, matching the healthcheck Railway already
polls. The tradeoff is real — it tells an attacker whether the rate limiter is
keyed per visitor. It is published because the alternative demonstrated itself:
the state nobody could see was the state that drifted for three days. If you want
it gated, put `modes` behind `requireAuth` and have the smoke check
authenticate; the shape does not change.

---

## X3.3 — Autoura egress: **no personal data crosses the boundary**

Active only when `AUTOURA_SYNC_URL` **and** `AUTOURA_SYNC_SECRET` are both set.
Fires on departure writes; `pending_review` is excluded. HMAC-SHA256 signed, 3
retries, 10s timeout.

**Everything transmitted** (`buildDeparturePayload`):

| | |
|---|---|
| Envelope | `brand`, `event`, `sentAt` |
| Departure | `externalId`, `route`, `type`, `date`, `endDate`, `time`, `city`, `minSeats`, `maxSeats`, **`seatsTaken`**, `status`, `priceFrom`, `currency` |

**No names, no emails, no phones, no booking codes.** `seatsTaken` is
`seatsTotal(pledges)` — an integer, with cancelled pledges excluded.

**The risk is one line away, though.** `loadEnriched()` hands the builder **full
pledge rows** — customer names, emails, phones, booking codes — and only the
count is read. A single field added to the payload in good faith would start
exporting personal data with nothing to catch it. There is now a test that pins
the exact field list and asserts no personal value appears on the wire.

**Disclosure:** the privacy policy does not name an affiliated system. Since only
inventory crosses, a personal-data disclosure does not appear to be required —
but that is a legal call, not mine. Flagged.

**Whether it is active in production is unknown** until `/api/health` deploys.
`autoura: on|off` answers it.

---

## X3.4 — `TOUR_TIMEZONE`

Resolved value: **`Africa/Cairo`** (the default; `server/tz.js:16`).

What depends on it — every deadline the site states:

- `bookingClosed()` — the cutoff before departure
- `departureStarted()` — whether a date has passed, which decides if it appears
  on the public board
- `confirmDeadlineDaysFor()` / the auto-cancel deadline
- every date rendered on a departure

`tz.js` resolves the real UTC offset via `Intl` at the relevant instant, so Egypt's
DST (EET/EEST) is handled rather than hardcoded. A previous bug had cutoffs
firing 2–3 hours late on Railway because the server runs UTC. **Correct as it
stands**, and now observable.

---

## X3.2 — scheduler: reported separately

Requires reading the job and mapping it to live copy about unconfirmed
departures. Not complete — next.


---

# Y1 / Y2 (9 August 2026)

## Y1 — the endpoint is split

| Route | Auth | Contents |
|---|---|---|
| `/api/health` | none | `{ ok: true }` — liveness only. What Railway polls. |
| `/api/modes` | **`requireAuth`** | the resolved configuration |

The drift argument needed *visibility*, not *public* visibility. Unauthenticated
`modes` told any caller whether the rate limiter is keyed per visitor, whether an
external mirror is running and whether email is live — useful to someone probing
the system and to nobody else.

The smoke check reads it with `SMOKE_TOKEN` and reports **three states**, because
"could not check" must never render as "clean":

| State | When |
|---|---|
| `verified` | modes read, every expectation matched |
| `FAIL` | an expectation did not match; or the token was rejected; or expectations were given with no token, since a demand that cannot be evaluated has not been met |
| `UNVERIFIED` | no token and no expectations — reported loudly, routes still checked |

It also asserts the split itself: `/api/health` returning a `modes` object is a
failure.

## Y2 — the egress boundary is narrowed, not guarded

`buildDeparturePayload` no longer receives the enriched departure. It receives
**inventory with `seatsTaken` already counted** and never holds a pledge.

Better still, the counting moved into `loadInventory()`, which now selects
`status, seats` instead of `SELECT *` — **the personal columns never leave
Postgres.** A field added to the payload in good faith cannot export a
traveller's details, because those details are not in scope at the call site.

The pinning test stays as a second line, plus an adversarial case: hand the
builder an object that *does* carry pledge rows and assert nothing personal
reaches the wire.

## Y2.3 — the same pattern elsewhere: none found

Searched every place a record is handed to something that serialises or
transmits — external `fetch` bodies, `res.json`, email template arguments.

| Site | Verdict |
|---|---|
| `GET /api/blog`, `/api/blog/:slug` | **Safe.** The query is `SELECT *` but the boundary is `mapPost()`, an explicit field whitelist. Wide read, narrow write. |
| `operatorApplicationEmail` / `…ReceiptEmail` (`{ ...payload }`) | **Safe.** `payload` is `{ ...input, reference }` where `input` is zod-validated request body — the applicant's own submission, returned to the applicant. |
| `sendEmail` `body: JSON.stringify(...)` | **Safe.** Explicit fields only. |

**No other instance of the Autoura pattern** — full record handed over, one field
read. The two wide handoffs both have an explicit whitelist at the boundary,
which is the same protection, arrived at differently.

Worth noting for later: `mapPost` is a whitelist over a `SELECT *`. Adding a
column and adding it to the mapper publishes it. That is a deliberate act, like
the Autoura field list, so it is a pinning-test candidate rather than a defect.
