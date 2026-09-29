# One rate card per product (066)

29 Sep 2026, behind `catalogue_v2`. Replaces rate versions (draft / publish / "takes effect") and the earlier request to edit and delete versions.

**Nothing here has been run against production.** Migration 066 is applied by hand; see §7.

## 1. One rate card, saved in place

- **One card per product.** Each product has exactly one rate card (`catalogue_rate_cards`, one row per product). **Save** updates it and applies at once.
- **Removed:** the Versions section, drafts, Publish, and the "Takes effect" date.
- **Audit log.** Every save and delete is in the audit log, with who, when, and the values before and after:
  - `rates.create` (a first save, or a save after a delete);
  - `rates.update`;
  - `rates.delete`.
- **"Last updated by … on …"** is shown on the card and in the rate card list.

## 2. Departures keep their own copy

- **First seat.** When a departure sells its first seat, the database trigger copies the card onto the departure (`catalogue_departures.rate_snapshot`): tiers, prices, operator fees, cost lines with notes, and the commission. This happens in the booking's own transaction; the status job snapshots anything missed.
- **Later edits and deletes never touch a snapshot.** Payment requests, the tier-drop refund, the operator's offer and statement, the pool, the agency shares and the margin report all read the departure's snapshot.
- **Unsold departures.** A departure that hasn't sold a seat uses the card as it is now (`rateForDeparture` / `departureRate`).
- **No version reads left.** Every place that read a locked version now reads the snapshot or the card: settlement, the pool, commissions, the cancellation loss check, assignments, the operator statement and PDF, the public catalogue and the "Edit day tour" view.

## 3. Delete

- **"Delete rate card"** asks first: "This tour can't be booked until a new rate card is saved. Departures that already sold seats keep their prices."
- **Snapshots are never deleted.**
- **Bookings are refused** with 409 "This tour can't be booked right now: it has no rate card."
- **The tour page** says "Not bookable right now" instead of a price.

## 4. Cost line notes

- **Entry:** each cost line has an optional note (up to 160 characters) in the editor, e.g. on "Transport": "Higher for 7–8: bigger driver tip".
- **Where it appears:** on the operator's offer and settlement statement, beside the line ("Transport, per group (Higher for 7–8: bigger driver tip)"), including the PDF.
- **Snapshots:** the note is part of the snapshot.

## 5. Validation on save

The same rules run in the editor as you type and on the server (`rateCardError`, `shared/pool-model.js`).

- **Tiers cover the GoAhead minimum to the maximum group (4–8).**
  - The first tier starts at the minimum or below.
  - No tier ends above the maximum group, so "To" is at most 8 (a cruise or multi-day tour may be set up to 12).
  - The last tier ends at the maximum group.
  - No gaps and no overlaps.
- **The operator fee is required** on every tier, and every cost line needs an amount for every tier.
- **Prices go on every tier or on none.** A card saved with no prices still books at the listing's price, as before; its pool waits for prices.
- **Warning, not a block:** a EUR price above the operating cost per traveller at the GoAhead minimum, in EGP, looks like an EGP amount. For example, €2,537 against 1,662.5 EGP at 4 travellers.
- **No exchange rate:** a card saves without one, but the tour can't be booked until the site-wide rate is set. Bookings are refused with "the exchange rate isn't set" and the tour page says "Exchange rate not set".
- **"Add a tier"** now splits the last tier (4–8 becomes 4–6 and 7–8) instead of adding past the maximum group.

## 6. The migration (066), in order

1. **Archive.** Every old version and draft is copied, as JSON, into `catalogue_rate_versions_archive`. The rollback uses it. Drop the table once you're satisfied.
2. **Cards.**
   - **Each product's newest published version becomes its card.** Its `updatedBy` / `updatedAt` are when it was published.
   - **If the product also has a newer draft**, the published version is kept and the draft is listed, with its contents.
   - **A product with only a draft** gets no card and is listed. Enter its card in Admin → Rate card; until then it can't be booked.
3. **Clamp.** A tier ending above the maximum group is clamped to it, and a tier starting above it is dropped with its cost amounts. Each change is listed. This fixes **#2 Giza Uncovered, 7–11 → 7–8**.
4. **Snapshots.** Every departure locked to a version gets that version, unchanged (not clamped), as its snapshot.
5. **Delete.** Then every old version and draft is deleted, and their foreign keys are dropped.

**Seeing what it did:** Admin → Rate card → "What the move to one rate card changed" shows everything the migration recorded, from `rate_card_migration_066`. The query in §7 does the same in SQL.

