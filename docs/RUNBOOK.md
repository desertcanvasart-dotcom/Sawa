# Runbook

## Before anything ships

```bash
npm run preflight -- --base=https://sawa.tours
```

**Pass `--base`, or the answer is about localhost.** `smoke` and `audit:claims`
default to `http://localhost:8795`, so a bare run says nothing about production.
The runner prints the target in its verdict and lists what it could NOT check
(`SMOKE_TOKEN`, `PRODUCTION_DB_HOST`) — CCC3.

One runner prints one verdict. It used to be a `&&` chain in which every step
printed its own success line and nothing printed the whole, which is how
"preflight green" got reported for a command that exits 1.

Runs, cheapest first:

| Step | Catches |
|---|---|
| `check:constants` | group-size copy drifting from `shared/group-size.js` |
| `check:catch-handlers` | **a handler that discards a failure** — `.catch(() => {})`, empty `catch {}`, and the annotated form `catch { /* reason */ }`. A comment is not an observable effect. See `docs/audit/swallowed-errors.md` (AAA1). |
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

## A gate that cannot be passed will be routed around

XX2. The pre-commit hook blocked every commit under Node 22, not only red ones.
I switched Node versions to get past it and carried on.

That is the benign version of `--no-verify`: nothing was bypassed, the suite did
run, the commit was legitimate. **And the gate was left broken behind me.** The
next person hits the same wall with less patience.

**The route-around is usually invisible in the diff.** Nothing in that commit
recorded that the hook had failed or why; the only trace was a sentence in the
report. A gate that has been quietly worked around looks exactly like a gate
that is working.

**Rule:** when a gate blocks something it should not, fixing the gate is the
task — not getting past it. If getting past it is unavoidable, say so in the
commit message, because that is where the next person will find out it is a
known problem rather than their own.

---

## A verification is evidence about the environment it ran in

XX1.3. Every test result in this project until #80 was produced on Node 20 —
a runtime the server cannot boot on. The ad-hoc verifications were split across
both, and nothing recorded which was which, so establishing what still held
meant reconstructing every command from the transcript.

See `docs/audit/environment-of-record.md` for that reconstruction. It should not
need doing twice.

**Rule:** record the runtime alongside the result — in audit documents and in
commit messages — so an environment change makes the affected evidence findable
rather than invisible. `npm test` now prints `# node <version>`, and
`check:node` fails `preflight` early so a mismatch surfaces as itself rather
than as failing tests.

Priority when re-confirming after a runtime change: anything touching the
database driver or connection handling, WebSocket behaviour, async ordering —
and **anything whose result was a negative finding**, because a negative is
precisely what a runtime difference can manufacture.

### YY1 — rank incompatibilities by how quietly they fail, not by how big they look

The Node split was **benign because it failed loudly.** The server refused to
start, so the wrong runtime could never quietly produce a result. Every hour it
cost was spent on discovery, not on damage.

`canceled` versus `cancelled` is the same class of mistake — two things that
must agree and did not — and it cost incomparably more: identical shape, no
failure anywhere, and confidently wrong numbers on every public page for the
whole life of the codebase.

**An incompatibility that breaks is self-limiting. One that degrades silently is
unbounded.**

So a sweep should be asking **"what could disagree without failing?"**, not
"what could fail". Known instances, all of the first kind:

| | |
|---|---|
| `canceled` / `cancelled` | fixed — LL1, and `check:status-literals` closes the class |
| five hand-written copies of the board rules | fixed — NN2.1, one authority plus a parity test |
| host timezone vs Africa/Cairo | fixed — YY3, `TZ` pinned and boundary cases asserted |
| repository schema vs applied schema | fixed — SS3.1, four states |
| `emitDepartureSync` on some write paths only | **open** — TT1/TT2 |
| server rules re-implemented in `AgencyDashboard` / `AdminDashboard` | **open** — NN2.3–2.5 |
| production PostgreSQL major vs the 17.10 every proof ran on | **open** — not pinned by this repo |

---

## A qualification must meet the same evidence standard as the premise

I reported "migration 023's file is in `main`" under a banner explaining that
merging is not applying, with the exact `db:migrate` command. The banner was
reasoned from B5, which had been verified. The premise — that a migration file
existed — had not been checked at all. It did not.

