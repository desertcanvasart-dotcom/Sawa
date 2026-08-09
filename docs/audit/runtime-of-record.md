# XX1 — Which runtime the evidence was produced on

**9 August 2026.**

The toolchain split (WW3): the server could not boot on Node 20 at all, `npm
test` only worked on Node 20, `engines` said `>=20`, and nothing said any of it.

The suite re-ran on Node 22 when that was fixed — **247/247**. But the suite is
not where this project's strongest claims came from. The load-bearing evidence
has been ad-hoc, run at a terminal, and none of it re-ran when the suite did.

---

## First, a correction to the premise

The assumption was that the ad-hoc runs were "almost certainly on Node 20".
**They were mostly on Node 22**, and for a reason that was invisible at the
time: anything that started the server *had* to be, because the server does not
boot on 20. The commands carry `PATH=~/.nvm/versions/node/v22.21.1/bin:$PATH`.

So the exposure is narrower than feared, and differently shaped: it is the
verifications that did **not** need a server which ran on 20.

That is worth stating precisely, because "probably all wrong" and "these three
were on the other runtime" call for different work.

---

## XX1.1 — Every terminal-run verification, with its runtime

| Verification | Runtime | Status |
|---|---|---|
| JJ2 cancel-job rehearsal, ephemeral database | **22** | ✅ **re-run on 22 anyway** — dry refrains, live releases the booking, terminal state holds |
| Schema parity diff, rehearsal vs production (116 columns) | **22** | unaffected — `information_schema` read |
| Production row counts / `email_log` | **22** | ✅ **re-confirmed on 22** |
| Bug A rendered proof (`/departures`, `/tour`, `/goahead`) | **22** (server) | ✅ **re-confirmed on 22** |
| LL3 four booking states | **22** (server) | ✅ **re-confirmed on 22** (`DATEOFF` → `date_cancelled`) |
| NN2.1 board parity across three pages | **22** (server) | ✅ covered by the committed parity test, now green on 22 |
| PP5 end-to-end, job releases the pledge | **22** | ✅ **re-run on 22** |
| SS3.1 four-state schema check | **22** | unaffected; states 1, 2 and 4 re-observed this turn |
| 023 migration + constraint exercises, PostgreSQL 17 | **22** | driver-adjacent — see below |
| **X1 read-only session, SQLSTATE 25006** | **20** ⚠️ | ✅ **RE-RUN on 22 — identical** |
| **Generated browser rules vs server, cross-check** | **20** ⚠️ | ✅ **RE-RUN on 22 — identical**; also now a committed test |
| JJ3 zero-suppression browser checks (`:4173` dev-site) | **unknown** | ⚠️ cannot be determined — see below |
| Production `/api/modes` verdict, 9 Aug | **n/a** (curl) | not a Node result |
| The 6 August internal send | **n/a** | historical, in `email_log` |

---

## XX1.2 — What was re-confirmed, and what was judged unaffected

### Re-run, because the runtime could plausibly matter

**X1's read-only proof.** The highest-priority one: it is `pg` driver and
connection-option behaviour, and its result was a **negative finding** — writes
rejected — which is exactly what a runtime difference can manufacture. Node 22
and Node 20 side by side, same ephemeral database:

```
runtime v22.21.1        runtime v20.20.2
  read  : 1 row(s)        read  : 1 row(s)
  INSERT: rejected 25006  INSERT: rejected 25006
  UPDATE: rejected 25006  UPDATE: rejected 25006
  DELETE: rejected 25006  DELETE: rejected 25006
  CREATE: rejected 25006  CREATE: rejected 25006
```

Identical. The guarantee is the database's, not the runtime's, which is why —
but it was worth showing rather than arguing.

**The generated browser rules against the server.** Ran on 20 originally. Pure
JavaScript, no driver, no timing — but its result was also a set of negatives
("agrees on every case"), so it was re-run. Identical, and it is now a committed
test that runs on 22 with the suite.

**The cancel-job rehearsal and the PP5 end-to-end.** Already on 22; re-run in
full anyway because they are the two that touch the write path.

### Judged unaffected, with the reason

- **The schema parity diff** and the **production row counts** read
  `information_schema` and `count(*)`. A runtime difference cannot change what
  Postgres reports about its own catalogue. Re-confirmed the counts regardless,
  because it cost one query.
- **The 023 constraint exercises** were run through `psql`, not Node, apart from
  the `migrate.js` invocation itself — which ran on 22.
- **Browser rendering.** The rendering runtime is Chrome. Node's only role was
  serving, and every server in those checks was on 22 because it could not have
  started otherwise.

### ⚠️ Cannot be determined

**The JJ3 zero-suppression browser checks** used the dev-site preview on
`:4173`, which was already running when I attached to it. I did not start it and
cannot establish its Node version.

Judged low risk — `scripts/dev-site.js` is `express.static` plus one route
serving a JSON file, and the assertions were about rendered DOM. **But "low
risk" is a judgement, not an observation**, and it is recorded as such rather
than folded into the confirmed column.

The substance was re-confirmed this turn on a Node 22 server anyway: `/departures`
renders State A with the stat blocks dropped and no bare zero.

---

## XX1.3 — The rule

**A verification is evidence about the runtime it ran on.**

Nothing in this project recorded that, so when the runtime turned out to be
split, there was no way to tell which results were affected without
reconstructing every command from the transcript. That reconstruction is what
this document is, and it should not need doing twice.

**From here:**

- `npm test` prints `# node <version>` on every run.
- `check:node` fails `preflight` early, so a mismatch surfaces as itself.
- Any audit document reporting a terminal-run result names the runtime.
- Any commit message reporting one names it too.

The point is not that Node 20 results were wrong — with one exception re-run
above, they were not. It is that **the question "which of these still holds?"
should be answerable by reading, not by re-deriving.**
