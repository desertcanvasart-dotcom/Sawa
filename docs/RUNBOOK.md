# Runbook

## Before anything ships

```bash
npm run preflight
```

Runs, cheapest first:

| Step | Catches |
|---|---|
| `check:constants` | group-size copy drifting from `shared/group-size.js` |
| `test` | unit behaviour |
| `smoke` | **routes not actually serving** |
| `audit:claims` | unevidenced claims, dead config, over-length descriptions |

`smoke` and `audit:claims` fetch a running server. Default `http://localhost:8795`;
pass `--base=https://sawa.tours` to point at production.

```bash
# start a server to check against
SUPABASE_URL=$VITE_SUPABASE_URL SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
API_PORT=8795 PAGE_WARM_INTERVAL_MS=0 node server/app.js
```

---

## "Tests pass" is not "routes serve"

**These have now diverged twice, both silently.** Unit tests check units; they do
not check that a visitor or a crawler receives a page.

1. **Deleting `STATIC["/"]` from `seo.js`.** It looked like dead config for a
   route served from `/site`. It was also the **default** title and description
   for every route without an entry, read as `STATIC["/"].title`. Removing it
   made `buildHead()` throw on every SPA route: `/itineraries`, `/blog` and
   `/booking` served the bare Vite shell — no title, no description, no JSON-LD.
   **The source parsed. All 176 tests passed.** Only fetching the routes showed
   it. Re-running the regression deliberately: `npm test` passes, `npm run smoke`
   fails 19 of 39 routes.

2. **Claims "corrected" in config no route consumes.** Twice. The served string
   was never touched, and the next audit found the corrected copy and stopped
   looking.

**Rule:** no surface is reported clean on the basis of source inspection alone.
Rendered output or it did not happen.

---

## V6 — Where marketing and the Terms conflict, the Terms are ground truth

Not a tiebreaker to weigh case by case. A default, pending verification.

Marketing copy is written aspirationally; legal copy is written defensively.
Where they diverge, the legal page is nearly always nearer the build.

It held here. Six public places said Sawa places a card authorization hold and
that the reader's bank would release it. `site/terms.html` carried an unrendered
comment above section 6:

> "Accurate to the current build: reserving takes contact details only. No card
> is requested, no processor is integrated and no authorisation hold is placed."

The correct version was in the repo the whole time, one file away from the copy
that contradicted it.

---

## Internal notes are leads, not ground truth

The companion rule, and it cost a near-miss to learn.

`docs/STATUS.md` says email runs in log-mode. It does not — production has been
delivering since 6 August 2026, which only the `email_log` table shows. Trusting
that note would have produced a confident report that confirmation emails are
never delivered.

So: an internal statement tells you **where to look**. Runtime or database
evidence tells you **what is true**. `npm run audit:repo-truth` collects the
statements and refuses to pass until each has a recorded verdict; the verdict is
what was verified, not what the note said.

---

## A red commit is blocked, not discouraged

`.githooks/pre-commit` runs the unit suite and refuses the commit if it is red.
Enable it in a fresh clone:

```bash
git config core.hooksPath .githooks
```

The rule was stated, agreed, and broken anyway (`d24d6cb`, committed at 182/183).
The response to that is not more care — it is that the commit cannot happen.
Same principle as `loadInventory()`: the personal columns do not leave Postgres,
so no future change can export them. **Structural impossibility over vigilance.**

Bypass with `git commit --no-verify` only in a genuine emergency, and say so in
the message.

## Never verify with a shortcut when the tool exists

`audit-claims.js` was built because approximations kept producing confident wrong
answers. Then a quick `sed` pipeline was used to check *its* output, and it
reported two claims as still live that had already gone — it could not strip
multi-line HTML comments or `<script>` blocks, so it matched the removal notes
explaining what had been taken out.

Ninth instance of the same error, and the cheapest to avoid: **if a tool exists
for the question, use the tool.**

## A task is not closed until it is observable in production

An approval is a representation of work. Only shipped code is the system.

P1.4 was approved with a stated default action, never happened, and surfaced five
phases later because a meta description was too long. `docs/audit/approvals-register.md`
lists every approved decision and whether it is live. Update it when a task
closes — and "closes" means verified against production, not against a commit
message.

## Never re-run to diagnose an intermittent

A fresh run is a **different system state**. Greping it reads a representation of
the failure rather than the failure itself — the same error as reading
`.env.example`'s comment as current behaviour, or `STATUS.md`'s email line, just
faster to make. It cost four sightings of an intermittent before the cause was
found.

Read the output of the run that failed:

## Diagnosing a test failure: read the run that failed

An intermittent failure appeared four times as a decremented count with, as far
as I could see, no named failure. **The reporter was never broken.** A
file-level failure — an async rejection landing after the tests resolve, which
is what a transient database error looks like — is reported as
`not ok N - /path/to/file.test.js`, naming the file.

The bug was the method: I kept running `npm test` *again* to find the failure,
and greping a fresh, passing run. Capture the failing run's output, or you are
diagnosing a different run.

```bash
npm test > /tmp/test.log 2>&1; grep -E "^not ok" -A 8 /tmp/test.log
```

## The unit suite must not need a network

`seo.test.js` called `sitemapXml()` five times, and that queries `tour_products`
and `blog_posts` — five live Supabase round-trips on every `npm test`. That is
the most likely source of the intermittent.

Those five moved to `server/seo-sitemap.integration.mjs`, run by
`npm run test:integration`, deliberately **not** in `preflight`. They are named
so `node --test server/ src/` cannot pick them up.

