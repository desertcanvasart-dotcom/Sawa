# Runbook: switching on `catalogue_v2` in production

The exact order to switch on the catalog, the operator roster and settlements (model phases 1–3) on sawa.tours, with a check before and after each step, and the rollback order.

**The flag is the last step.** Everything before it runs with `catalogue_v2` off, and with the flag off:
- the public site, booking and jobs behave as they do today;
- the new admin screens are staff-only.

Nothing reaches a traveler, an operator or an agency until step 9.

Conventions:
- `$PROD` is the production `DATABASE_URL` (Supabase). Run SQL with `psql "$PROD"`.
- **Read-only checks** are marked `-- check`. Anything that writes is spelled out.
- **Migrations don't run on deploy** (`docs/RUNBOOK.md`). Every step here is by hand.
- The admin paths (Admin → …) are in the staff portal at `/admin`.

---

## 0. Before anything

1. **Main contains phases 1–4** (PRs #219, #220, #222 and the phase 4 PR) **and the security fix** (#221), and that build is deployed. Check that the deployed commit is main's head.
2. **Take a backup.** Use Supabase → Database → Backups, or:
   ```bash
   pg_dump "$PROD" --format=custom --file=sawa-before-catalogue-v2-$(date +%F).dump
   ```
   Keep it until step 9 has run cleanly for a week.
3. **Confirm the flag is off.** Railway → the web service → Variables: `FEATURES` is unset or doesn't contain `catalogue_v2`.
4. **Confirm production is up to date to 046:**
   ```bash
   PRODUCTION_DB_HOST=<supabase host> DATABASE_URL="$PROD" npm run check:applied-schema
   ```
   ```sql
   -- check: the last applied migrations; 046 must be there, 047–053 must not
   SELECT name, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 5;
   ```
5. **Count the legacy departures still open.** They keep the existing settlement tools until the last one completes. Note the numbers.
   ```sql
   -- check: legacy departures still open, and the date of the last one
   SELECT COUNT(*) AS still_open, MAX(COALESCE(d.end_date, d.start_date, d.date)) AS last_date
     FROM departures d
    WHERE d.status NOT IN ('cancelled', 'closed')
      AND NOT EXISTS (SELECT 1 FROM catalogue_departures cd WHERE cd.legacy_departure_id = d.id);
   ```
   Until 047 is applied, `catalogue_departures` doesn't exist, so drop the `AND NOT EXISTS …` line for this first count.
6. **Snapshot what must not change.** Re-run this after each migration: the numbers must be identical.
   ```sql
   -- check: live bookings and departures
   SELECT (SELECT COUNT(*) FROM pledges WHERE status <> 'cancelled') AS live_pledges,
          (SELECT COUNT(*) FROM departures WHERE status NOT IN ('cancelled','closed')) AS open_departures,
          (SELECT COUNT(*) FROM tour_products WHERE status = 'approved' AND active) AS live_listings;
   ```

---

## 1. Migrations 047–053

`npm run db:migrate` applies every pending migration in one go, and is safe to re-run. To check between them, apply them one at a time as below instead. Each file is idempotent. Stop at the first error: `-v ON_ERROR_STOP=1` does that.

For each migration, the pattern is:
1. run the pre-check;
2. apply the file;
3. record it;
4. run the post-check;
5. re-run check 0.6.

### 1a. 047: catalog and departure calendar

**Pre-check:**
```sql
-- check: nothing from 047 exists yet
SELECT to_regclass('catalogue_products') AS products, to_regclass('catalogue_departures') AS departures;
```

**Apply and record:**
```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_047_catalogue_calendar.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('047_catalogue_calendar') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: the seeded catalog (about 21 products, codes P01–P21), each draft spec, and its listing link
SELECT catalogue_no, code, title, type, status, legacy_product_id IS NOT NULL AS linked
  FROM catalogue_products ORDER BY catalogue_no;
SELECT COUNT(*) FILTER (WHERE state = 'draft') AS drafts, COUNT(*) FILTER (WHERE state = 'published') AS published
  FROM catalogue_spec_versions;                                  -- expect drafts only, 0 published
SELECT relname, relrowsecurity FROM pg_class
 WHERE relname IN ('catalogue_products','catalogue_spec_versions','catalogue_calendar_rules','catalogue_departures','catalogue_events');
```

In Admin → Catalog, **check the listing links of #2, #6, #8 and #17** (`docs/phase1/REPORT.md`, "Specs still to complete"). Then re-run check 0.6.

### 1b. 048: cancellation notices; 30-day deadline

**Pre-check:**
```sql
-- check
SELECT to_regclass('catalogue_notices');                          -- expect null
SELECT catalogue_no, type, goahead_deadline_days FROM catalogue_products WHERE type IN ('cruise','multi_day');
```

**Apply and record:**
```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_048_catalogue_notices.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('048_catalogue_notices') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: the table exists, empty; cruises and multi-day at 30 days
SELECT COUNT(*) FROM catalogue_notices;                           -- expect 0
SELECT catalogue_no, goahead_deadline_days FROM catalogue_products WHERE type IN ('cruise','multi_day');   -- expect 30
```

### 1c. 049: operators, roster, rate card, assignment, manifest

**Pre-check:**
```sql
-- check: the companies 049 will turn into pending operators
SELECT id, name, relationship FROM agencies
 WHERE relationship = 'operator' OR name = 'Capital Travel Service'
    OR EXISTS (SELECT 1 FROM tour_products t WHERE t.agency_id = agencies.id);
-- check: the roles in use (049 widens the role check; nothing existing may break it)
SELECT role, COUNT(*) FROM app_users GROUP BY role;
```

**Apply and record:**
```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_049_operators_roster_rates.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('049_operators_roster_rates') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: one pending operator per company listed in the pre-check. A Capital Travel Service record, if 049 creates one, stays pending: 053 blocks its activation (CTS is not involved in Sawa)
SELECT id, legal_name, agency_id, status FROM operators ORDER BY legal_name;
-- check: the lock-at-first-seat trigger is in place
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_catalogue_lock_on_first_seat';
-- check: the new booking columns exist and are empty
SELECT COUNT(*) FILTER (WHERE pickup_point IS NOT NULL) AS with_pickup FROM pledges;   -- expect 0
```

Re-run check 0.6. A booking made now still works, because the trigger only records the rate and spec a catalog departure sells under.

### 1d. 050: settlements and commissions

**Pre-check:**
```sql
-- check
SELECT to_regclass('operator_payables') AS payables;             -- expect null
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'agencies' AND column_name IN ('country_code','billing_approved','billing_due_days');   -- expect none
```

**Apply and record:** 050 carries its own transaction, so it has no `--single-transaction`.
```bash
psql "$PROD" -v ON_ERROR_STOP=1 -f server/db/schema_050_settlements_commissions.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('050_settlements_commissions') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: the four Schedule 6 penalties, all 0 until set
SELECT code, amount_egp FROM operator_penalty_rates ORDER BY code;
-- check: every new table has RLS on
SELECT relname, relrowsecurity FROM pg_class WHERE relname IN
  ('booking_completion_requests','operator_bank_accounts','operator_bank_access_log','egypt_holidays','fx_rates',
   'operator_penalty_rates','operator_payables','operator_adjustments','operator_receivables','operator_setoffs',
   'settlement_statements','commission_statements','agency_commissions','agency_invoices','finance_payments','finance_settings');
-- check: no agency is on billing yet
SELECT COUNT(*) FROM agencies WHERE billing_approved;            -- expect 0
```

**Then:**
```bash
PRODUCTION_DB_HOST=<supabase host> DATABASE_URL="$PROD" npm run check:applied-schema   # expect all applied
```

Re-run checks 0.5 (the full query now) and 0.6. Open sawa.tours and book nothing: the site must look exactly as before.

### 1e. 051: pay at GoAhead and the cancellation tiers

Apply 051 **before** deploying a build that contains phase 4 with the flag on: with the flag on, phase 4's booking routes and jobs expect its tables.

**Pre-check:**
```sql
-- check
SELECT to_regclass('payment_requests') AS requests, to_regclass('cancellation_tier_versions') AS tiers;   -- expect null, null
SELECT COUNT(*) FROM pledges WHERE cancelled_reason IS NOT NULL;   -- note the number
```

**Apply and record:** 051 has no transaction of its own, so use `--single-transaction`.
```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_051_pay_at_goahead.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('051_pay_at_goahead') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: tier version 1, published, from 2026-01-01, ten rows (day and one-way tours 48 h → 0%, then 10%; cruise and multi-day 30 d → 0%, 15 d → 12.5%, then 25%)
SELECT v.version, v.state, v.effective_from, t.product_type, t.min_before_hours, t.unit, t.retained_pct
  FROM cancellation_tier_versions v JOIN cancellation_tiers t ON t.version_id = v.id ORDER BY t.product_type, t.min_before_hours DESC;
-- check: every existing booking is on the legacy flow
SELECT payment_mode, COUNT(*) FROM pledges GROUP BY payment_mode;            -- expect only legacy_link
-- check: the payment window and waitlist hold
SELECT value FROM finance_settings WHERE key = 'pay_at_goahead';            -- {"windowHours": 48, "offerHours": 12}
-- check: RLS on
SELECT relname, relrowsecurity FROM pg_class WHERE relname IN
  ('cancellation_tier_versions','cancellation_tiers','payment_requests','payment_refunds','payment_tasks','departure_waitlist');
```

Re-run check 0.6.

### 1f. 052: pay-at-GoAhead safeguards and versioned Terms

Apply it together with 051, before a build containing it runs with the flag on.

```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_052_pay_safeguards_terms.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('052_pay_safeguards_terms') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: Terms version 1 of each series, published from 2026-01-01
SELECT scope, version, state, effective_from, document_url FROM terms_versions ORDER BY scope, version;
SELECT relrowsecurity FROM pg_class WHERE relname = 'terms_versions';       -- expect t
```

Re-run check 0.6.

### 1g. 053: the seller and the collecting agent

```bash
psql "$PROD" -v ON_ERROR_STOP=1 --single-transaction -f server/db/schema_053_seller_disclosure.sql
psql "$PROD" -c "INSERT INTO schema_migrations (name) VALUES ('053_seller_disclosure') ON CONFLICT (name) DO NOTHING"
```

**Post-check:**
```sql
-- check: any Capital Travel Service operator record is pending and blocked from activation
SELECT id, legal_name, status, activation_blocked FROM operators WHERE legal_name ILIKE 'capital travel%';
```

Re-run check 0.6.

---

## 2. Publish the specifications

In **Admin → Catalog**, for each product that will sell at launch:
1. Complete the draft. The product's "to complete" tag lists what's missing: vehicle class per band, guide languages, meals, pickup window, add-ons, and the itinerary with timings for day tours.
2. Tick **"Ask travelers for their nationality"** where the product's site tickets need it.
3. Check the calendar rules. Cruises #17 and #18 need the ship's sailing days as dates. Held #2 and #3 and retired #14 have no rules.
4. Publish the spec with an effective date.
5. Admin → Calendar → **Run generator now**. With the flag off it creates catalog departures (and adopts existing dates) but makes nothing bookable.

```sql
-- check: a published spec for every product that will sell
SELECT c.catalogue_no, c.status, MAX(s.version) FILTER (WHERE s.state = 'published') AS published_version
  FROM catalogue_products c LEFT JOIN catalogue_spec_versions s ON s.product_id = c.id
 GROUP BY c.catalogue_no, c.status ORDER BY 1;
```

## 3. Enter and publish the rates

**Before the first seat sells:** a departure locks the rate version in force when its first seat is sold.

Phase 5 (migration 061, 28 Sep 2026) replaced the phase 2 card with the pricing and money model: `docs/phase5/REPORT.md`. There is no agency commission per seat any more; agencies are paid a share of each departure's pool.

1. Apply migration 061 (`npm run db:migrate`). It converts every existing version: the band fees become a per-group cost line, the per-traveler amount a per-traveler line, a twin room half its rate per traveler, operator fee 0%. Check what it did: Admin → **Rate card** → **What the conversion changed**, or `node scripts/pool-migration-report.js` (read-only).
2. The spreadsheet import (Admin → **Rate card** → **Import spreadsheet**) still reads the phase 2 columns and converts them the same way; it never sets selling prices.
3. Open each product and, in a new draft, enter per tier (4–6, 7–9, 10–12): the **selling price per traveler in EGP** and the **operator fee** (default 5% / 6% / 10% of operating cost); the **cost lines** (per group or per traveler, an EGP amount per tier); the **collecting agent's commission** (default 10%); and the **published EUR rate** (EGP per EUR, used only to show and charge travelers).
4. Read the live table (2 to 12 travelers) and its warnings: a **negative pool** means the Minimum Departure Guarantee pays; **"pool shrinks"** means adding that traveler lowers the pool.
5. **Publish** with an effective date of today or later. Publishing refuses missing cost amounts or fees, prices entered for only some tiers, and prices without the EUR rate. A version with no prices at all can be published: the operator is paid, but the tour page keeps the listing's price and the departure's pool waits (agency statements hold and say why), so enter prices before selling.

```sql
-- check: a published version in force for every active product, with prices and the EUR rate
SELECT c.catalogue_no, rv.version, rv.effective_from, rv.eur_rate, rv.commission_pct,
       (SELECT string_agg(t->>'priceEgp', ' / ') FROM jsonb_array_elements(rv.tiers) t) AS prices_egp,
       jsonb_array_length(rv.cost_lines) AS cost_lines
  FROM catalogue_products c
  LEFT JOIN LATERAL (SELECT * FROM catalogue_rate_versions v WHERE v.product_id = c.id AND v.state = 'published' AND v.effective_from <= CURRENT_DATE
                      ORDER BY effective_from DESC, version DESC LIMIT 1) rv ON true
 WHERE c.status = 'active' ORDER BY 1;
```

## 4. Operators: documents, approvals, bank details

In **Admin → Operators**, for each operator that will run tours (**not** Capital Travel Service: its record stays pending and can't be activated). Enter each operator's **license no. shown to travelers**: it is printed as seller on payment requests, receipts and vouchers.
1. Complete the record: legal name, license, ETAA, commercial registration, tax number, email and phone.
2. Upload the four documents, each with its number and expiry: tourism license, ETAA membership, liability insurance and vehicle insurance.
3. Tick the **approved products**.
4. **Activate.** Activation refuses a missing or expired document.
5. **Bank details:** enter them, or have the operator's owner enter them in the portal. Then **Verify**. The holder must be the legal name. No payment can be recorded until the details are verified.
6. **Portal logins** (super admin): create an owner login and share the temporary password.

```sql
-- check: active operators with current documents, approvals and verified bank details
SELECT o.legal_name, o.status,
       (SELECT COUNT(*) FROM operator_documents d WHERE d.operator_id = o.id AND d.superseded_at IS NULL AND d.expires_on >= CURRENT_DATE) AS current_docs,
       (SELECT COUNT(*) FROM operator_product_approvals a WHERE a.operator_id = o.id) AS approved_products,
       EXISTS (SELECT 1 FROM operator_bank_accounts b WHERE b.operator_id = o.id AND b.state = 'verified') AS bank_verified,
       EXISTS (SELECT 1 FROM app_users u WHERE u.operator_id = o.id AND u.status = 'active') AS has_login
  FROM operators o ORDER BY o.legal_name;                        -- launch operators: active, 4, >0, true, true
```

## 5. Finance reference data

In **Admin → Finance → Rates and settings:**
1. **Exchange rates:** enter today's CBE rate (EGP per 1 EUR). Enter it again every business day from now on.
   - The margin report shows "rate missing" for any charge date without one.
   - A commission statement to an Egyptian agency waits for the rate on its statement date.
2. **Public holidays:** enter the year's Egyptian public holidays. The operator advance is due 2 business days (Sun–Thu) after acknowledgement, skipping these.
3. **Penalty amounts (Schedule 6):** enter the four amounts in EGP once agreed. They are 0 until set.
4. **Payment provider fees:** the percentage and fixed amount per charge, for the margin report.
5. **Pay at GoAhead** (super admin, Admin → Finance → Pay at GoAhead → Settings): the payment window (48 or 24 hours) and how long a waitlist offer is held (12 hours).

In **Admin → Finance → Cancellation tiers**, read the tiers in force (version 1, seeded) and the **loss check** under them. It flags each product where a cancellation after the cut-off (or GoAhead deadline) keeps less than Sawa still owes the operator for that seat. It needs today's exchange rate and the rate card. With the rate card's example (€95, 2,200 EGP a traveler, 55 EGP/EUR), 10% under 48 hours loses €30.50 a seat: decide whether to publish new tiers before the flag. A change is a draft, published by a super admin from today or a later date; bookings keep the version they were made under.

In **Admin → Finance → Agency commission** (super admin), for each agency:
- set its country code (`EG` for Egyptian agencies);
- set its billing approval and invoice due days.

```sql
-- check
SELECT MAX(day) AS latest_rate FROM fx_rates;                    -- expect today
SELECT COUNT(*) AS holidays FROM egypt_holidays WHERE day >= CURRENT_DATE;
SELECT code, amount_egp FROM operator_penalty_rates;
SELECT value FROM finance_settings WHERE key = 'payment_fees';
SELECT id, name, country_code, billing_approved, billing_due_days FROM agencies ORDER BY name;
```

## 6. Publish the roster

Admin → **Roster**, for this month and next:
1. Plan each product's weekdays.
2. **Build month from plan.**
3. Adjust single dates.
4. **Publish.**

Publishing refuses an entry whose operator isn't active and approved. From now on, a month is due by the 15th of the month before.

Since phase 5 part 1 the roster is the **fallback**: at GoAhead the departure is first offered to the approved agency with the most travelers on it (link an agency to its operator record with `operators.agency_id`); the rostered operator is offered it only if no agency qualifies or accepts. Publish the roster all the same: a departure with no agency on it goes to the roster.

```sql
-- check: published months, and any open departure with nobody rostered (should be none you intend to sell)
SELECT month, state, published_at FROM roster_months ORDER BY month;
SELECT cd.id, c.code, cd.date FROM catalogue_departures cd JOIN catalogue_products c ON c.id = cd.product_id
 WHERE cd.status IN ('open','go_ahead') AND cd.date <= CURRENT_DATE + 60
   AND NOT EXISTS (SELECT 1 FROM roster_entries e JOIN roster_months m ON m.month = e.month AND m.state = 'published'
                    WHERE e.product_id = cd.product_id AND e.date = cd.date)
 ORDER BY cd.date;
```

## 7. Scheduler and email

1. **Check the scheduler is on** (it is in production: `NODE_ENV=production`, and `DISABLE_JOB_SCHEDULER` unset). The boot log lists the catalog jobs.
2. **Check email delivery is live.** `RESEND_API_KEY` is set, and `/api/modes` shows email mode `live`.
   - Travelers get cancellation notices and booking-detail requests.
   - Operators get assignments, reminders and statements.
   - Agencies get commission statements.
3. **Check `APP_URL`** is `https://sawa.tours`: it is the base of every link in those emails.

## 8. Last look before the flag

- [ ] Checks 0.5 and 0.6 still match your notes.
- [ ] Every product that will sell has a published spec (step 2) and a rate version in force (step 3).
- [ ] Launch operators are active, approved, with verified bank details and logins (step 4).
- [ ] Today's CBE rate, the holidays, penalties and fees are set (step 5).
- [ ] This month's and next month's rosters are published (step 6).
- [ ] Pay at GoAhead is understood by ops (`docs/phase4/REPORT.md`): catalog bookings pay the full price after GoAhead; ops make each Tab link with the booking code as its reference, paste it into Admin → Finance → Pay at GoAhead, mark payments with Tab's reference, and make refunds in Tab from the task list. Legacy bookings keep the deposit and balance links in Admin → Payments.
- [ ] The cancellation tiers and their loss check are reviewed (step 5).
- [ ] The Terms for catalog bookings are approved by the lawyer (`docs/legal/terms-catalogue-draft.md`) and published as catalog Terms version 2 (Admin → Finance → Tiers and Terms).
- [ ] The staging rehearsal (`docs/launch/rehearsal.md`) is complete, every check ticked.

## 9. Set the flag

Railway → web service → Variables: set `FEATURES=catalogue_v2` (comma-separate if other flags are set). Railway redeploys.

**Right after deploy:**
1. The boot log says `catalogue_v2 is ON: generated departures are bookable`.
2. Admin → Calendar → **Run generator now**. Catalog departures with a published spec become bookable dates.
3. Open a catalog tour page:
   - the dates show the catalog labels;
   - the booking form asks for every traveler's name, the phone, pickup, nationality where set, and safety needs.
4. Make one test booking on a date far out, as a direct traveler, then cancel it from the booking email's link.
5. An operator logs in to `/portal` and sees Assignments, Roster, Statements & payments and Notices.

```sql
-- check, the hour after
SELECT COUNT(*) FROM catalogue_departures WHERE legacy_departure_id IS NOT NULL AND date >= CURRENT_DATE;   -- bookable catalog dates
SELECT type, COUNT(*) FROM catalogue_events GROUP BY type;
```

---

## Rollback order

Roll back **only as far as needed**, in this order. Each step stops at the smallest change that removes the problem.

**1. Turn the flag off.** Remove `catalogue_v2` from `FEATURES` and let Railway redeploy. This alone stops everything outside the staff screens:
- public catalog labels and required booking fields;
- operator, agency and booking-details routes (404);
- all phase 2–4 jobs: assignment, advances, balances, statements, commission, completion requests, payment requests, reminders, releases and waitlist offers.

Payment requests already sent stay as they are: ops can still mark them paid in Admin → Finance → Pay at GoAhead, and nothing is released while the flag is off.

Nothing is deleted. Bookings made meanwhile stay ordinary bookings on ordinary departures. Try this first, and investigate with the data intact.

**2. Stop the scheduler, only if a job itself misbehaves with the flag off.** Set `DISABLE_JOB_SCHEDULER=1`. The phase 1 generator and status job still run with the flag off: they create catalog records and cancel below-minimum catalog dates, and nothing else.

**3. Roll back migrations, only if the schema itself is the problem.** Newest first, one at a time, with the flag off. Export anything you need first: each rollback drops its tables and their data.

| Order | Rollback | Loses |
|---|---|---|
| 1st | `psql "$PROD" -v ON_ERROR_STOP=1 -f server/db/down/schema_053_seller_disclosure.down.sql` | the licence numbers shown to travelers, the activation block, each receipt's recorded seller and number |
| 2nd | `psql "$PROD" -v ON_ERROR_STOP=1 -f server/db/down/schema_052_pay_safeguards_terms.down.sql` | Terms versions and each booking's recorded version; link alerts and admin decisions (an unsecured seat goes back to waiting for its link) |
| 3rd | `psql "$PROD" -v ON_ERROR_STOP=1 -f server/db/down/schema_051_pay_at_goahead.down.sql` | payment requests, refunds, ops tasks, the waitlist, every tier version; the bookings' payment mode and tier version; `unpaid` cancellations become `admin` |
| 4th | `psql "$PROD" -v ON_ERROR_STOP=1 -f server/db/down/schema_050_settlements_commissions.down.sql` | payables, receivables, set-offs, statements, commissions, invoices, recorded payments, bank details and their log, FX rates, holidays, penalties, completion requests; agencies' billing columns |
| 5th | `…/down/schema_049_operators_roster_rates.down.sql` | operators, documents, approvals, strikes, notices, roster, rate versions, assignments, manifests and their access log, the lock trigger; **operator logins (deleted)**; the three booking-detail columns on pledges |
| 6th | `…/down/schema_048_catalogue_notices.down.sql` | the cancellation-notice log. Cruise and multi-day deadlines stay at 30, the decided value. |
| 7th | `…/down/schema_047_catalogue_calendar.down.sql` | the catalog, specs, rules, catalog departures and events. Ordinary departures and bookings created for catalog dates stay, as ordinary rows. |

Each rollback deletes its own `schema_migrations` row. **`npm run db:migrate` re-applies every migration it finds**, so after a rollback don't run it until the problem is fixed and you mean to re-apply.

**After any rollback:** re-run checks 0.5 and 0.6. If data was lost that you need, restore from the step 0.2 backup into a separate database and copy the rows back. Don't restore over production.
