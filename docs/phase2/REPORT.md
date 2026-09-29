# Phase 2 report: operators, roster, rate card and assignment

> **Superseded in part on 29 Sep 2026 (phase 6, `docs/phase6/REPORT.md`).** The maximum group is 8, not 12; the departure fee for "4–6, 7–9 and 10–12" travelers is now a per-departure cost line and a per-product operator fee; a product can have several numbered departures on one date.


Branch `feat/operators-roster-ratecard`. Built to the phase 2 brief and the decisions recorded in `docs/model-audit/03-migration-plan.md` (phase 2 block, 27 Sep 2026).

**Nothing here charges, refunds or pays anyone, and nothing calculates commission.** The expected operator amount is shown for reference only.

> **Superseded by phase 5 (28 Sep 2026, `docs/phase5/REPORT.md`).** The operator's amount is now the entitlement of the pool model (operating cost × (1 + operator fee)); the band fees and per-traveler amounts below were converted into cost lines by migration 061. The agency commission per seat is retired. The roster is the fallback: at GoAhead the departure is first offered to the approved agency with the most travelers on it (phase 5 part 1).

**Everything is behind the `catalogue_v2` flag.** With the flag off:
- the public site and booking behave as before;
- the operator portal answers 404;
- the phase 2 jobs do nothing;
- the new booking fields are ignored.

An integration test asserts each of these.

The admin screens work with the flag off, as phase 1's do. They are staff-only, and nothing they do reaches a traveler or an operator until the flag is on.

---

## What was built

### Part A: phase 1 gaps

- **A1. Cancellation notice.** When a date is canceled below its minimum, each traveler is emailed once (`server/catalogue-notices.js`, migration 048, table `catalogue_notices`). The email says:
  - the tour won't run;
  - either nothing was charged, or, if the booking has a paid Tab payment, it is being refunded under the current process;
  - the next open dates for the same product;
  - one alternative in the same city.

  For agency bookings, the agency's owners get a copy. Every send is recorded. A unique key per departure, booking, kind and recipient makes re-runs safe. A failed send is retried up to 5 times. The notices run straight after the status job, in the same 15-minute tick.
- **A2. 30-day GoAhead deadline for cruises and multi-day.**
  - Migration 048 moves the seeded 21 days to 30.
  - New products and type changes default to 30.
  - The per-product field stays editable as the override.
- **A3. US spelling in phase 1 copy.**
  - Catalogue became Catalog in the UI, travellers became travelers, and cancelled became canceled in admin screens, messages, the public facts panel and emails.
  - Identifiers, audit action names and database values are unchanged.

### Part B: operator record

| Where | What |
|---|---|
| `operators` | Legal and trading name, tourism license no., ETAA no., commercial registration no., tax registration no., email, phone, WhatsApp (stored only), contacts (list), notes. Status is `pending`, `active`, `suspended` or `removed`, with the reason and who changed it. `agency_id` links to the existing `agencies` row when there is one. |
| `operator_documents` | Tourism license, ETAA membership, public liability insurance and vehicle insurance. Each has a number, an expiry and a file in the private `operator-documents` storage bucket. A new upload supersedes the current one; history is kept. |
| `operator_product_approvals` | Which products an operator may be rostered on. |
| `app_users.operator_id` | Links operator logins. New roles are `operator_owner` and `operator_staff`, and the role check was widened. |

Rules:

- **Activation.** An operator is activated only when all four documents are current.
- **Daily document job** (`operator-daily`):
  - suspends an active operator whose current document has expired, with the reason `document_expired:<kind>`;
  - emails the operator and admin 30 and 7 days before an expiry, once per document, recipient and interval.
- **Replacement.** Uploading a valid replacement reactivates an operator that was suspended for an expired document. An operator an admin suspended stays suspended. Removal is always manual.
- **CTS.** Capital Travel Service is an operator like any other: no flag, no special case.

### Part C: roster

Tables: `roster_months`, `roster_plan_lines`, `roster_entries` and `roster_swaps`. Admin → Roster works like this:

1. **Plan.** Choose an operator per product and weekday for a month. Only active operators approved for the product are offered, and the server enforces the same rule on every write (`rosterEligibility`).
2. **Build.** Writes one entry per date the product runs that month, taken from its calendar rules and existing departures. Single-date overrides and approved swaps survive a rebuild.
3. **Adjust.** Change or remove single dates.
4. **Publish.** Every entry is checked again; an ineligible one blocks publishing and is listed. The deadline, the 15th of the month before, is shown, with a warning once it has passed.

Operators see only their own published dates. An operator can ask to swap a date to another eligible operator. Only an admin's approval moves it, and the approver and time are recorded.

The admin Calendar flags open and going-ahead departures with no active operator on a published roster. It also shows the rostered operator, the live assignment and open alerts.

### Part D: rate card

- **Versions.** `catalogue_rate_versions` holds versions per product, in EGP only (a CHECK enforces it):
  - per traveler;
  - land services per traveler;
  - twin and single room or cabin per trip;
  - departure fee for 4–6, 7–9 and 10–12 travelers;
  - agency commission per seat, for reference.