Splitting them out immediately surfaced a real failure that had been hiding: one
asserted the sitemap contained no `<lastmod>` **anywhere**, contradicting its own
comment, which says database-backed URLs should carry one. It had only ever
passed because the tables were empty when it was written.

---

## The cancel job is dry by default

`/api/modes` reports `cancelJob: live | dry-run | off`.

The scheduled tick logs what it *would* cancel and email, and does neither,
unless `CANCEL_JOB_DRY_RUN=0` is set. It is the only code path that emails a
traveller with no human action, and production runs it — `scheduler: on` with
`email: live`, verified 9 August 2026.

The default is inverted from the usual because the failure modes are not
symmetric. **A dry run that should have been live** leaves stale departures on
the board: visible, and fixable in a minute. **A live run that should have been
dry** sends mail to real people, and that cannot be recalled.

Go live when the cancellation copy is settled (AA3) and seeded data has been
through at least one tick.

The manual path is unchanged — `npm run job:cancel-unconfirmed` still runs live,
and `DRY_RUN=1` still makes it dry. This governs the unattended tick only.

---

## A guard is only as strong as the check on the contract it depends on

`app.js:158` deliberately preserves a pledge's `status` through redaction, with
a comment explaining exactly why: *"a cancelled pledge has released its seats,
and without this the viewer counts it as still occupying them."*

The reasoning was right, written in the right place, by someone who understood
the failure. It was then defeated by the consumer, which compared that value
against `'canceled'` — a spelling the database cannot produce. The guard held.
The contract it depended on was never checked.

This is not stale documentation. It is **defensive code whose intent was
silently discarded downstream**, which is worse, because the guard's presence is
what makes everyone stop looking.

**Rule:** where a guard depends on a downstream consumer honouring a contract,
there must be a check on that contract. `check:status-literals` is now that
check for status values.

### Where no such check exists — MM3

Five rules are implemented on the server, tested on the server, and
**re-implemented by hand** in the front end. Every test covers the server's copy
only; nothing compares the copies against it.

| Rule | Authority | Re-implemented in | Checked? |
|---|---|---|---|
| `isForming` / `isGoAhead` | `shared/departure-state.js` | nothing — `site/assets/rules.js` is generated | ✅ **NN2.1** — `check:rules` + a parity test comparing the generated browser copy against the server on 16 cases |
| `seatsTotal` / `goAheadSeatsFor` | `shared/departure-state.js` | nothing — `main.jsx` imports it | ✅ **NN2.1**, same check |
| `slugify` / `tourSlug` | `server/slug.js` | `site/index.html`, `site/departures.html` | ❌ — drift gives a 404 or a 301 loop |
| `livePriceFor` / `priceFromTiers` | `domain.js` | `src/AgencyDashboard.jsx` | ❌ — drift means an agency quotes a price the server will not honour |
| `capacityError` | `domain.js` | `src/AdminDashboard.jsx` | ❌ — fails safe: the save 409s |

The group-size constants are the counter-example and the model: they were the
same shape until `shared/group-size.js` made one module the authority and
`check:constants` enforced it. **NN2.1 applied that model to the board rules**,
and the three copies had already diverged three ways before anyone looked.

Order the remaining three by **silence, not by cost**. `livePriceFor` drifting
costs money, but it is one copy, agency-facing, and a wrong price is noticed by
the person quoting it — there is a human who complains. A board rule drifting is
noticed by nobody, because the number looks plausible.

### NN4 — start where the code is oldest

`cancelOne()` in `jobs/cancel-unconfirmed.js` was already correct on every sweep
it has been part of: it filtered cancelled pledges out of its recipient list
when the two older route handlers did not, and it was the one implementation of
the board rule that never existed to diverge. It is the newest code in the
repository.

Every defect in this class has been in the oldest code. **Order an audit by
file age, not by directory listing, and expect the return to fall off sharply in
anything written recently.**

## Migrations do not run on deploy

`npm start` is `node server/app.js`. There is **no migrate step**. Every
migration must be run by hand against production:

```bash
DATABASE_URL=<production> npm run db:migrate
```

Do not assume a migration has been applied. Any commit adding one should say so
in the message and give the exact command.

---

## Known issues

- **Intermittent test failure.** `npm test` has twice reported 175/176 with no
  named failure, then passed on immediate re-run and stayed green for seven
  consecutive runs. `server/seo.test.js` and `server/static-seo.test.js` both
  reach the database through `seo.js`, so a transient Supabase connection is the
  most likely cause. Unresolved. A flaky test inside a deploy gate is a problem —
  if it recurs, isolate those two files first.

---

## Local preview

The full server needs `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
The `.env` carries the Supabase values under `VITE_` names only, so map them:

```bash
set -a; . ./.env; set +a
export SUPABASE_URL="$VITE_SUPABASE_URL" SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY"
```

Node 22+ is required — `@supabase/realtime-js` needs native WebSocket, which
Node 20 does not provide, and the server exits at boot without it. `engines`
still says `>=20`; that is stale.

For the public site without a database: `node scripts/dev-site.js` (port 4173)
serves the static pages and the built SPA with `/api/bootstrap` stubbed from
`site/_dev_bootstrap.json`.

---

## Where metadata comes from

Before editing any title, meta description or JSON-LD, check
[docs/audit/metadata-ownership.md](audit/metadata-ownership.md). It maps all 38
routes to their real source. Seven `seo.js` entries were edited for months
without rendering anywhere.
