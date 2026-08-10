# The Supabase Data API was open to anyone

**Found 10 August 2026** while answering DDD2 — "is `audit_log` deletable?" The
answer turned out to be much wider than the question, and live.

Fixed by migration 024. **Migrations do not run on deploy (B5)**, so this is open
until someone runs it against production.

---

## The four facts, and why they compose

| | |
|---|---|
| **RLS** | disabled on all 13 tables in `public`, no policies |
| **Grants** | `anon` and `authenticated` hold `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on every one |
| **The Data API** | live — PostgREST answers at the project URL |
| **The anon key** | shipped in the public JS bundle, **by design** — it is not a secret and was never meant to be one |

None of those is a defect on its own. The anon key is public in every Supabase
project; **RLS is the control that makes that safe**, and it was off.

A `GET` carrying the key anyone can read out of sawa.tours' JavaScript returned
rows from `app_users`, `audit_log` and `email_log`. `pledges`, `departures` and
`operator_applications` answered `200` with `[]` — **not protected, empty.**

**Writes were not tested.** The grant table plus a successful read is
conclusive, and issuing a `DELETE` against production to prove a `DELETE` is
possible would be the same mistake as the audit that once wrote a row to
`email_log` (X1).

---

## EEE2 — is the anon key the only key that is public?

If a `service_role` key were exposed anywhere it would bypass RLS entirely and
make 024 cosmetic — a rotation, not a migration. **It is not.**

| Surface | Result |
|---|---|
| 354 tracked files | clean |
| **1,371 blobs across all of git history** | clean — a key committed once and removed later is still public, so every blob was decoded, not just the current tree |
| Entry bundle, 3 lazy chunks, all `site/assets/*.js` | **one** JWT: `role: anon`, project `pajwixqdvedscleckxdx` |
| Source maps (`*.js.map`) | **none published** — all 404 |
| `/.env`, `/.env.production`, `/env.js`, `/config.json` | all 404 |
| `/api/modes` | 401 — correctly closed |
| `llms.txt`, `llms-full.txt`, `robots.txt`, `sitemap.xml`, widget source | clean |

Keys were identified by decoding the JWT payload's `role` claim, not by pattern
alone — "it looks like the anon key" is not the same as "it is".

**Conclusion: 024 is sufficient. This is not a key rotation.**

---

## EEE1 — did anyone actually read it?

Exposure and breach are different things, and the difference is access.

**I cannot reach the authoritative source.** Supabase's API request logs live in
the dashboard (Logs & Analytics → API / PostgREST), and carry IP, user-agent,
method and status. Retention depends on plan — typically 1 day on Free, 7 on
Pro. **Someone with dashboard access must pull these.**

What Postgres itself retains is weaker but not nothing, and it turned out to be
unusually clear.

`pg_stat_statements` is installed, and PostgREST leaves a distinctive shape —
every request is wrapped in a CTE named `pgrst_source`, which the Express API
never emits.

**Every PostgREST statement ever executed by `anon`, complete:**

| Calls | Table |
|---|---|
| 1 | `cities` |
| 1 | `pledges` |
| 1 | `app_users` |
| 1 | `audit_log` |
| 1 | `email_log` |
| 1 | `operator_applications` |
| 1 | `departures` |

Seven statements, **one call each**. Those are exactly the seven probes issued
during this investigation on 10 August 2026. Total lifetime calls by `anon`
across all statements: **15** — the 7 selects, 7 of PostgREST's per-request
`set_config` role switches, and one `COMMIT`.

`pg_stat_statements` normalises by query *shape*, so a different request — say
`SELECT *` rather than `select=id` — would appear as a separate row. There are
nine `anon` statements in total and all nine are accounted for.

### The window, stated rather than implied

| | |
|---|---|
| `pg_stat_statements` reaches back to | **2026-05-31 14:37 UTC** |
| Table statistics reach back to | 2026-05-22 15:13 UTC |
| `auth.audit_log_entries` | **empty** — Supabase prunes it; no auth history retained |
| Capacity eviction | not reached (≈1,300 tracked statements, default cap 5,000), so nothing was evicted |

**"No evidence of third-party access in the 71 days since 31 May 2026" is what
the data supports. It is not "no access occurred."** Anything before
2026-05-31 14:37 UTC is unobserved here, and nothing in Postgres attributes a
request to an IP, an origin, or a user-agent. The dashboard logs are the only
source that can.

### A second, independent read

`audit_log` shows **63 inserts, 0 updates, 0 deletes** since 22 May 2026, and
holds 63 rows. Nothing has ever altered or removed an audit row. `email_log`
shows 28 inserts and **1 delete** — which is the X1 finding already on record,
the auditor that wrote a row and had it removed. The counters corroborate the
written history rather than contradicting it.

---

## EEE3 — the exposure scope, precisely

"No traveller PII" is true because `pledges` is empty. **It is not the same as
"no personal data."** Recorded as its own entry in the legal register.

| Table | Rows | Personal data exposed |
|---|---|---|
| `app_users` | 2 | `email`, `full_name`, `role`, `status`, `agency_id`, `id` — staff identities, including which account is `super_admin` |
| `email_log` | 28 | `recipient`, `subject`, `kind`, `status`, `error` — recipient addresses of real sends |
| `audit_log` | 63 | `actor_email`, `actor_role`, `action`, `entity_id`, `detail` — who did what, when, including a full activity history |
| `pledges` | 0 | traveller name, email, phone, booking code — **none exposed, because the table is empty** |
| `operator_applications` | 0 | company, contact name, email, phone, licence — **none exposed, table empty** |

**Period of exposure:** from project creation until 024 is applied. The earliest
firm date available here is the table-statistics reset, 2026-05-22.

**The one piece of luck:** `pledges` is still empty. There is no traveller
personal data exposed today, and the window closes at DIR-16 — which is why
EEE4 puts 024 ahead of the seed.

---

## Why the fix is safe

Checked rather than assumed: `src/` contains **zero `supabase.from(...)`
calls**. Every use of the client is `supabase.auth.*` — sign-in, session,
sign-out, password reset. All data goes through `apiFetch` to the Express API,
which connects as `postgres`.

`postgres` is a superuser and **bypasses row-level security**, so enabling RLS
with no policies blocks `anon` and `authenticated` and changes nothing about how
this application reads or writes. `service_role` bypasses it too, so the
Supabase dashboard is unaffected. Storage buckets are governed separately and
are untouched — the public tour images stay public.

---

## Applying it, and verifying afterwards

```bash
DATABASE_URL=<production> npm run db:migrate
```

Then verify **anonymously**, which is the only verification that means anything:

```bash
# The anon key is public; read it out of the bundle the same way an attacker would.
BUNDLE=$(curl -s https://sawa.tours/itineraries | grep -oE 'assets/index-[A-Za-z0-9._-]+\.js' | head -1)
KEY=$(curl -s "https://sawa.tours/$BUNDLE" | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -1)
for t in app_users audit_log email_log pledges departures operator_applications; do
  printf '%-24s %s\n' "$t" \
    "$(curl -s -o /dev/null -w '%{http_code}' \
       "https://pajwixqdvedscleckxdx.supabase.co/rest/v1/$t?select=id&limit=1" \
       -H "apikey: $KEY" -H "Authorization: Bearer $KEY")"
done
```

Every table must return `401`, or `200` with `[]`. **A `200` with a row means
the migration did not take.**

---

## Still open

| | |
|---|---|
| **The dashboard API logs** | the only source that can attribute a request to an IP or an origin, and the only one that covers the period before 31 May 2026. Requires dashboard access. |
| **`postgres` as the application role** | the app connects as a superuser, which is why RLS cannot protect against a bug in the app itself and why `audit_log` needed a trigger rather than a grant. The read-only role work (client item 7) is the same grant review. |
| **`authenticated` had the same grants as `anon`** | revoked by 024. Worth noting that a signed-in traveller — once travellers can sign in — would have had the same access as an anonymous one. |
