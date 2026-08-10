# DIR-1 — Audit coverage on state changes

**10 August 2026. Node v22.21.1 · TZ=UTC.**

BBB1 asked whether anyone had ever had their access revoked while their login
stayed live. The answer was **no**, but it had to be assembled from `auth.users`
state plus an argument about what the code can and cannot do — because
`audit_log` **could not answer it**. The two routes that revoke access wrote
nothing to it.

An audit trail with a hole is worse than none, because it is trusted.

---

## The sweep found 8, not 2

The directive named two routes. Scanning every mutating route in `server/app.js`
found **eight** that changed state and left no record:

| Route | What went unrecorded |
|---|---|
| `PATCH /api/agency/staff/:id` | role and status changes on a team member |
| `DELETE /api/agency/staff/:id` | access revocation |
| `PATCH /api/admin/staff/:id` | platform role and status changes |
| `POST /api/admin/tour-products/:id/pricing` | **a price change across every date of a product at once** |
| `POST /api/admin/tour-products` | a listing written straight to `approved` |
| `POST /api/departures` | an agency creating a departure |
| `DELETE /api/public/departures/:id/bookings/:pledgeId` | a traveller removing their own seat |
| `POST /api/track/referral` | a per-visit counter — **exempt, with a reason** |

Two of those are worth naming on their own.

**The pricing route.** One request reprices the product *and every departure
under it*, and nothing recorded who did it or what the prices were before. It is
the highest-value audit row in the file after the access changes; it is now
logged with `from`, `to`, and how many departures were repriced.

**The admin listing route.** The agency route audits `listing.submit`. The admin
route writes straight to `approved` and audited nothing — **the path with less
review had less record.**

---

## DIR-1.1 — a revoke path nobody had named

`PATCH /api/agency/staff/:id` accepts `status: "disabled"`, wrote it to
`app_users`, and **never touched the login at all.**

`DELETE .../staff/:id` revokes. The admin `PATCH` revokes. This one did not. An
agency owner disabling a team member through it left that person's Supabase
session working indefinitely while every screen in the product read `disabled`.

That is the BBB1 defect, in a path BBB1 never named, found only because the
directive asked for a sweep rather than a fix.

## DIR-1.2 — and the door only opened one way

`status: "active"` is permitted on both staff `PATCH` routes, so re-enabling
somebody is an offered operation. **Nothing lifted the ban.** The write
succeeded, returned 200, showed `active` in every admin screen, and the person
still could not sign in — a failure printing exactly what success prints, with
the polarity reversed.

`revokeLogin(id)` is now `setLoginAccess(id, allowed)`, and reports four states:
`revoked`, `restored`, `failed`, `no-auth-provider`.

> **This changes the BBB1 proof.** That proof relied on *nothing in the
> repository ever lifting a ban*, so `banned_until IS NULL` meant no ban was ever
> applied. From this commit that argument no longer holds for the future. It
> remains valid for everything before it, and **the audit log is what answers the
> question from here** — which is the point of the directive.

## DIR-1.3 — a failed audit write left no trace

`logAudit` caught its own failure and printed `console.error`. Never throwing is
right: an audit write must not break the booking it describes. But that also made
a failed audit indistinguishable from one that never happened — no count, nothing
in `/api/modes`.

Recorded and counted now, under `audit`, naming the action that was lost. It
still does not throw.

---

## The gate

`scripts/audit-coverage.js` scans every `POST` / `PATCH` / `PUT` / `DELETE` route
and reports any that call no `logAudit`. `server/audit-coverage.test.js` asserts
it in the unit suite, so a new unaudited route fails at the pre-commit hook.

Exemptions live in `EXEMPT` **with a reason each**, and the test enforces both
that a reason exists and that **nothing touching access can be exempt**,
whatever its volume. The bar for an exemption is not "it is noisy" — it is "it
is noisy AND nothing turns on it".

`POST /api/track/referral` is the only entry: a public per-visit counter with no
actor, changing no access, money or status, whose totals are themselves the
record.

**32 mutating routes · 31 audited · 1 exempt · 0 unaudited.**

---

## Still open

| | |
|---|---|
| The audit trail cannot be read | There is no UI or export. `audit_log` is queryable only with database access, which means the record exists for a forensic question and not for an operational one. |
| `audit_log` has no retention or integrity story | Rows can be deleted by anything holding write credentials. Worth stating before anyone relies on it as evidence rather than as a diagnostic. |
| Coverage is per-ROUTE, not per-WRITE | A state change made inside a helper, a job, or a migration is not seen by this scanner. `server/jobs/cancel-unconfirmed.js` audits `departure.auto_cancel`; nothing checks that it still does. |
