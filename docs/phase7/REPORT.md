# Phase 7: exchange rate mode, prices in EUR, and the single-price draft bug

29 Sep 2026, behind `catalogue_v2`. Builds on 064 (the automatic EUR/EGP rate, `docs/fx/REPORT.md`).

**Nothing here has been run against production.** Migration 065 and the conversion script are applied by hand; the steps are in §6.

## 1. Exchange rate: automatic or manual

There is one site-wide setting, **Exchange rate mode**, which is either Automatic or Manual. It is stored in `finance_settings` under `traveller_rate.mode`, and defaults to automatic.

| | What it does |
|---|---|
| **Automatic** | Exactly as in 064: a daily fetch, a jump of more than 5% waits for approval, the rate is the market rate × (1 − buffer), and it renews weekly or early on a move of more than 3%. |
| **Manual** | The admin enters EGP per 1 EUR, and it is used exactly as entered, with no buffer. Switching to Manual, and every change of the manual rate, needs a reason. |
| **Back to Automatic** | Takes the latest approved market rate less the buffer, immediately. It is refused if no market rate has been approved yet (see §5). |

- **Logging:** every switch and every manual rate is a row in `fx_traveller_rates`, with the rate, reason, who and when. It is also written to the audit log as `finance.exchange_rate.manual` or `finance.exchange_rate.automatic`.
- **The daily fetch keeps running in Manual mode.** Both screens show "Market today: 59.2 · You're using: 58.0". They warn when the manual rate is more than 5% from the market rate.
- **One control in two places.** Finance → Rates and settings and section 3 of every rate card editor show the same control (`src/ExchangeRateControl.jsx`). From a rate card, saving first asks "This changes the exchange rate for all tours. Continue?"
- **Bookings** keep the rate locked when they were made, in either mode (`pledges.published_eur_rate`, unchanged).
- **No rate at all** (no approved fetch and no manual rate): "Exchange rate not set", no euro prices, and no payment requests. This is 064's hold, unchanged.
- **The old "Override" is gone.** Manual mode replaces it. An override lasted until the next weekly update; a manual rate stays until someone changes it.

## 2. The tour price in EUR

- **Entry:** the rate card price is "Tour price per traveller (EUR), what travellers pay".
- **What travellers see:** tour pages, the widget, payment requests and receipts show that EUR price exactly, with no conversion and no rounding.
- **EGP equivalent:** beside the price, read-only: "≈ 5,723 EGP at the current rate (59.0, manual)". Cost lines stay in EGP.
- **Calculations:**
  - Revenue in EGP = EUR price × the rate locked on each booking.
  - `pool-settlement.js` works it out per booking; the rates used are kept with the calculation as `revenueRates`.
  - A place with no locked rate (a booking from before the model) counts at the current rate.
  - Operating cost, operator fee, entitlement, the 10% commission (of the EGP revenue) and the pool are in EGP, exactly as before.
- **"By group size" table:** uses the current rate and says so.
- **Operator statements:** the revenue line reads "4 × €97 at each booking's exchange rate".
- **Older versions:** a version priced in EGP still works as before (EGP ÷ rate, rounded up) until its EUR draft is published. Departures already locked to an EGP version keep it.

## 3. Labels

- **Rate field:** "Exchange rate (EGP per 1 EUR)", with the help text "Not a price. Used to convert the euro price into EGP for operator and agency calculations."
- **"Travelers see" column:** removed.
- **Tour-page preview:** "Tour page preview: Travelers pay €97 per person".
- **Rate card subtitle** (formerly `AdminOperators.jsx:532`, now 533): #242 had already fixed it, and it now describes EUR prices and the site-wide exchange rate.

## 4. The Giza draft, and converting existing versions

### What caused "Draft v2: one tier 10–12 at 4,071 EGP, 10% fee, no cost lines"

**It was not migration 063.** Both of 063's paths write the tier as a fixed 4–8 from the *first* tier, so it cannot produce a 10–12 tier. `server/eur-prices.test.js` and `server/phase7.integration.test.js` show what it produces.

**The rate card editor could produce it, and it is the only code path that can.**
- Removing a tier dropped its range instead of giving it to the neighbouring tier.
- Clicking Remove on 4–6 and then 7–9 therefore left one tier, 10–12, with that tier's price (4,071) and fee (10%).
- Tiers must be ascending and contiguous (`poolRateError`), so a lone 10–12 is valid. Nothing stopped it being saved or published.

**"No cost lines":** the editor keeps cost lines when a tier is removed, so a draft built that way has none only if its source version had none. The test fixture copied from Giza (`catalogue-tour-editor.test.js`) also has none. **I couldn't confirm this against production** (no database access from here).

**To confirm:** `node scripts/phase7-convert.js` (§6) prints each draft's origin and `created_by`.
- A draft made in the editor has `created_by` = the admin's email and `source = {copiedFrom: …}`.
- A draft made by 063 has `created_by = 'migration 063'`.

**Fixes:**
1. **Editor:** removing a tier now gives its range to the neighbour (`removeTierAt`, `shared/pool-model.js`). Removing 4–6 and 7–9 leaves 4–12, never a lone 10–12.
2. **Publishing:** refused unless the tiers cover the tour's GoAhead minimum to its maximum group (`tierCoverageError`, `server/rates.js`).
3. **063 itself had a real defect,** now fixed:
   - it used a fixed 4–8 instead of the product's GoAhead minimum and maximum group;
   - it copied the per-version EUR rate, which 064 drops, so running 063 after 064 failed. It no longer copies it.

   It still takes the first tier and keeps every cost line.

