# Phase 5 report: the final business model

> **Superseded in part on 29 Sep 2026 (phase 6, `docs/phase6/REPORT.md`).** One price per product (4–8 travelers) replaces the three group-size tiers as the default, the tier-drop refund is not in the active flow for one tier, the operator fee is a required per-product percentage with no default (and can be overridden for one departure), euro tier prices round **up**, and the maximum group is 8. The pricing code keeps tier support.


28 Sep 2026. Built to the final model brief ("The Sawa business model is now final"), which wins over older documents where they disagree. Everything in parts 1 and 2 is behind `catalogue_v2` and applies to **catalog departures only**. The items marked LIVE in part 0 are not behind the flag.

**Nothing here moves money.** It records what is owed, asks travelers to pay, and produces statements. Finance pays by bank transfer and records each payment. Tab is used by hand: every refund is an ops task. No migration was run against production.

| Part | What | PR | State |
|---|---|---|---|
| 0 | Earlier requests, re-checked; three gaps fixed | [#235](https://github.com/desertcanvasart-dotcom/Sawa/pull/235), [#236](https://github.com/desertcanvasart-dotcom/Sawa/pull/236) | LIVE, merged |
| 1 | Who operates a departure | [#234](https://github.com/desertcanvasart-dotcom/Sawa/pull/234) | merged (flag-gated) |
| 2 | The pricing and money model | branch `claude/wizardly-shannon-jtm578` | PR open, not merged (flag-gated) |
| 3 | Documents | the same branch | with part 2 |

---

## Part 0: earlier requests

Each item was checked against `main` by reading the code paths, not by grepping for names.

| # | Request | State | Where |
|---|---|---|---|
| 1a | Payment requests only after the operator acknowledges | done (#225) | `requestPayment` returns nothing without an acknowledged seller (`sellerOf`); requests are made on acknowledgement (`onOperatorAcknowledged`) |
| 1b | Reassignment after payment: notify, reissue the receipt (old one superseded), full refund within 48 h | done (#225) | `reissueForSellerChange`, `seller_change_offers` (migration 053), `POST /api/public/bookings/:code/seller-change/cancel`. The traveler is told when the new operator acknowledges |
| 1c | EUR at the CBE rate on the charge date, as the margin report | done (#225); in part 2 the one calculation | `fxResult` in `shared/pool-model.js`; each EUR movement at its day's rate |
| 2 | Settlements exclusion by departure type: list, API, payout run; cost sheets for force majeure; "can be retired"; CTS query | done (#229) | `loadSettlements`, the 409s on catalog departures, the payout run skips and refuses them; `legacyOpenDepartures().canRetire`; `docs/ops/cts-legacy-settlements.md`. There is no scheduled Wednesday job: the run is admin-triggered, and the exclusion is in it |
| 3 | Fake bookings: email confirmation, Turnstile, 5 attempts per IP per hour | done (#233); **gap fixed in #236** | Public **date requests** still wrote a pending booking at once. They now wait for the email confirmation too (migration 060) |
| 3 | Turnstile keys | done | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Railway → the web service → Variables (steps in `docs/ops/stop-fake-bookings.md`). Without the secret the check is skipped with a logged warning |
| 4 | Duplicate departures: the cause, "Merge into…", 24 h undo | done (#230); **gaps fixed in #235** | Two requests for a new day at the same moment could each create a date (no row to lock): now a transaction lock on tour and day, proven with ten at once. Held (unconfirmed) bookings now move with a merge. The button now reads "Merge into…" |
| 4 | "Join my group" links; cluster flags | done (#231, #232) | `booking-parties.js`; `booking-integrity.js` (3+ single-seat reservations in 6 h sharing device, /24 or phone country; flagged, never refused) |

## Part 1: who operates a departure

Merged as #234. At GoAhead the departure is offered to the approved, active agency-operator with the most travelers on it (tie: the earliest first reservation), with 4 hours to acknowledge; declined or timed out, it passes on, then to the rostered operator; a missed acknowledgement is a strike only for a rostered operator; acknowledgement is final; payment requests only after it.

- **The payment deadline** (48 h, capped at the cut-off) starts when the payment link reaches the payer, as it has since phase 4. With tab-manual the request row is made first and the link a little later; the deadline counts from the link, so the traveler always has the full window. Tell me if "from the request" should mean the row instead.
- **Paid twice** (point 5) is built in part 2: the operator statement carries the entitlement, the agency statement the pool share, and each says the other exists.

## Part 2: the pricing and money model

### One calculation

`shared/pool-model.js` holds the arithmetic, with no database and no clock. The rate card editor, the payment requests, the operator statement, the agency statements, the margin report and Finance all call it; `server/pool-settlement.js` feeds it a departure and records the result in `catalogue_departure_economics`, which the statements read.

Per departure, from the manifest at the cut-off, in EGP:

| Line | Rule |
|---|---|
| Tier | by headcount; below 4 (a guaranteed departure) the first tier |
| Revenue | headcount × the tier's EGP price (nominal; never the EUR collected) |
| Operating cost | per-group lines + headcount × per-traveler lines |
| Entitlement | operating cost × (1 + operator fee %), the operator's |
| Commission | revenue × commission %, the collecting agent's; payment costs come out of it |
| Pool | revenue − entitlement − commission |
| Pool per traveler | pool ÷ headcount. An agency-sold place (the operator's own included) earns it for the agency; a direct place for the agent. A late cancellation with a fee kept earns half |
| Negative pool | no agency share; the agent pays the shortfall (Minimum Departure Guarantee) |
| FX line | EUR collected, each amount at the CBE rate on its day, − nominal revenue. The agent's only |

**The worked examples are tests**, both as unit tests (`server/pool-model.test.js`) and end to end on a real Postgres (`server/pool-model.integration.test.js`):

| Case | Result |
|---|---|
| 4 travelers | operating cost 7,000; entitlement 7,350; commission 1,016; pool 1,794 (448.5 each) |
| 8 travelers, A operating (3), B (2), 3 direct | revenue 19,896; entitlement 10,388; commission 1,989.6; pool 7,518.4 (939.8 each). A: 10,388 + 2,819.4; B: 1,879.6; agent 1,989.6 + 2,819.4 = 4,809.0 |
| 9 / 10 travelers | pool 9,014.7 / 7,710, with the "adding a traveler shrinks the pool" warning |
| 2 travelers | pool −1,308; guarantee 1,308; agencies nothing |
| Tier drop 7–9 → 10–12 after payment | €3 a seat refunded to each paid traveler, as a Tab ops task; the later bookings pay €47; nobody pays more |
| FX | a different CBE rate changes only the agent's FX line |
| Agency statement | EGP shares to EUR at the statement date's rate (2,819.4 at 49.5 = €56.96) |

### What changed where

- **Rate card** (`server/rates.js`, Admin → Rate card): per version, tiers (from, to, EGP price, operator fee %), any number of cost lines (per group or per traveler, an amount per tier), the commission (default 10%, per product version) and the published EUR rate. The editor shows the live table for 2 to 12 travelers with both warnings. Publishing needs every cost amount and fee; prices are all or none, and prices need the EUR rate.
- **Tour pages** (`server/catalogue-public.js`): each tier in whole euros, "€51 per person, €50 from 7 travelers, €47 from 10", with the refund promise. Publishing a rate now clears the public caches (it didn't before; found by the tests).
- **Booking** (`stampBookingPrice`): keeps the published EUR rate and is quoted its tier.
- **Payment request** (`payerFor`): the EUR price of the tier the departure is in when it is sent, at the booking's rate. An agency on billing pays the full price; its invoice is updated to it.
- **Cut-off** (`runPoolTick`, after the manifests freeze): the tier is fixed; a cheaper tier refunds the difference (`payment_refunds.kind = 'tier_difference'`, once per payment).
- **Operator** (`expectedAmountFor`): the entitlement. The advance (50% on acknowledgement), the balance, deductions, reimbursements and set-off are unchanged. The statement and its PDF show the whole calculation in EGP and, for an operator whose agency sold places, that its pool share is paid on its agency statement.
- **Agencies** (`server/commissions.js`): an agency booking's row is a pool row, decided when the departure is over. The monthly statement (by the 10th) adds shares in EGP, pays them in EUR at the CBE rate on the statement date, and lists each departure's revenue, operating cost, operator fee, entitlement, commission, pool and pool per traveler. A place released unpaid, or canceled before payment, is void at once.
- **Margin report and Finance** (`server/finance.js`): the agent's result per departure in EGP: commission + its pool − guarantee − payment costs + FX.
- **Fixed per-seat commission**: retired everywhere for new bookings. Rows made before migration 061 keep their per-seat rules.

### Migration 061 (additive, reversible)

New columns on `catalogue_rate_versions` (`tiers`, `cost_lines`, `commission_pct`, `eur_rate`), `pledges.published_eur_rate`, pool columns on `agency_commissions` and `commission_statements`, the `tier_difference` refund kind, and the `catalogue_departure_economics` table (RLS on). The old rate columns are untouched, so the down file (`server/db/down/schema_061_pool_model.down.sql`) loses only what was entered in the new ones.

**It converts every existing version**: band fees → one per-group line; per-traveler amount (or land services) → one per-traveler line; a twin room → half its rate per traveler; operator fee 0%. The operator is paid exactly what the old card paid. Selling prices were never on the operator card, so they are left blank. What was converted is recorded on each version: Admin → Rate card → "What the conversion changed", or `node scripts/pool-migration-report.js` (read-only). The spreadsheet import converts the same way (`convertLegacyRate`, tested to agree with the SQL).

### Judgement calls, for you to confirm

1. **Rooms.** The brief's cost-line bases are per group and per traveler. A single-room rate has no place in that and is reported, not carried; a twin room is carried as half per traveler. Add a line by hand if a product needs it.
2. **A version without prices** can be published: the operator is paid, the tour page keeps the listing's price, and the pool waits. Agency rows stay pending and statements hold with the reason ("no selling prices for …"), rather than paying agencies nothing. Enter prices before selling.
3. **Pool per traveler is pool ÷ the headcount at the cut-off**, as the brief says. The v2 Agency Sales Agreement (definitions) says "divided by the number of Travellers who travel". They differ only when someone cancels late: the brief's rule is built.
4. **An unpaid seat that travels** ("travel and collect later", phase 4) counts as travelled for its agency's share.
5. **No fee setting**: payment costs count as 0 and the margin says the setting is missing, as before.
6. **Agency statements are in EUR for every agency**, including Egyptian ones (they were EGP before). The v2 agreement marks this as subject to the lawyer's advice on paying Egyptian agencies in EUR.

### The v2 agreements

The `.docx` in `docs/model/` is still the 27 Sep version (v1). I read v2 from your doc "Sawa agreements, v2: Online Era as collection agent" directly, and the model matches it. Two places in v2 still carry the older wording and should be fixed before it goes to the lawyer:
- Overview, "How a departure works", step 2: "assigned to the rostered operator" (the roster is now the fallback);
- Overview, step 5: "pays the balance… less its commission and the agency commission" (agencies are now paid from the pool).

Put the v2 Word file in `docs/model/` when you can; nothing in the code reads it.

## Part 3: documents

- `docs/legal/terms-catalogue-draft.md` → v3: the operator is normally an agency on the departure (C1.2); acknowledgement makes the choice final and no payment is asked before it (C3.2, C4.1); the tiered price, the published EUR rate kept at booking, the refund of the difference and "never charged more" (new C4a); agency billing pays the full price (C4.6); lawyer questions 24–26.
- `docs/launch/catalogue-v2-runbook.md`: the rate card step rewritten for the model and migration 061; the roster step says it is the fallback.
- Superseded notes where the fixed commission or roster-first assignment appear: `docs/phase2/REPORT.md`, `docs/phase3/REPORT.md`, `docs/phase4/REPORT.md`, `docs/phase4/payments-readiness.md`, `docs/model-audit/02-gap-analysis.md`, `docs/model-audit/03-migration-plan.md`. `docs/RUNBOOK.md` mentions neither.

## To deploy

1. **LIVE, already merged:** `DATABASE_URL=<production> npm run db:migrate` applies **060** (date requests wait for the email confirmation). Create the Turnstile keys if not done.
2. **Flag-gated, after the part 2 PR merges:** the same command applies **061**. Then Admin → Rate card: check the conversion, enter prices, fees, cost lines and the EUR rate, publish. Link each agency that operates to its operator record (`operators.agency_id`).

## Tests

Full `ci-gate`: **GREEN, 1154/1154** on the part 2 branch; `vite build` passes. New: `server/pool-model.test.js` (15), `server/pool-model.integration.test.js` (7). Phase 3 and 4 integration tests that asserted the per-seat commission and the EUR distribution now assert the pool model.
