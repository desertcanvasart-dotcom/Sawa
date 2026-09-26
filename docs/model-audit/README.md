# Sawa model audit: summary

The audit is in three documents:
- [01 · Current state](01-current-state.md): how Sawa works today, with file references.
- [02 · Gap analysis](02-gap-analysis.md): one table per area, plus what to retire.
- [03 · Migration plan](03-migration-plan.md): target schema, phases, payment-provider needs and 19 decisions for you.

Scope: code at `0f97967` (26 Sep 2026) and the rate-card workbook. The operator and agency agreements weren't supplied. There was no production database access, so production counts are the dated snapshots in `docs/audit/` plus the admin screenshot.

> **Found in passing: fix this now, whatever the model.** Any agency user can overwrite a Sawa-owned product and take it over. The ownership check lets NULL-owned products through (`server/app.js:1023-1028`). The upsert then re-prices the product, takes it offline as "pending", and assigns it to the caller (`server/app.js:965`). Every catalogue product is NULL-owned. This was found by reading the code; it was not exercised. It's queued as a separate task.

## The three biggest gaps

1. **No money moves through the platform.** Nothing saves a card or charges one. After GoAhead, ops paste a Tab payment link per booking, then mark it paid by hand (`server/payments.js:1-17`). The target needs:
   - a card saved with consent at booking;
   - automatic charging at GoAhead, with retries and failure handling;
   - API refunds for cancellation tiers;
   - invoices in Capital Travel Service's name.
   
   Nothing in the code shows whether Tab can do any of this.
2. **Operators are sellers, not suppliers.** Operators and agencies share one `agencies` table and one portal. Operators can submit tours with their own prices (`server/app.js:1018-1039`). A departure's operator is never stored: it is recomputed as "the partner with the most paid travellers" (`server/domain.js:520-597`), and travellers are told it "can change". Direct bookings default to Capital Travel Service as operator. There is no roster, assignment, acknowledgement, rate card or manifest.
3. **The money model is a profit share, not a rate card plus commission.** Sawa keeps 10% of each departure's gross profit, and agencies split the other 90% by headcount (`server/settlement.js:32, 105-148`). Nothing reimburses the operator's approved costs. Commission percentages exist only in a report. The target needs:
   - per-product rate-card versions locked at first sale;
   - an advance and balance with statements;
   - fixed per-seat agency commission earned on travel;
   - agency billing;
   - monthly statements.

Close behind: there is **no departure calendar** (dates exist only once someone books or requests one), and **prices fall as the group grows** instead of being one published price per seat.

## The riskiest change

**Turning on automatic charging at GoAhead, together with the switch to CTS as seller of record** (phase 3). Why:
- It is the first time the platform moves money by itself. The GoAhead trigger runs inside booking transactions (`server/departure-status.js`) and must charge each card exactly once under concurrent bookings.
- Existing bookings were made on "no card, pay by link" terms and have to stay on that path. So some departures will hold both kinds of booking.
- About 40 public statements and the Terms (§§ 6, 12, 13) currently say the opposite, and must change in the same release.
- A test enforces the current entity wording (`server/entity-disclosure.test.js:148-165`).

To reduce the risk:
- ship the roster first (phase 2), so the first charge goes to a real, stored operator;
- roll out behind a per-product flag, starting with one day tour.

## What production data constrains the migration

- **Live bookings exist.** Production has held pledges since 12 Aug 2026 (`docs/audit/evidence-expiry.md:72-76`). Their prices were captured under the falling-price formula, and they were promised no card and a payment link. They can't be converted; they keep their price and payment route (03 §1.4).
- **Money records may exist.** If migrations 043–046 are applied in production, `booking_payments`, cost sheets and payout runs hold money history. Keep them read-only; never drop them. Whether they are applied is not recorded in the repo.
- **The catalogue is ~16–20 products,** not 21, all Sawa-owned (`agency_id` NULL on every product as of Aug, per `docs/audit/open-directives.md`). Items #3 and #7 on the rate card are missing. #14 and #15 duplicate each other. Cruises and multi-day tours are both stored as `package`.
- **Only a handful of operator/agency records exist** (one agency row as of 10 Aug). CTS is referenced by name as the default operator (`server/brand.js:174`).
- **The rate card has no real figures yet;** only its EXAMPLE rows are filled in, and they are in USD while the site is in EUR.
- **Run a read-only count before phase 2:** departures by status, pledges by status and source, payment links by state, pending date requests, and payout runs. 03 §1.4 lists the queries.

## Recommended first phase

**Phase 0 now, then phase 1 (catalogue and calendar), while the payment provider is procured in parallel.**
- **Phase 0:**
  - fix the takeover defect;
  - answer decisions D1–D3, D6–D8 and D10;
  - start merchant-account onboarding for CTS;
  - fill the rate card;
  - run the production counts.
- **Phase 1:**
  - four product types with full specifications;
  - one flat published price;
  - the 21-product import;
  - a calendar generator;
  - a 48-hour cut-off;
  - retire operator listing, operator pricing and "start your own date", with their copy.
  
  It moves no money, removes the most contradictory copy ("price drops as the group grows", "operators list and price"), and everything later depends on it.
