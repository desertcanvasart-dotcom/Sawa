# Why the daily production check is red (investigated 27 Sep 2026)

Workflow `.github/workflows/daily-verify.yml`, step **"Full preflight (only with auditor credentials)"**. Nothing below changed a credential or re-ran a workflow.

## The timeline

| Runs | Dates | What happened |
|---|---|---|
| #27 | 8 Sep | **Last full pass**: 16 of 16 steps green. |
| #28–#44 | 9–25 Sep | Every run "failed" in 2–4 seconds, with no runner, no steps and no logs. The hourly Uptime workflow failed the same way in the same window. That is an account-level Actions block, typically billing or a spending limit, not this repository's code. (The same thing happened 24–31 Aug.) |
| #45 | 26 Sep | **The preflight itself fails**: 3 of 16 steps (`check:applied-schema`, `check:seed-expiry`, `audit:claims`). DOM smoke, route smoke and the promises audit pass. |
| #46 | 27 Sep | 4 of 16 fail: the same three, plus `test`. |

## Cause 1: the database password in the secret is the old one

Run #46 has `audit:claims` reporting:

> db-error — password authentication failed for user "postgres"

What led to it:

- Commit `38154fc` (25 Sep, S01) removed the live database password that had been committed in `.env.example`. It says the password must be rotated in Supabase and the new one set in Railway, and that was done. The live site works, and the route smoke and promises audit read live products after 25 Sep.
- The GitHub secret **`AUDITOR_DATABASE_URL`** still holds the connection string with the **old** password.
- The login it uses is Supabase's `postgres` admin user, not a dedicated auditor role.
- The host didn't change. A host mismatch would have been reported as "wrong-target" against `PRODUCTION_DB_HOST`, not as a password error.

All three DB steps fail on this: `check:applied-schema`, `check:seed-expiry` and `audit:claims`.

### What to renew, and where

1. **Recommended:** create the least-privilege read-only role described in `docs/audit/readonly-credentials.md` (`sawa_auditor`), in Supabase → SQL editor. Then build its URL, `postgres://sawa_auditor:<password>@<same host and port as before>/postgres`. This way the next `postgres` password rotation won't break the check.
   **Or, quickest:** Supabase → Project Settings → Database (or "Connect") → the connection string, with the **new** `postgres` password. Use the same host or pooler as before, so `PRODUCTION_DB_HOST` still matches.
2. GitHub → the repository → **Settings → Secrets and variables → Actions → `AUDITOR_DATABASE_URL`** → Update, and paste the URL.
3. Leave `PRODUCTION_DB_HOST` unchanged unless the host changed.
4. Re-verify: **Actions → Daily verification → Run workflow**. Or, locally:
   ```bash
   DATABASE_URL=<new url> PRODUCTION_DB_HOST=<host> npm run preflight -- --base=https://sawa.tours
   ```
   `audit:claims` should report "database columns audited (N)" with N > 0 and no db-error.

Also check **GitHub → Settings → Billing and plans → Actions spending limit**. The two runs of jobs that never started (24–31 Aug, 9–25 Sep) will come back if the limit is hit again.

## Cause 2: templates missing from the claims audit (fixed in this PR)

Run #46's `audit:claims` also reported email templates that had shipped without being added to its audit list. It says "add it, do not skip it". Against main there were 18:

- from the operator, settlement and pay-at-GoAhead work;
- including `paymentLinkEmail`, `paymentReceivedEmail`, `belowMinimumCancellationEmail`, `documentExpiryEmail`, `operatorAssignmentEmail` and `catalogueAdminAlertEmail`.

This PR lists all 18 in `scripts/audit-claims.js`, with fixtures. All 34 templates render, and the copy rules flag none of them.

## Cause 3: one failing test on 27 Sep (not identified from the log)

The `test` step failed on one test in run #46, which ran main at `ce4e1b1`. It had passed on 26 Sep. The log tail available here doesn't reach the failing test's name, and the full log download is blocked from this environment.

On current main plus this PR, the full suite passes locally against Postgres: **1083 of 1083**.

After the secret is renewed, run the workflow once. If `test` is still red, the job log names the test ("not ok …").