- **Drafts.** One draft per product. A trigger makes published versions immutable. Publishing requires the fields the product type needs.
- **Import.** Admin → Rate card → Import spreadsheet (`server/xlsx.js` and `rates.js`) reads `sawa-rate-card.xlsx`:
  - matches columns by header;
  - skips EXAMPLE rows;
  - writes each product's row into its draft;
  - reports what it skipped and why.
- **Lock at first seat.** A departure keeps the version in force when its first seat was sold. A database trigger on `pledges` sets it, together with the spec version. The assignment tick is a fallback for anything sold before a version existed. A later version never changes a departure that has already sold a seat.
- **Expected amount.** From the locked version and the manifest (`shared/operators.js` `expectedOperatorAmount`):
  - Day and one-way tours: travelers × per traveler + the band fee.
  - Cruises and multi-day: travelers × land + twin rooms × twin + single rooms × single + the band fee.
  - Before the cut-off it follows the live manifest; after the cut-off it uses the frozen one.

  The brief's examples are tested:
  - 8 × 40 + 200 = **520**;
  - two cancel before the cut-off: 6 × 40 + 150 = **390**;
  - two cancel after the cut-off: still **520**.

### Part E: assignment and manifest

- **At GoAhead**, the assignment tick (every 15 minutes, after the status job) offers the departure to the operator on the published roster for that product and date. If nobody is rostered, or the rostered operator is no longer eligible, admin gets an alert (`catalogue_admin_alerts`) instead.
- **The notice** goes to the portal and by email (the operator's email and its owner logins). It gives the product, date, spec version and seats sold. WhatsApp is not used yet.
- **Acknowledgement.** The operator acknowledges in the portal within 4 hours (12 until 27 Sep 2026, when pay at GoAhead made travelers' payment requests wait for it). If it doesn't:
  - the assignment expires and records a strike;
  - the operator gets a notice;
  - admin gets an alert and an email.

  An admin can assign or reassign from the calendar to any eligible operator. The previous holder is told, and open alerts close.
- **Manifest** (`catalogue_manifests`, `manifestFor`). One row per traveler: name, pickup point, contact number (lead traveler), nationality where the product asks for it, and safety needs. No email and no price.
  - It is live until the cut-off, then frozen. After that, late cancellations and no-shows stay on it and still count.
  - An operator sees only departures it holds live.
  - Every operator view is logged (`manifest_access_log`).
  - The daily job ends operator access 90 days after the departure. Sawa's own view stays.
- **Booking fields.** Behind the flag, the tour booking form asks for pickup point, nationality (only on products marked "needs nationality" in the Catalog editor) and health or safety needs, all optional. The public booking and agency booking APIs accept these, plus traveler names, and store them only with the flag on.

### Part F: strikes

- **Table.** `operator_strikes` records missed acknowledgement (automatic, once per assignment), unapproved substitution, shopping stop, documented service failure and other.
- **Entry.** Admins add and void strikes on the operator screen; a void needs a reason.
- **Counts.** 90-day counts appear on the operator list, the operator screen and the roster screen. **3 or more are flagged for fewer roster days. Nothing is automatic beyond the flag.**

### Operator portal

`src/OperatorDashboard.jsx`, for `operator_owner` and `operator_staff` logins. It has four sections:
- **Assignments:** acknowledge, see the expected amount, open the manifest.
- **Roster:** own dates, request a swap.
- **Notices.**
- **Documents & strikes.**

Super admins create operator logins from the operator screen, the same way agency logins are created.

---

## Migrations

Both migrations are additive and reversible. Each has a rollback in `server/db/down/`. Each was run, re-run (no change), rolled back and re-applied on a scratch Postgres.

| Migration | Adds |
|---|---|
| `048_catalogue_notices` | `catalogue_notices`. Also moves the seeded cruise and multi-day deadline from 21 to 30 days. The rollback drops the table and leaves the deadlines at 30, the decided value. |
| `049_operators_roster_rates` | `operators`, `operator_documents`, `operator_document_reminders`, `operator_product_approvals`, `operator_strikes`, `operator_notifications`, `roster_months`, `roster_plan_lines`, `roster_entries`, `roster_swaps`, `catalogue_rate_versions`, `catalogue_assignments`, `catalogue_admin_alerts`, `catalogue_manifests` and `manifest_access_log`. New columns: `app_users.operator_id`; `catalogue_products.needs_nationality`; `catalogue_departures.rate_version_id` and `rate_locked_at`; `pledges.pickup_point`, `nationality` and `safety_needs`. Also the lock-at-first-seat trigger, and the wider `app_users` role check. The rollback drops all of it, deletes operator logins, and restores the original role check. |

Apply with `npm run db:migrate`. Nothing in this branch runs a migration against production.

## How existing tables were extended (not duplicated)

| Need | Existing | What was done |
|---|---|---|
| Operator company | `agencies` (one table for agencies and operators, `relationship = 'operator'`) | New `operators` table for what only operators have (documents, status, approvals, roster), linked 1:1 to `agencies` by `agency_id` where the company already exists. Nothing is copied except the starting contact and license numbers. |
| Operator logins | `app_users` with agency roles | Same table: two new roles and an `operator_id` column. |
| Traveler names on a manifest | `pledges.traveller_names` (migration 007) | Reused. |
| Pickup, nationality, safety | none | Three nullable columns on `pledges`. |
| Rate and spec lock | `catalogue_departures.spec_version_id` (047) | `rate_version_id` alongside it; the same trigger sets both. |
| GoAhead | `catalogue_events` `go_ahead` (047) | The assignment tick consumes these events. |

**Mapping run by 049.** Each of these becomes a `pending` operator, with contact and license numbers copied:
- every `agencies` row with `relationship = 'operator'`;
- every agency named as a listing's operator;
- Capital Travel Service.

Their documents must be uploaded before activation.

## What existing bookings lack

For a manifest, existing `pledges` rows lack:

- **Pickup point.** Never collected. The spec's pickup area is the only fallback.
- **Nationality.** Never collected. Needed for products with site tickets (mark them in Admin → Catalog → "needs nationality").
- **Safety needs.** Never collected.
- **Names beyond the lead traveler.** `traveller_names` is empty on most bookings, so the manifest lists the lead's name and "guest 2", "guest 3" and so on.
- **Contact number.** Optional on agency bookings and on public bookings without phone verification, so some rows have none.

All of these show as "—" on the manifest. Only bookings made with the flag on will carry the new fields.

## Rate card import (`docs/model/sawa-rate-card.xlsx`)

- **21 products imported** as drafts: 16 day tours and 5 cruises or multi-day. Catalog numbers 1–21 all match the seeded catalog.
- **2 EXAMPLE rows skipped**, one per sheet.
- **Every amount is blank.** No draft can be published until the amounts are entered in Admin → Rate card.
- **The Assumptions sheet says USD.** Amounts are imported as EGP, as decided; the import warns about this.
- **Columns not imported:**
  - retail prices (pricing is a later phase);
  - the Sawa margin and "loss at 4" check columns, and "cost of single promise" (calculated checks);
  - "GoAhead deadline (days before)" on the cruise sheet (set per product in the Catalog).
- **The Roster sheet is a template** and was not imported.

## Settings and how to switch on

1. Apply migrations 048 and 049.
2. Add the operators' documents and approvals, and activate them.
3. Enter the rates and publish them.
4. Plan and publish the roster.
5. Set `FEATURES=catalogue_v2`.

The document upload uses the Supabase service role; the `operator-documents` bucket is created privately on first upload.

## What the payouts phase needs from this one

- **The amount owed per departure** is `expectedAmountFor(departureId)`:
  - the frozen manifest's count and rooms;
  - the locked rate version;
  - the band.

  Payouts should settle against the frozen manifest and the locked version, never recompute from live bookings.
- **Band for a run below the minimum.** A departure run below its minimum on an admin override is paid at the 4–6 band. `bandFor` already returns 4–6 for fewer than 4.
- **The operator to pay** is the one holding the acknowledged assignment (`catalogue_assignments`, `state = 'acknowledged'`). A departure with only an expired or replaced assignment has no operator to pay and needs an admin decision.
- **Deductions.** Strikes are records only; nothing deducts money. If a strike should reduce a payout, that is a new decision.
- **Commission.** Agency commission per seat is stored on the rate version for reference only. Nothing calculates or books it.
- **Currency.** Operator rates are EGP; travelers still pay in EUR. Payouts need the EUR→EGP rule (rate source and date), which is not decided.
- **Existing settlements** (`settlements`, cost sheets, the Wednesday payout run) cover the old direct model. Payouts must choose whether catalog departures go through them or replace them for these departures.
- **Operator bank details and invoices** are not collected yet.

## Tests

- **`server/operators-rules.test.js` (unit):**
  - the three worked examples;
  - bands, rooms, the roster deadline and the strike window;
  - the xlsx reader and the parser against the real rate card.
- **`server/operators.integration.test.js` (Postgres):**
  - 049 maps CTS;
  - document expiry suspends, and a suspended operator can't be planned;
  - reminders are sent once, and a replacement reactivates;
  - roster plan, build, publish, own-only visibility, swap approval with the approver recorded, and the unrostered flag;
  - import skips EXAMPLE rows, lock at first seat, and a new version leaves sold departures alone;
  - GoAhead leads to an assignment and a notice by portal and email; with nobody rostered, an alert;
  - a missed acknowledgement leads to a strike, an alert, an admin reassignment and acknowledgement;
  - 3 strikes are flagged;
  - the manifest is live, the worked examples hold, it freezes at the cut-off, another operator is denied, views are logged, and access ends after 90 days;
  - with the flag off: jobs skip, the portal returns 404, and booking fields are ignored; with it on, they are stored.
- **`server/catalogue-notices.integration.test.js`:** the cancellation notice (A1).

The full gate (`node scripts/ci-gate.js` with `TEST_DATABASE_URL` on a real Postgres) passes.

## Not in this phase

- Charging, refunds, payouts, commission.
- WhatsApp notices (the number is stored only).
- Automatic roster reduction or removal for strikes.
- Operator self-service document upload (operators send renewals to Sawa; admin uploads them).