**Were cost lines dropped for every product, or only Giza?** By the code, 063 drops no cost lines for any product: it keeps every line, with the first tier's amount. The answer for production depends on the data. The dry run lists every draft with any lines missing compared with its source version, and any draft whose tiers don't cover the tour's range. **Run it and the "⚠" lines are the affected drafts.** I couldn't run it here.

### Converting to EUR prices

`node scripts/phase7-convert.js` does a dry run (read-only). Add `--apply` to write. Logic: `server/eur-conversion.js`.

**The rate used:**
- EUR price = EGP price ÷ the **current site-wide rate at conversion time**, rounded up to the whole euro.
- It never uses the old per-version values: they were typed in error (43, 97) and 064 removed them.
- It needs a site-wide rate to exist, so it refuses to run before one does.

**How each product's draft is built:**
- It uses the first tier, from the GoAhead minimum to the maximum group, and keeps every cost line.
- It is saved as a **new draft** flagged `source.phase7.needsReview`.
- The editor shows a banner: "Converted to a EUR price for your review (version 1 (published), at 57.23 EGP per 1 EUR, automatic): …".

**Nothing is published.** Publishing is still your step, per product.

**Drafts you've edited are not overwritten; they are listed**, with what the conversion would make.
- A draft counts as untouched only if 063 made it *and* it still matches what 063 made from its source version. Every other draft counts as a person's.
- The Giza draft was made in the editor, so it is listed, not replaced.
- To replace listed drafts after review, run `--apply --replace=GIZA` (product codes).

**Worked example:** Giza's first tier, 5,192 EGP ÷ 57.23 = 90.72, becomes **€91**. With the old 97 rate it would have been €54.

## 5. Decisions to confirm

1. **Automatic with no approved market rate is refused.** There is nothing to take less the buffer, and quietly keeping the manual rate while showing "automatic" would mislead. You stay on Manual until the first fetch is approved.
2. **A manual rate is kept until changed.** The old override was replaced at the next weekly update.
3. **Existing EGP-priced versions keep working** until their EUR draft is published. Nothing switches to EUR without your review.
4. **A booking with no locked rate** (from before the model) counts in revenue at the current rate.
5. **The coverage check at publishing** (the first tier starts at the GoAhead minimum or below, the last ends at the maximum group or above) is new, and it applies to every product.

## 6. Applying it

1. **Apply 065 after 064.**
   - `DATABASE_URL=<production> npm run db:migrate` runs everything in order and is safe to rerun.
   - Or paste `docs/ops/apply-migration-065.sql` into the Supabase SQL editor.
   - Rollback: `server/db/down/schema_065_exchange_mode_eur_prices.down.sql`.
2. **Deploy.**
3. **Make sure a site-wide rate exists:** Finance → Rates and settings shows it. If not, fetch and approve one, or choose Manual and enter one with a reason.
4. **Dry run:** `DATABASE_URL=<production> node scripts/phase7-convert.js`. It is read-only and prints each product, what would happen, and every ⚠ problem draft.
5. **Write the drafts:** `node scripts/phase7-convert.js --apply`. Add `--replace=CODE,…` for listed drafts you want replaced.
6. **Review and publish:** open each product in Admin → Rate card, check the EUR price, and publish.

## 7. Tests

**`server/eur-prices.test.js`** (no database):
- €97 at 59 is 5,723 EGP per traveller. With transport 2,650 and guide 2,000 per group, entry 2,250 and lunch 400 per traveller, a 5% fee and 10% commission, **4 travellers → pool 4,590.3 and 8 → 14,063.1**.
- Revenue at mixed locked rates.
- The EUR price is charged exactly.
- No rate means no calculation.
- Automatic: 59 less 3% = 57.23, and 3,200 EGP → €56.
- The manual-vs-market warning.
- The tier-removal cause and its fix, and the publish guard.
- The single price is built from the first tier, 4–8, with cost lines kept.
- The EUR conversion, and which drafts are left alone.

**`server/fx.integration.test.js`** (new tests):
- Automatic mode with 59 and 3% gives 57.23.
- Manual 58.0 is used exactly; the switch and every change need a reason and are in the history and the audit log; a gap over 5% is warned.
- The daily fetch still runs in Manual mode.
- Switching back to Automatic gives the buffered market rate; with no approved market rate it is refused.

**`server/pool-model.integration.test.js`** (new test):
- €97 is charged exactly.
- Bookings keep 59 across a switch to Automatic (57.23).
- Revenue is €97 × each booking's own rate (22,548.62 → pool 4,281.26).
- A lone 10–12 tier can't be published.
- The earlier no-rate test still passes: no euro prices and no payment requests.

**`server/phase7.integration.test.js`** (new):
- The repaired 063 takes the first tier, the product's range and all cost lines.
- The conversion rounds up at the current rate and creates drafts for review.
- Edited drafts are listed, not overwritten; nothing is published; a second run does nothing more; `--replace` works.

**Results:**
- `node scripts/ci-gate.js`: all 11 runnable steps pass.
- Full suite against a local Postgres 16: the same 8 failures as main in this container, and nothing new.
- **Not checked:** I have not looked at the rate card editor or Finance screen in a browser.
