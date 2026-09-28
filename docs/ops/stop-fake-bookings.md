# Stopping fake bookings

Three live measures on direct (public) bookings, on both legacy and catalog
departures. Agency, staff and waitlist bookings are not affected.

## 1. Email confirmation (migration 058)

A direct booking is held until the traveler clicks **Confirm my booking** in
the email. Until then it is not a booking at all: it isn't in `pledges`, so it
doesn't count towards GoAhead or the public seat count, and the operator never
sees it. The booking page shows "Check your email to confirm your booking" and
can resend the link (at most 3 times; each resend replaces the link).
Unconfirmed after 24 hours, it expires with no email; one that never became a
booking is deleted 30 days on. Bookings made before
this change are unaffected.

- Apply migration 058 (`npm run db:migrate`). Until it is applied, bookings
  are made at once, as before, and the log says so once.
- `BOOKING_EMAIL_CONFIRMATION=off` turns the hold off without a deploy of code.

## 2. Cloudflare Turnstile

Create the keys:

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Name: `Sawa booking forms`. Hostnames: `sawa.tours` and `www.sawa.tours`
   (the partner widget is served from sawa.tours inside an iframe, so partner
   sites do not need adding).
3. Widget mode: **Managed**. Pre-clearance: no.
4. Cloudflare shows a **Site key** and a **Secret key**.

Put them in Railway: project → the web service → **Variables** → New variable:

| Variable | Value |
|---|---|
| `TURNSTILE_SITE_KEY` | the Site key (public; sent to the browser) |
| `TURNSTILE_SECRET_KEY` | the Secret key (private; used by the server only) |

Railway redeploys on save. No rebuild of the front end is needed: the site key
reaches the page through `/api/bootstrap`.

Without the secret key the check is skipped and the log says
`[turnstile] TURNSTILE_SECRET_KEY is not set`, so the site never breaks. If
Cloudflare can't be reached, the booking goes through and the failure is
logged. Only Cloudflare's own "invalid" answer refuses a booking. Set both keys
together: a site key without the secret shows the widget but checks nothing.

## 3. Rate limit

At most 5 booking attempts (bookings and date requests, made or refused) per
hour from one IP address; the sixth gets: "You've made several booking
attempts in the last hour. Please wait a little and try again, or email
hello@sawa.tours and we'll book it for you." `BOOKING_RATE_LIMIT_PER_HOUR`
changes the number. The limit is per server instance and resets on a restart.