**Runs safely on every `db:migrate`.** The runner re-runs every migration each time, and 049 recreates an empty versions table and the old first-seat trigger. 066 runs after it, finds nothing to move, and puts the snapshot trigger back. `server/rate-cards.integration.test.js` runs the whole migration twice to check this.

**Rollback:** `server/db/down/schema_066_rate_cards.down.sql`, together with the code from before 066. It restores every archived version. Cards saved after 066 would need publishing again in the old editor.

## 7. After merging

1. **Apply migration 066**, before or with the deploy. The new code reads `catalogue_rate_cards`.
   - `DATABASE_URL=<production> npm run db:migrate`, or
   - paste `docs/ops/apply-migration-066.sql` into the Supabase SQL editor (one transaction; safe to rerun).
2. **Check what it did:**
   ```sql
   SELECT catalogue_no, title, kind, detail FROM rate_card_migration_066 ORDER BY catalogue_no, id;
   ```
   Look for `clamped` (e.g. #2 Giza Uncovered 7–11 → 7–8), `dropped_tier`, `newer_draft` and `no_published`.
3. **Approve today's exchange rate in Finance.** Admin → Finance → Rates and settings:
   - If a rate is under **Waiting for approval**, check it and press **Approve**.
   - If today's row isn't there, press **Fetch today's rate now**, then approve it if asked.
   - Check that **In force** shows a number. Until it does, no catalogue tour can be booked.
4. **Open Admin → Rate card:**
   - enter a card for any product marked "No rate card: not bookable";
   - apply anything you want from the listed newer drafts;
   - check #2 Giza Uncovered.

## 8. Decisions to confirm

1. **A card without prices stays bookable at the listing's price**, as it was before 066. Only a deleted (or never-made) card, or a missing exchange rate, blocks booking. Say if a card without prices should block booking too; that is a one-line change (`rateCardBookable`).
2. **The maximum for "To" is the product's maximum group:** 8 for every day tour, and up to 12 only for a cruise or multi-day tour that has that override. The migration clamps to the same.
3. **The spreadsheet import is retired.** It wrote phase-2 amounts into three tiers up to 12 as drafts, which can't pass the new rules and would overwrite live cards. The parser stays, and its test still reads the workbook.
4. **Snapshots of migrated departures are not clamped.** A departure locked to a version with 7–11 keeps 7–11: its prices are frozen, as asked.
5. **The phase 7 conversion script is removed** (`scripts/phase7-convert.js`, `server/eur-conversion.js`). It turned versions into EUR drafts, and 066 replaces versions. A card still priced in EGP shows "Was EGP …: enter the EUR price" in the editor.

## 9. Tests

**`server/rate-card.test.js`** (no database):
- **#2 Giza Uncovered** at 59 EGP per EUR (€43 for 4–6 at 5%; €40 for 7–8 at 6%; transport 1,850 / 2,200 and guiding 2,000 per group; entrance 700 per traveller):
  - 4 travellers → pool **2,150.7** (revenue 10,148, entitlement 6,982.5, commission 1,014.8);
  - 8 travellers → pool **6,604** (18,880 − 10,388 − 1,888).
- **Tier coverage:** 7–11 is refused; a start above 4, an end below 8, gaps and overlaps are refused.
- **Required fields:** the operator fee and cost amounts; prices all or none.
- **The EGP-looking price warning.**
- **Notes** in the calculation.
- **When a tour can be booked.**

**`server/rate-cards.integration.test.js`** (real Postgres):
- **Migration 066:** the published version becomes the card, not the newer draft; 7–9 → 7–8, 10–12 dropped, **#2 Giza Uncovered 7–11 → 7–8**; draft-only product listed; a locked departure keeps its version unchanged; versions archived, deleted and unreferenced; a second full `db:migrate` changes nothing.
- **Save and snapshots:** save updates in place; a sold departure's snapshot is unchanged after an edit, while an unsold one picks up the new price and takes it at its first seat.
- **Delete** makes the tour unbookable and keeps the snapshot; no exchange rate blocks booking.

**`server/pool-model.integration.test.js`** (with the server running):
- **The routes:** save through the admin route (audited `rates.create`, with before and after); an update and a delete audited with before and after; "Last updated" in the list.
- **After a delete:** the tour page says "Not bookable right now", a public booking is refused with 409, and saving again reopens it.

**Updated for one card:**
- `finance`, `phase6`, `operators`, `booking-parties`, `booking-integrity`, `operator-selection`, `pay-at-goahead` and `pool-model` integration tests;
- `catalogue-tour-editor`, `single-price` and `eur-prices` unit tests.

**Removed:** tests for the draft/publish flow, the xlsx import into drafts, migration 061's conversion of versions (066 empties them) and the phase 7 conversion script.
