# Verifying that the security fix (#221) is live in production

[#221](https://github.com/desertcanvasart-dotcom/Sawa/pull/221), "agency listing takeover", is described in `docs/security/agency-listing-takeover.md`. It needs no migration, only a deploy of code that contains it.

| | Commit |
|---|---|
| The fix | `c05c978fa8d836f4e947db4b50b83617d60026a1` |
| #221's merge into main | **`1151bb95a012555bffebecbabf24e797d8724218`** (27 Sep 2026) |
| Later merges that contain it | `ac612f5…` (#222), `af18a94…` (#223), and every main commit after them |

**Production is fixed if the running commit is `1151bb9` or any later commit on main.**

## How production deploys, from the repo

- **Host: Railway**, for the web app and its scheduled jobs. The database is Supabase Postgres.
  - `railway.json`: Nixpacks build, `npm run build`, start with `npm start`, health check `GET /api/health`, restart on failure.
  - The workflows probe `https://sawa.tours` (`uptime.yml`, `daily-verify.yml`).
- **Deploy trigger: not recorded in the repo.**
  - No workflow deploys: `.github/workflows/` has only the PR gate (`pr.yml`, on pull requests and pushes to main), the hourly uptime probe and the daily verification. None of them contacts Railway.
  - Whether a merge to main deploys by itself is a setting in Railway's dashboard (the service's GitHub source, branch and automatic deploys), and it isn't visible from here.
  - `.railwayignore` exists and says "Never upload local env or dev-only preview data". A `.railwayignore` only matters when the **Railway CLI uploads a local folder** (`railway up`). So deploys have been made that way at least sometimes, by hand, from a local checkout.
  - Both paths are possible; step 1 below tells you which one is in use.
- **Since [#226](https://github.com/desertcanvasart-dotcom/Sawa/pull/226), once deployed, `/api/health` reports the commit**, `{"ok":true,"commit":"<sha>"}`, from Railway's `RAILWAY_GIT_COMMIT_SHA`. It reports `"unknown"` for a CLI upload. With a SHA, go straight to step 2. Before that deploy:
- **The app doesn't report its own commit.** `/api/health` answers `{"ok":true}`, and `/api/modes` (admin session) reports modes, not a version. The commit is read from Railway.
- **Migrations never run on deploy** (B5, `docs/RUNBOOK.md`). #221 has none, so a deploy alone is enough.

## Steps

### 1. See what production runs
1. Open Railway → the Sawa project → the **web service** (the one serving sawa.tours) → **Deployments**.
2. Look at the deployment marked **Active**:
   - **A GitHub commit is shown** (a short SHA and the commit message): note the SHA and go to step 2.
   - **It says it was deployed from the CLI**, with no commit: the code is whatever folder was uploaded, and no commit can be read. Go to step 4.
3. While you're there, open the service's **Settings → Source**. Note which repository and branch it follows, and whether automatic deploys are on. That answers "automatic on merge, or manual" for the future.

### 2. Check that the commit contains #221
Either:
- open `https://github.com/desertcanvasart-dotcom/Sawa/compare/1151bb9...<active SHA>`:
  - **"There isn't anything to compare"**, or **"… commits ahead"** from 1151bb9: the fix is live;
  - **"behind"**, or a diverged history: it isn't;
- or, in a checkout of the repository:
  ```bash
  git fetch origin
  git merge-base --is-ancestor 1151bb95a012555bffebecbabf24e797d8724218 <active SHA> && echo "contains #221" || echo "does NOT contain #221"
  ```

### 3. If it doesn't contain it, deploy main
- **Railway follows main with automatic deploys:** the latest merge should already be deploying. Check Deployments for a build in progress or a failed one, and open its log.
- **Manual:** in Railway, redeploy the latest main commit from the service's GitHub source. Or, from a **clean** checkout of main at `1151bb9` or later: `git checkout main && git pull && railway up`. Then repeat steps 1–2.
- Wait for the deployment to turn Active (the health check at `/api/health` must pass), then open https://sawa.tours to confirm it serves.

### 4. When the active deployment has no commit (CLI upload)
The running code can't be tied to a commit, so check its behavior. The check must not risk a real listing:
1. As an admin, create a **throwaway listing** in Admin → Tours: a title like "Security check — delete me", **not approved, not active**. It is Sawa-owned (no agency).
2. Sign in as a **test agency** user (any agency login used for testing). Open the listing editor for the throwaway listing's id, or send the request directly with that login's session:
   ```bash
   curl -sS -X POST https://sawa.tours/api/agency/tour-products \
     -H "Authorization: Bearer <the test agency's access token>" -H "Content-Type: application/json" \
     -d '{"id":"<throwaway listing id>","title":"Security check — takeover attempt","type":"day_tour","city":"Cairo"}' -w "\n%{http_code}\n"
   ```
3. Read the answer:
   - **`403` "You can only edit your own listings."**: the fix is live. The fix checks ownership before anything else, so this minimal body is enough.
   - **`201`**: it isn't. The throwaway listing now belongs to the test agency; delete it and deploy main (step 3).
   - **`422`** (a validation error): the old code reached validation instead of refusing, so the fix is **not** live. Deploy main (step 3).
   - **`401`** or **`403` "Your account is not linked to an agency."**: the login or token is wrong, and the check didn't run. Retry with the test agency's session.
4. Delete the throwaway listing either way.

Better still, redeploy from GitHub (step 3) so the active deployment names its commit, and use steps 1–2.

## The two audit queries: was the gap used before the fix?

Run them in **Supabase → SQL editor** on the production project. Both only read.

```sql
-- 1. Agency submissions against listings that staff created or saved first.
--    An agency that legitimately owns a listing created it through listing.submit.
SELECT s.created_at, s.actor_email, s.actor_role, s.entity_id, s.detail->>'title' AS submitted_title
  FROM audit_log s
 WHERE s.action = 'listing.submit'
   AND EXISTS (SELECT 1 FROM audit_log f
                WHERE f.entity = 'tour_product' AND f.entity_id = s.entity_id
                  AND f.actor_role IN ('super_admin', 'ops_staff')
                  AND f.created_at < s.created_at
                  AND NOT EXISTS (SELECT 1 FROM audit_log g
                                   WHERE g.action = 'listing.submit' AND g.entity_id = s.entity_id
                                     AND g.created_at < f.created_at))
 ORDER BY s.created_at;
```

```sql
-- 2. Listings now owned by an agency, whose first recorded action was by staff.
SELECT t.id, t.title, t.agency_id, t.status, t.submitted_at
  FROM tour_products t
 WHERE t.agency_id IS NOT NULL
   AND (SELECT actor_role FROM audit_log a WHERE a.entity = 'tour_product' AND a.entity_id = t.id
         ORDER BY a.created_at LIMIT 1) IN ('super_admin', 'ops_staff');
```

**What the results mean:**
- **Both return no rows:** no sign the gap was used, for as long as `audit_log` has existed (since migration 003).
- **Query 1 returns rows:** an agency user submitted over a listing that staff had created or edited first. Before the fix, that is exactly how the takeover worked. For each row:
  - `actor_email` and `actor_role` are who did it; `created_at` is when; `entity_id` is the listing; `submitted_title` is what they sent.
  - Before calling it abuse, check whether an admin had deliberately given that listing to the agency (Admin → Tours, the listing's operator), after which the agency editing it is legitimate.
- **Query 2 returns rows:** listings that staff created and an agency owns now.
  - Each is either a deliberate assignment by an admin, or a takeover that an admin then re-approved without noticing the change of owner.
  - Match each against query 1: a listing in both, with no admin assignment you can account for, is the one to act on. Restore its content and owner from the audit trail, and review the agency's access.
- **An error such as `relation "audit_log" does not exist`:** you're connected to the wrong database or project.

Nothing in either query changes data. The fix itself stops new takeovers from the moment the deploy is active. These queries only look back.
