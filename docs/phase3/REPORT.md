# Phase 3 report: settlements and commissions

Branch `feat/settlements-commissions`. Built to the phase 3 brief and the decisions recorded in `docs/model-audit/03-migration-plan.md` (phase 3 block, 27 Sep 2026).

**Nothing here moves money.** It records what is owed and produces statements. Finance pays by bank transfer and records each payment. No payment provider, bank or exchange-rate service is called.

**Everything that reaches travelers, operators or agencies is behind `catalogue_v2`.** With the flag off:
- bookings behave as today, and no field is newly required;
- no commission, invoice or advance is created;
- the phase 3 jobs do nothing;
- the operator, agency and booking-details routes return 404.

Integration tests assert each of these. The admin screens work with the flag off, like phases 1 and 2. They are staff-only.

The security fix for the agency listing takeover is a separate PR ([#221](https://github.com/desertcanvasart-dotcom/Sawa/pull/221)). It is independent of this branch.

---

## What was built

### A. Rate card currency

`catalogue_rate_versions.commission_currency` is `EUR`, and a CHECK keeps it that way. Operator amounts stay EGP in the existing `currency` column.

The importer now reads the workbook's Assumptions sheet: "Traveller currency" is EUR and "Operator currency" is EGP.
- It reports a mismatch if either statement changes; it never converts.
- The old USD warning is gone.
- The workbook's placeholder exchange rate (55) is not imported. Rates are entered by date in Admin → Finance.

The updated `docs/model/sawa-rate-card.xlsx` imports:
- 21 products;
- 2 EXAMPLE rows skipped;
- no currency warnings.

**Every amount in the workbook is still blank.**

### B. Booking data completeness

**Required fields.** Under the flag, a new booking on a catalog departure must carry:
- every traveler's name (one per seat);
- a phone number;
- a pickup point;
- nationality, where the product needs it;
- an answer on health or safety needs, with an explicit "No health or safety needs" option, stored as `None`.

The server enforces this on the public and agency booking routes (`server/booking-details.js`). The tour page, the booking widget and the agency booking form collect the fields through one shared component, `src/TravelerDetails.jsx`. Legacy departures are unaffected.

**Completion requests.** A daily job emails bookings that still lack any field. It sends:
- a request with a private link 7 days before the departure;
- a reminder at 3 days, if still incomplete.

Each is sent once, recorded in `booking_completion_requests`, with the link's token stored hashed. The link (`/booking-details/:token`) applies the same rule, expires when the tour starts, and is marked noindex. Agency bookings with no traveler email go to the agency owner.

**Manifest.** The operator manifest marks each missing field "Missing", row by row.

### C. Operator bank details

`operator_bank_accounts` stores:
- the account holder, which must match the operator's legal name (compared ignoring case and punctuation);
- the bank;
- the account number and/or IBAN (the IBAN is format-checked);
- SWIFT, where relevant.

Rules:
- **A change needs verification.** A change is a new `pending` row. Only an admin's verification makes it `verified`, and the old account is superseded.
- **No payment while unverified.** While a change is pending, no payment to that operator can be recorded.
- **Emails on change.** A change emails the operator (its own email and its owner logins) and Sawa's admin. The emails show the bank and the last 4 digits, never the numbers.
- **Everything is logged.** Every view, submission, verification and rejection is logged in `operator_bank_access_log`. Viewing in admin is an explicit, logged action. The operator portal shows masked numbers.
- **Who can change it.** Operator owners can change details from the portal, operator staff can't, and admins can change them from the operator screen.

### D. Operator settlement (catalog departures only)

1. **Advance.** When the operator acknowledges, an advance of 50% of the expected amount is created.
   - It is due 2 Egyptian business days later: Sunday to Thursday, skipping the public holidays admins maintain in `egypt_holidays` (Admin → Finance → Rates and settings).
   - While the rate card has no amount, the advance is `on_hold`. It is priced automatically once the rate is published.
   - An unpaid advance on an assignment that is later replaced is canceled.
2. **Balance.** It is created when the departure completes.
   - Start from the final amount: the frozen manifest (late cancellations and no-shows count, as in phase 2) and the locked rate version.
   - Subtract deductions and the advance, and add reimbursements.
   - It is due 7 calendar days after the departure ends.
   - The brief's cases are tested: 520 − 260 = **260**; after two early cancellations, 390 − 260 = **130**; after two late ones, 520 − 260 = **260**.
3. **Adjustments.** `operator_adjustments`: each carries a reason, a clause reference and evidence files, uploaded through the existing private receipt store.
   - **Penalties** take their amount from `operator_penalty_rates`: the four Schedule 6 events, 0 EGP until set, one of them per traveler.
   - **Service-failure deductions** are entered in EGP. Penalties and deductions together are capped at the departure's operator amount: entry is refused past the cap, and the arithmetic caps it too.
   - **Force-majeure reimbursements** reuse the existing cost sheet. An admin points the reimbursement at approved `departure_costs` lines, where the receipts are. The existing settlement tools are unchanged.
   - Adjustments can change only while the statement is a draft or disputed.
4. **Statement.** One per departure (`settlement_statements`). It shows:
   - each traveler;
   - the band;
   - the per-traveler amount and the rate lines;
   - the adjustments;
   - the advance and the balance;
   - the rate version.

   It is available in the admin calendar panel, the operator portal and as a PDF, produced by a small dependency-free writer (`server/pdf.js`).
   - **Draft → sent:** an admin sends it; the operator gets a portal notice and an email.
   - **Accepted:** automatically 30 days after sending, by the daily tick.
   - **Disputed → resolved:** the operator disputes from the portal with a reason, and an admin resolves it with a note. The balance and snapshot are recomputed first.
5. **Payment recording** (`finance_payments`). Finance records each advance and balance with the transfer date, amount and bank reference.
   - An amount that differs from what's due is refused with a warning. Only a super admin can override, with a reason, and the override is recorded.
   - Payment is refused while the balance's statement is disputed, and without verified bank details.

### E. Agency commission

1. **Locked at booking.** When an agency books a seat on a catalog departure, the commission per seat is locked in EUR from the rate version in force (`agency_commissions`). A later version doesn't change it.
2. **Earned** once the departure completes and the traveler traveled.
   - A late cancellation where Sawa keeps a fee earns 50%. That means a traveler cancellation after GoAhead in a fee band of the default schedule: under 48 hours for day tours, under 30 days for cruises and multi-day.
   - Nothing is earned if the departure doesn't reach GoAhead, or on any other cancellation. A voided seat's invoice is voided too.
   - To tell a traveler's cancellation from Sawa's, cancellations now record `cancelled_reason` and `cancelled_at`, under the flag only:
     - the traveler's own cancel links record `traveler`;
     - in Admin → Bookings, staff are asked who canceled.

     This is the first write of that column. The `L-4` entry in `docs/audit/latent-defects.md` and its test were updated: the one reader checks the departure's status first.
3. **Monthly statement** per agency (`commission_statements`). It lists each seat with its commission and status, and is built and sent from the 1st of the following month, by the 10th.
   - For Egyptian agencies (country `EG`) it shows the EGP amount at the rate on the statement date. If that day's rate isn't in the table, the statement is held and retried daily.
   - Agencies see their statements, seats and invoices under Commission in their portal.
4. **Agency billing.** For approved agencies (Admin → Finance → Agency commission; super admin), each booking creates an invoice (`agency_invoices`) for the published price less the commission, due after the agency's setting (default 14 days). The seats count toward GoAhead from booking, as every agency pledge already does.
5. **Payments.** Finance records commission payments and invoice receipts the same way as operator payments.

### F. Finance view and FX

1. **Admin → Finance** lists:
   - operator advances and balances (EGP);
   - agency commission statements (EUR or EGP);
   - agency invoices (money in).

   Each shows due, overdue or paid, and can be filtered by due date, party and standing. The admin home and the nav show an alert when anything is overdue.
2. **Exchange rates.** `fx_rates` holds EGP per 1 EUR by date, entered by admin. No external call is made.
3. **Margin report** per going-ahead or completed catalog departure:
   - EUR charged (paid payments, by charge date);
   - less the operator amount in EGP, converted at the rate on each charge date in proportion to that charge;
   - less commissions and payment fees;
   - equals the margin in EUR.

   A date with no rate shows "rate missing" and lists the dates; no rate is guessed. Payment fees come from a finance setting (percentage plus a fixed amount); until it is set, the report says "fee rate not set".

### G. Legacy

The existing settlement tools and legacy departures are untouched. Admin → Finance shows the number of legacy departures still open and the date of the last one, live.

---

## Migration 050

`server/db/schema_050_settlements_commissions.sql` is additive. Its rollback is `server/db/down/schema_050_settlements_commissions.down.sql`. It was applied, re-applied (no change), rolled back and re-applied on a scratch Postgres.

| Adds | |
|---|---|
| Tables | `booking_completion_requests`, `operator_bank_accounts`, `operator_bank_access_log`, `egypt_holidays`, `fx_rates`, `operator_penalty_rates` (4 rows seeded at 0 EGP), `operator_payables`, `operator_adjustments`, `settlement_statements`, `commission_statements`, `agency_commissions`, `agency_invoices`, `finance_payments`, `finance_settings`. RLS is on for every one, with no policies (server-only, as 024 set). |
| Columns | `catalogue_rate_versions.commission_currency` (`EUR`, CHECK), and `agencies.country_code`, `billing_approved` (default false) and `billing_due_days` (default 14) |

It has **not** been run against production. It depends on 047–049.

## Open legacy departures

**Can't determine from this environment:** this session has no access to the production database. The number is shown live in Admin → Finance, and this read-only query gives it:

```sql
SELECT COUNT(*) AS still_open, MAX(COALESCE(d.end_date, d.start_date, d.date)) AS last_date
  FROM departures d
 WHERE d.status NOT IN ('cancelled', 'closed')
   AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id);
```

The existing settlement tools stay in use until the last of these completes.

## What still blocks switching on in production

1. **Migrations 047, 048, 049 and 050** applied, in order, by hand (`npm run db:migrate`).
2. **The rate card's amounts.** Every product's per-traveler amount, departure fees, room rates and commission are blank. Without them there is no operator amount: advances and balances are held, and commission can't be locked.
3. **Operators set up:**
   - four documents each;
   - product approvals;
   - activation;
   - verified bank details;
   - portal logins.
4. **The roster** planned and published for each month.
5. **Finance reference data:**
   - the day's CBE rate for every commission statement to an Egyptian agency and every charge date in the margin report;
   - Egypt's public holidays;
   - the Schedule 6 penalty amounts;
   - the payment provider's fee.
6. **Agencies' country codes and billing approvals.**
7. **Traveler charging, mode A or B.** This phase settles what Sawa owes; it doesn't take travelers' money. Mode A saves the card and charges at GoAhead; mode B charges at booking and refunds automatically if there is no GoAhead. Today travelers still pay through the manual Tab link.
   - The choice depends on the lawyer's answer: whether Capital Travel may save a card and charge it later under CBE rules and the Consumer Protection Law.
   - It also depends on a payment provider that supports the chosen mode.
   - Mode B changes the "nothing is charged before GoAhead" promise, so the site copy must switch with it.
8. **The lawyer's other answers** that affect this phase:
   - paying Egyptian agencies in EGP versus foreign currency;
   - whether the penalty amounts are enforceable;
   - the subcontracting structure under the tourism companies law.
9. **The security fix** ([#221](https://github.com/desertcanvasart-dotcom/Sawa/pull/221)) merged and deployed; it doesn't depend on this branch.

## What the traveler-payments phase needs from this one

- **Revenue.** The margin report reads EUR revenue from `booking_payments` rows marked paid, by `paid_at`. Charges and refunds from the provider must land there (or in a table the report reads) with the charge date. Refunds need to reduce revenue: today only `paid` rows count.
- **Fees.** Provider fees per charge, instead of the flat setting, would make margins exact.
- **Cancellation fees.** Commission's 50% rule reads `cancelled_reason` and `cancelled_at`. Once the provider computes and refunds cancellation fees, the rule should read whether a fee was actually kept, not the schedule band.
- **Agency-billed seats.** They are invoiced here and never charged to the traveler; the charge job must skip them. Standard agency seats (not billed) count toward GoAhead once the traveler completes the payment link, with a 48-hour hold (decided, not built).
- **Booking details.** They are now captured at booking under the flag. The checkout can reuse `src/TravelerDetails.jsx` and the server rule in `server/booking-details.js`.
- **Invoices and receipts** to travelers in Capital Travel's name are separate from the agency invoices built here.
- **Seller of record.** The seller-of-record switch-over (Terms, Privacy, footer, JSON-LD) listed in the migration plan still applies.

## Tests

- **`server/settlement-rules.test.js`** (unit):
  - the advance amount;
  - its due date across a weekend and a public holiday;
  - the balance on the worked examples, less a 50% advance;
  - the deduction cap;
  - 30-day acceptance;
  - every commission outcome;
  - statement totals in EUR and EGP;
  - booking completeness;
  - the margin with a missing rate;
  - the PDF's structure.
- **`server/finance.integration.test.js`** (Postgres, real server):
  - rate card currencies;
  - required booking fields, and the explicit "none";
  - commission locked at booking and unchanged by a later version;
  - the agency invoice, with its seats counting toward GoAhead;
  - completion requests and the reminder, once each, then completed through the link;
  - the manifest's missing marks;
  - the advance and its holiday-aware due date;
  - balances of 130 and 260;
  - adjustments and the cap, penalty amounts and a reimbursement;
  - automatic acceptance at 30 days, a dispute blocking payment, and its resolution;
  - bank details:
    - holder mismatch refused;
    - pending blocks payment;
    - emails without numbers;
    - a new change blocks again;
    - the access log;
  - payment overrides (refused for staff, allowed for a super admin with a reason);
  - commission earned, 50% and void;
  - the monthly statement, held for an EGP rate, then sent and paid;
  - the finance view's standings;
  - the margin with, then without, a missing rate;
  - route ownership for operators, agencies and staff;
  - with the flag off: jobs skip, routes 404, no commission, invoice or advance.
- **Updated tests:**
  - `server/operators-rules.test.js` (the new workbook: no USD warning);
  - `server/operators.integration.test.js` (a phone number on its flag-on booking);
  - `server/latent-defects.test.js` (L-4).

The full gate (`node scripts/ci-gate.js` against a real Postgres) passes: 1034 of 1034 tests and every check.
