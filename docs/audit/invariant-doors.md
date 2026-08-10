# DIR-5 — Invariants that hold through one door

**10 August 2026.**

The productive question is not *"what could fail"* but **"what could disagree
without failing."** A loud incompatibility is self-limiting: it breaks, someone
fixes it. A silent one is unbounded — it accumulates for as long as nobody
happens to look.

Each entry below is an invariant that holds because everything currently comes
through one place. The column that matters is **what skips it**.

---

## Closed

| Invariant | Door | What skipped it | Closed by |
|---|---|---|---|
| A departure write tells the mirror | API route handlers | **the scheduled cancel job** — four writers never reached `emitDepartureSync` | TT1 — `withDepartureWrites` emits after COMMIT. **Honest limit, in its own header:** a caller must still call `touch`. A detector, not an impossibility. |
| The board rules are one rule | modules that import them | the static pages, which cannot import | NN2.1 — generated `assets/rules.js`, `check:rules`, and a parity test |
| The group-size numbers are one number | the same | twenty static pages | `check:constants` |
| A tour's URL is one rule | the same | **eight static pages**, five carrying a 301-loop defect | DIR-8 — generated `assets/slug.js`, `check:slug`, parity test executed rather than read |
| Fire-and-forget email goes through one wrapper | `sendEmailInBackground` | any direct `sendEmail(...).catch(() => {})` | AAA1.2 — asserted by `email-contract.test.js` |
| Every mutating route is audited | route handlers | three routes, incl. admin product creation | DIR-1 — `check:audit-coverage` |
| **Row-level security covers every table** | **tables that existed when 024 ran** | **any table created afterwards.** `REVOKE` carries forward via `ALTER DEFAULT PRIVILEGES`; **RLS does not.** | 026 enables RLS on itself; `migration-rls.test.js` asserts every table created after 024 does |
| **Every empty handler is caught** | **the scanner's roots** | **`site/assets/*.js`** — see below | roots widened to `site`; `invariant-doors.test.js` asserts no JS sits outside them |

### The door found while writing this document

`check:catch-handlers` scanned `server`, `src`, `scripts`, `shared`. **Three
hand-written browser scripts live in `site/assets/` and load on every page:**
`analytics.js`, `consent.js`, `sawa.js`. None had ever been scanned.

`consent.js` held **three empty handlers**, and one of them is the worst instance
of AAA1 found in this project:

```js
listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
```

The listeners are the things that **act** on consent — the referral store that
attributes a partner's commission, and analytics loading. A listener that threw
was dropped silently and the next one ran, so **consent could be granted and the
thing it grants never happen**, with nothing anywhere saying so. In the one
module whose failure is a compliance question.

Fixed, with every listener still running: one failing must not stop the others.

---

## Open

| Invariant | Door | What skips it |
|---|---|---|
| **A departure served to a client has been normalised** | `enrichDeparture` | **caller discipline.** `presentDeparture(enriched, user)` names its parameter `enriched` and spreads whatever it is given — 15 call sites, and the expectation is documented in a parameter name. **DIR-6's job:** move it to the boundary. |
| Every state change is audited | **the route** | `check:audit-coverage` is per-ROUTE. A write inside a job, a helper or a one-off script is invisible to it — including `reset-fabricated-inventory.js`, which deletes. |
| Copy is US English | **static files** | `constants.test.js` iterates `pages()`. **All 16 product descriptions come from the database and have never been checked** — 30 findings live (PPP1). |
| The auditor cannot write | `readOnlyPool` | anything else querying production. The X1 guarantee is per-connection, not per-process. |
| Interim copy has one owner | `data-copy` markers | a page that writes the agreed string literally. `undecidedKeysUsed` catches a *null* key rendering; it cannot catch a correct string hard-coded past the marker. |
| `audit_log` is append-only | the 024 triggers | a superuser dropping the trigger. Deliberate and visible, but not impossible — noted so nobody reads "append-only" as stronger than it is. |
| Extraction uses the auditor's helper | calling `visibleText` | any script re-deriving it. Cost one wrong measurement — **16 of 16 pages "name a company"** when the answer was 0, because the second script matched JSON-LD (PPP2). |

---

## The pattern

Seven of the fifteen were closed by generating the copy and checking it is
current. That is the repeatable answer where the door exists because something
**cannot** import — a static page, a browser script.

Where the door exists because a caller **must remember**, generation does not
help and the honest options are two: move the invariant to the boundary so it
cannot be skipped (DIR-6), or accept a detector and say so in its own header,
which is what `withDepartureWrites` does.

**The failure mode this register exists for:** an invariant is discovered, fixed
at every site that exists that day, and a new site appears later through a door
nobody listed. 024 → 026 is that story with three days between the two halves.