**Careful hedging is itself a signal that someone checked.** A blunt wrong claim
invites scrutiny; a carefully qualified wrong claim deflects it, because the
qualification reads as evidence of diligence about the whole statement. Mixing a
verified caveat with an unverified premise produces something that reads as
entirely verified.

The instruction went to the client three times and was meaningless every time.

**Rule:** a qualification is held to the same evidence standard as the thing it
qualifies. Hedging carefully is the moment to ask whether the thing being hedged
was ever observed.

---

## A negative grep proves nothing until the positive case has been shown

Sits underneath "never verify with a shortcut when the tool exists", and is
narrower.

While verifying migration 023 I checked whether a CHECK constraint rejected a
bad value by grepping the output for `violates check constraint`. Nothing
matched, so I reported the constraint **missing**. It was not — the `INSERT` had
failed earlier, on a null `id`, and never reached the constraint at all.

**An absent string is not a result.** It means either "the thing did not happen"
or "the thing happened and did not say so" or "something else happened first",
and a grep cannot tell them apart.

**Rule:** before reading a negative result as a verdict, show that the positive
case produces the string being searched for. This is W3 — prove the check fires
— applied to a one-off grep rather than to a committed check. The discipline is
identical and the ad-hoc case is the one where it gets skipped.

---

## Land the read guard before the write change

LL3 put a departure-status guard on `/api/public/bookings/:code` ahead of
fixing the write path. The argument at the time was defensive: protection if
the write path regressed later. That turned out not to be the reason it
mattered.

**It is what made the write change safe to apply at all.** PP5 transitions a
cancelled departure's pledges to `cancelled`. Without LL3's ordering already in
place, every affected traveller's booking page would have flipped from
"Confirmed" to **"Booking cancelled"** — telling them they had cancelled, when
the company had. The correctness fix would have produced a new falsehood on the
same surface it was meant to repair.

**Rule:** a read guard is safe under any subsequent write state. A write change
without one propagates into every surface that reads it, and the propagation is
invisible in the diff of the write.

So when both are needed, the read guard ships first. At the time the sequencing
looked like a preference. It was not.

The same shape appeared inside PP5 itself: the admin route read its recipient
list *after* the transaction, filtered on `status <> 'cancelled'`. Adding the
pledge transition without moving that read would have emptied the list on every
human-initiated cancellation — nobody notified, no cron log to catch it, and the
change looking like a correctness improvement.

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

## Node 22, and why the version is now pinned

The repository was in two minds and neither was written down:

- **The server could not boot on Node 20 at all.** `@supabase/realtime-js`
  throws *"Node.js 20 detected without native WebSocket support"*.
- **The test script only worked on Node 20.** `node --test server/ src/` — Node
  22 does not resolve a bare directory there, and reports two failing "tests"
  that are the two directories. It does not look like a toolchain problem.

So the tests ran on 20, the server ran on 22, `engines` said `>=20`, and nothing
said any of it. The pre-commit hook runs `npm test`, so **under Node 22 it
blocked every commit, not only red ones** — a gate failing closed on a toolchain
difference. That is worse than no gate: the first person under time pressure
reaches for `--no-verify` and it is gone permanently. Switching Node versions to
get past it is the benign version of the same move, and it leaves the gate broken
for the next person.

Now: `.nvmrc` pins 22, `engines.node` is `>=22` — which documents what production
already runs, since the server cannot start on less — `npm test` enumerates its
own files and behaves identically on both, and `check:node` fails `preflight`
early with the reason rather than letting a version mismatch surface as failing
tests.

`npm test` prints the Node version it ran under. A check whose result depends on
an unstated environmental condition is not a verdict.

---

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

---

## Open directives

[docs/audit/open-directives.md](audit/open-directives.md) is the list of agreed
work that is not yet done, and the client answers each item waits on.

**Anything intended to gate a merge, or to be picked up in a later session, goes
there before the branch is cut.** BBB1 was raised as a merge blocker for #85,
lived only in conversation, and did not block anything — the session that merged
had no way to know it existed. Chat is not a record.
