# Sawa — Build Status

**Updated:** 2026-06-01

## Done & verified

| Area | Status |
|---|---|
| **Phase 1 — Reliability** | PostgreSQL (Supabase) + Express, transactions, row-locking. Oversell test passed. |
| **Phase 2 — Auth & tenancy** | Supabase Auth, 4 roles, role-gated dashboards, tenant isolation. 9/9 E2E. |
| **Phase 3 — Staff/agency mgmt** | Owners manage workers; admin creates agencies + owners. 7/7 E2E. |
| **Phase 5 — Email** | Invite, booking-confirmation, GoAhead, cancellation. Log-mode; real delivery one env var away. |
| **Phase 6 — Hardening** | Audit log, rate limiting, helmet, CORS, 13/13 unit tests. |
| **Admin dashboard** | Left-nav: Overview / Tours & Packages / Departures / Bookings / Agencies / Activity. |
| **Add tour / package** | Full editor (incl. itinerary + hotel tiers) in the dashboard. Verified. |
| **Booking confirmation email** | Public form now collects traveller email; confirmation fires. Verified. |

## Still missing — needs YOU
1. **Rotate the leaked Supabase keys + DB password** (shared in chat). Do before launch.
2. **Turn on real email** — add `RESEND_API_KEY` + `EMAIL_FROM` (verified domain) to `.env`.
3. **Production hosting** — deploy to Railway (app) against the Supabase DB.

## Still missing — small build items
4. **Sentry error monitoring** — needs a DSN to wire (~10 min).
5. **Force password change on first login** — temp passwords work; this would harden them.
6. **Agency-side dashboard** — admin side was rebuilt; the agency desk is still the older layout.

## Open product decisions
7. Online payments (deposits shown, not collected).
8. Arabic / RTL.
9. 60-day no-booking auto-cancel (approved, deferred — now easy as a scheduled job).
10. Customer accounts for direct travellers.

## Test logins (password `Sawa!2026`)
- `admin@sawatours.test` — super admin → `/admin`
- `owner.ag1@sawatours.test` … `ag5` — agency owners → `/agency`

## Run locally
```
npm run api      # API :8787
npm run web      # frontend :5173
npm test         # unit tests
npm run db:reset # migrate + seed + seed-users
```
