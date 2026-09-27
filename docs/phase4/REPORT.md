# Phase 4 report: pay at GoAhead ("mode C") and the cancellation tiers

Built on `feat/pay-at-goahead`, from main after phase 3 (#222). Everything is behind `catalogue_v2` and applies to **catalog departures only**. The design is `docs/phase4/payments-readiness.md` section 9 (approved 27 Sep 2026), with the decisions recorded there and below.

**Nothing here calls a payment provider.** Tab is used by hand: every step that needs Tab is a task for ops. No migration, seed or payment call was run against production, and nothing sent a real message: tests run on a local Postgres and capture emails.

## Decisions built

From section 9 (27 Sep 2026):
1. **A seat released for non-payment is treated exactly like a cancellation before cut-off** (Operator Supply Agreement 10.1). It is removed from the manifest, the band is recalculated, and the operator isn't paid for it. The deadline is capped at the cut-off, so a release always happens before cut-off.
2. **The guarantee:** a departure that drops below 4 still runs. The operator is paid the 4–6 band plus the per-traveler amount for everyone on the manifest at cut-off.
3. **Agency-billed invoices** are due at the mode C deadline after GoAhead.
4. **Refunds:** no deposit. The fee kept = full price × the tier's retained percentage.
5. **Scope:** catalog departures only; legacy bookings stay on deposit plus balance.

Added afterwards (27 Sep 2026):
6. **Cancellation tiers are a configurable table**, not code: rows per product type (day tour, one-way road tour, cruise, multi-day), each "from N hours or days before the start, keep X%". Seeded with today's values, editable in Admin → Finance, versioned with an effective date.
7. **A booking keeps the tier version in force when it was made**, not when it was paid:
   - a direct booking, when the traveler accepts the Terms at booking;
   - an agency booking (standard or agency-billed), when the agency books (Agency Reseller Agreement 4.2). The traveler's link shows that locked version and asks the traveler to accept it, never the current one.
8. **Loss check (clause 10.2):** for every tier window after the cut-off (day and one-way tours) or after the GoAhead deadline (cruise and multi-day), the fee kept is compared with what Sawa still owes the operator for that seat under the locked rate. A warning shows on the tier editor and in the margin report wherever a cancellation would lose money.
9. **Waitlist rule:** if a waitlisted traveler takes a released or canceled seat before the cut-off, the canceling traveler gets a full refund. The retained percentage applies only when the seat isn't resold.

## What was built

### Migration 051 (`server/db/schema_051_pay_at_goahead.sql`)
Additive, with a rollback (`server/db/down/schema_051_pay_at_goahead.down.sql`). Applied, re-applied, rolled back and re-applied on a scratch Postgres, also with `--single-transaction`. RLS is on for every new table. **Not run against production.**
- `cancellation_tier_versions` and `cancellation_tiers`: version 1 seeded and published from 2026-01-01. A published version and its rows are refused any change by a database trigger.
- `pledges`: `payment_mode` (`legacy_link` for every existing booking, `pay_at_goahead`), `cancellation_tier_version_id`, `terms_fixed_at`, `terms_fixed_by` (`traveller` or `agency`), `traveller_terms_accepted_at`. A pay-at-GoAhead booking must carry its tier version (CHECK).
- `pledges_cancelled_reason_chk` gains `unpaid`.
- `agency_invoices.due_on` may be empty: a pay-at-GoAhead invoice has no due date until the deadline.
- `payment_requests`, `payment_refunds`, `payment_tasks` and `departure_waitlist`.
- `finance_settings` key `pay_at_goahead`: window 48 hours, waitlist hold 12 hours.

### The payment-provider interface (`server/payment-providers/`)
Three operations; the booking logic calls only these:
- `createPaymentRequest(booking, amount in EUR, deadline)` → link and reference (the booking code);
- `recordPayment` → manual for Tab now (ops mark it paid with Tab's reference); a webhook later calls the same path;
- `refund(amount)` → a task for ops now; an API call later.

The first adapter, **`tab-manual`**, opens ops tasks: "Make a Tab link for €X, reference CODE" and "Refund €X in Tab for CODE". `PAYMENT_PROVIDER` selects the adapter for new requests; each request remembers its own. A Paymob, Kashier or Geidea adapter is one new file registered in `index.js`, with no change to `server/pay-at-goahead.js`. None was built.

### Pay at GoAhead (`server/pay-at-goahead.js`, `shared/pay-at-goahead.js`)
- **Booking.** No payment. Under the flag, a catalog booking is `pay_at_goahead` and fixes its tier version (`server/cancellation-tiers.js` `fixBookingTerms`). An agency catalog booking now gets a booking code, the payment's reference.
- **At GoAhead** (the 15-minute job, before the manifests freeze): one request per live booking for the **full published price**. An agency-billed seat is requested from the agency, for its invoice amount (price less commission). A booking made after GoAhead, or taken from the waitlist, is requested at once. Ops get one email listing the links to make.
- **Deadline.** 48 hours (or 24, a setting) from when the link is sent, capped at the cut-off. The 24-hour floor holds unless the cut-off is sooner; admin sees those as "short window". The traveler's email states the stored deadline.
- **Reminder** once at halfway; **ops warned** 2 hours before a release; **release** at the deadline:
  - the booking is canceled as `unpaid` and the payer is emailed;
  - the agency invoice and commission are voided;
  - the seat is offered to the waitlist;
  - the departure stays going ahead.
  Each step re-checks under a row lock, so a payment recorded after the warning stops the release.
- **Extension.** Admin sets a later deadline for one booking, with a required reason, never after the cut-off. The first deadline is kept (`original_due_at`), and the change is in the audit log.
- **Agency invoices** are dated to the deadline. Paying the invoice by bank transfer in Admin → Finance also marks the seat's request paid, so it isn't released.
- **Refunds.** A paid booking canceled after GoAhead keeps full price × the retained percentage of the tier version it was made under, at the time of cancellation. The rest is refunded through the provider (an ops task, completed with Tab's refund reference). Before payment, nothing is kept or refunded. A booking canceled another way (an admin edit) is reconciled the same way by the job.
- **Waitlist.** Travelers join a full date's waitlist from the tour page. When seats free up before the cut-off, the first waiting party that fits is emailed an offer, held 12 hours (never past the cut-off). The held seats aren't for general sale. If an offer expires, the seats pass to the next party; after the waitlist they return to sale. A waitlisted booking is asked to pay at once. If the seat came from a paid cancellation, the canceling traveler's fee is returned, in proportion to the seats resold.
- **Manifest.** Before the cut-off it marks each booking "Paid" or "Payment due by …". A released seat is a canceled booking, so it drops off. The freeze waits for any seat past its deadline to be released first, so the frozen manifest holds manifest seats only.
- **Commission** (`shared/settlement-rules.js`):
  - void on `unpaid`;
  - earned only if the seat was paid (or its invoice) and traveled;
  - half on a late cancellation only if a fee was actually kept, decided once the departure is over (a resale may still return the fee).
  The legacy rule is unchanged.

### Cancellation tiers and the loss check (`server/cancellation-tiers.js`, `shared/cancellation-tiers.js`)
- **Draft → publish:** a draft is copied from the version in force and checked:
  - every type has a tier ending at 0 hours;
  - percentages run 0–100 and never fall as the start approaches;
  - "days" tiers are whole days.
  Publishing (super admin) needs an effective date of today or later.
- **Loss check.** The seat's owed amount is:
  - day and one-way tours: the per-traveler amount;
  - cruises and multi-day: land services plus half a twin room.
  It uses the rate version in force (tier editor) or the departure's locked version (margin report), at the latest exchange rate. A missing rate, price or exchange rate is shown as such, never guessed.

### Screens
- **Admin → Finance → Pay at GoAhead:**
  - the Tab to-do list: paste a link, record a refund reference;
  - per departure, each seat as paid, awaiting (with deadline), released, or short window, with "Mark paid", "Extend" and "Cancel…" (which shows the fee and refund first);
  - refunds;
  - the settings.
- **Admin → Finance → Cancellation tiers:** the version in force, the draft editor, publish, and the loss check. The **margin report** lists each departure's loss warnings.
- **Operator manifest:** "Paid" and "Payment due by …" marks, and a line explaining that unpaid seats are released before the cut-off and not paid (clause 10.1).
- **Traveler:**
  - `/booking/:code` shows the full-price request (pay link and deadline) and the cancellation terms the booking was made under, with "I accept these terms" for an agency's traveler;
  - the tour page offers the waitlist when a date is full;
  - `/waitlist/:token` books the held seats.
- **Emails:** the booking confirmation (tiers of the booking's version), the payment link, the reminder, the release notice, the waitlist offer, and two ops emails (links to make; seats to be released in 2 hours).

### Flag off, and legacy bookings
With `catalogue_v2` off:
- bookings are `legacy_link` with no tier version;
- the booking page shows the deposit-and-balance summary as before;
- the phase 4 job does nothing;
- the waitlist and accept-terms routes answer 404.

Legacy bookings keep `server/payments.js` and Admin → Payments unchanged; `server/payments.test.js` passes as is. The admin screens answer with the flag off, as phases 1–3's do, and are staff-only.

## Tests

`server/pay-at-goahead.integration.test.js` (real Postgres and server, 16 tests) and `server/pay-at-goahead-rules.test.js` (pure rules, 12 tests). The phase 3 suite (`finance.integration.test.js`) was updated where phase 4 changes its rules: the agency bookings now pay at GoAhead, and a legacy-flow invoice covers the overdue check.

| Area (section 9.7) | Where |
|---|---|
| 1. Due date: 48 h, capped at cut-off, 24-hour floor, short window, copy matches the stored deadline | rules: "the deadline is…" ×3; integration: "at GoAhead…" (copy), "the deadline: capped at the cut-off…" |
| 2. At GoAhead: one per live booking, agency-billed to the agency for the invoice amount, none for canceled | integration: "at GoAhead: one full-price request per live booking…" |
| 3. Reminder once, at halfway, never after payment | rules: "the reminder is at the halfway point…"; integration: "the reminder goes once…" |
| 4. Release: canceled `unpaid`, emailed; stays going ahead below 4; paid never released; payment after the warning stops it | integration: "ops are warned 2 hours before a release…", "the guarantee…" |
| 5. Extension: original kept, audit row, release follows it, reason required | integration: "an extension needs a reason…" |
| 6. Waitlist: order, expiry, back on sale, pay now | integration: "the waitlist: offers in order…"; rules: "the waitlist offers the first party that fits…" |
| 7. Manifest and operator pay (clause 10.1) | integration: "before the cut-off the manifest shows paid seats…", "ops are warned…" (removed, band recalculated, not paid), "at the cut-off the manifest freezes with manifest seats only" |
| 8. Guarantee below 4: 2 travelers, going ahead, 4–6 band + 2 × per traveler, advance on 8 → receivable, set off | integration: "the guarantee: releases take the departure to 2…" |
| 9. Commission: void on `unpaid`, earned when paid and traveled, invoice due at the deadline and voided on release | integration: "ops are warned…", "the guarantee…", "at GoAhead…"; rules: "commission under pay at GoAhead…"; phase 3 suite: "commission is earned…" |
| 10. Refunds: day tours and packages, partial refund recorded with its amount | integration: "refunds: full price × the tier's retained percentage…"; rules: "refunds…" |
| 11. Flag off / legacy | integration: "with catalogue_v2 off…"; `server/payments.test.js` unchanged |
| Tiers configurable and versioned | integration: "tiers: version 1 is seeded…"; rules: "tier rows are checked before saving" |
| Tiers change between booking and GoAhead; the booking keeps its version | integration: "a booking keeps the tier version in force when it was made…" |
| Agency books, tiers change, the traveler's link shows and accepts the original | integration: "an agency booking keeps the version the agency booked under…" |
| Loss check: €95, 2,200 EGP at 55, 10% under 48 h → flagged | integration: "loss check (clause 10.2)…" (editor, route and margin report); rules: "loss check…" |
| Waitlist rule: resale before the cut-off → full refund | integration: "the waitlist…" (5% kept, then returned: €190 refunded in full) |

**CI gate:** `node scripts/ci-gate.js` against a real Postgres passes every step it can run (the three that need production or a live site are UNVERIFIED, as always). The counts are in the PR.

Registers updated:
- `docs/audit/latent-defects.md` L-4: two new `cancelled_reason` writes, both on pay-at-GoAhead bookings only, and the test that pins them;
- `docs/audit/repo-truth-register.json`: one internal statement.

## Open items (not built, or for you to decide)

1. **The Terms and site copy.** The Terms' payment and cancellation sections (`site/terms.html`, the SPA's terms summary, the FAQ, `shared/site-copy.js`) still describe deposit and balance. They are shared with legacy bookings and are legal text, so they weren't changed. The booking confirmation and the booking page state the pay-at-GoAhead terms from the booking's tier version. The Terms need the lawyer's wording before the flag goes on.
2. **A link never made.** A request waits for ops to paste the Tab link, and its deadline runs from then. If ops never make it, the seat is never released and stays on the manifest: Sawa's miss, not the traveler's. Ops get the task, an email, and the "Link to make" state in admin.
3. **Reinstating a released booking** is an ordinary booking edit (Admin → Bookings), which checks capacity. It then gets a fresh request from the job.
4. **The loss check's cruise estimate** assumes the traveler shares a twin room. A single traveler costs Sawa more (the single supplement, decided earlier).
5. **Provider adapters** (Paymob, Kashier, Geidea) and webhooks: not built, as asked. Section 10 of `payments-readiness.md` compares them.
6. **Old-style public cancel after GoAhead** still sends the traveler to Sawa (Terms 13.2). Staff cancel in Admin → Finance → Pay at GoAhead, which shows the fee and refund before confirming.

## Switching it on

`docs/launch/catalogue-v2-runbook.md` now includes 051 (step 1e): pre-checks, apply with `--single-transaction`, post-checks, and the rollback row. Its step 5 covers the pay-at-GoAhead settings and reviewing the tiers' loss check, and step 8 adds the ops checklist for Tab by hand. Apply 051 before deploying this build with the flag on.
