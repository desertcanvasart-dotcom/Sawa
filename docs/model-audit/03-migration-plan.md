# 03 · Proposed migration plan

This is a plan to review, not a spec. Table sketches show intent; they are not migrations. File references point to [`01-current-state.md`](01-current-state.md) and [`02-gap-analysis.md`](02-gap-analysis.md).

---

## 1. Target schema

### 1.1 Principles

- **Evolve, don't rebuild.** `tour_products`, `departures` and `pledges` already model a product, a date, and seats on that date. They stay, gain columns and lose the listing, pricing-by-operator and request paths.
- **Store what is decided; compute nothing that changes after the fact.** The operator of a departure, the rate-card version, the commission rate and the manifest are all written once, at the moment they're decided, and read from then on. This reverses today's design, where the operator is recomputed on every read (`server/domain.js:520-597`).
- **Keep history readable.** Tables for the old money model (043–046) become read-only legacy. Nothing that has recorded money is dropped.
- **Money in minor units** (integer cents) with an explicit currency on every row. Today there is a mix: `pledges` uses INTEGER euros and `booking_payments` uses NUMERIC(10,2).

### 1.2 Sketch

```text
── Catalogue ───────────────────────────────────────────────────────────
products                      (evolves tour_products; keep table name to limit churn)
  id, catalogue_no 1–21 UNIQUE, title, slug
  product_type        day_tour | one_way | cruise | multi_day      ← replaces day_tour|package
  retail_price_minor, currency                                      ← flat price per seat
  min_seats (4), max_seats (12), cutoff_hours (48 default)
  goahead_deadline_days  NULL for day/one-way (see D6)
  itinerary, default_time, duration, nights, cities
  vehicle_by_band  jsonb [{band:'4-6', class}, {band:'7-9',…}, {band:'10-12',…}]
  guide_languages  text[]
  meals            jsonb
  pickup_area      jsonb (zone, hotels/areas served, meeting point fallback)
  included, not_included, overview_html, policies_html (Sawa-authored only)
  active
  -- dropped from use: break_price, price_tiers, base_cost, quality, agency_id,
  --   status/submitted_*/reviewed_*/rejection_reason, request_* window, deposit_percent

product_room_categories       (cruise / multi-day)
  id, product_id, name (e.g. "Standard cabin"), occupancy_options int[] {1,2,3}

product_addons
  id, product_id, name, description, price_minor, currency, active

calendar_rules
  id, product_id, pattern  weekly(weekdays[]) | fortnightly(anchor_date, weekday) | explicit(dates[])
  valid_from, valid_to, generated_through

── Departures ──────────────────────────────────────────────────────────
departures (existing; add)
  source           calendar | legacy_admin | legacy_request                ← replaces created_by
  status           scheduled | goahead | closed(cut-off) | completed | cancelled
                   (map: open→scheduled, minimum_reached/supplier_confirmed→goahead)
  goahead_at, cutoff_at (materialised), goahead_deadline_at
  operator_id        FK operators, NULL until assigned
  assignment_id      FK departure_assignments (current)
  rate_card_version_id  FK, stamped when the first seat sells  ← "rate changes never affect sold departures"
  manifest_frozen_at
  cancelled_reason   no_goahead | force_majeure | operator_failure | admin

── Bookings ────────────────────────────────────────────────────────────
pledges → keep table; add
  payment_mode       saved_card | agency_billing | legacy_link
  price_minor, currency           (flat price at booking; legacy rows keep existing columns)
  booking_agency_id  FK agencies (NULL = direct)   ← replaces agency_id='direct_customer' + ref_code inference
  attribution        account | widget | none
  consent_card_on_file_at, consent_text_version
  cancelled_at, cancelled_by, cancelled_reason (repurpose 023 columns)
  late_cancel_fee_minor
  no_show boolean

booking_travellers             (replaces free-text customers + unused traveller_names)
  id, pledge_id, full_name, is_lead
  safety_allergies, safety_dietary_medical, safety_mobility   (explicit consent; purged per retention)
  room_group_id NULL (pairing, cruises/multi-day)

booking_addons
  pledge_id, addon_id, quantity, price_minor

── Payments ────────────────────────────────────────────────────────────
payment_methods
  id, pledge_id, provider, provider_customer_id, provider_method_id,
  brand, last4, exp, mandate_reference, consented_at, revoked_at

charges
  id, pledge_id, kind  goahead | post_goahead_booking | addon | late_fee
  amount_minor, currency, provider_intent_id UNIQUE, idempotency_key UNIQUE,
  state requires_action | succeeded | failed | cancelled, attempts, last_error,
  succeeded_at

refunds
  id, charge_id, amount_minor, reason, provider_refund_id, state, created_by

invoices                       (seller of record = CTS)
  id, number (sequential per series), pledge_id | agency_id, issuer_entity,
  lines jsonb, total_minor, currency, tax jsonb, issued_at, pdf_path

booking_payments (043)         → legacy, read/write only for payment_mode = legacy_link

── Operators, roster, assignment ───────────────────────────────────────
organisations                  (legal company; one company can hold both roles)
  id, legal_name, trading_name, tourism_license_no/year, etaa_registration_no,
  insurance_*, verification_state, verified_at/by, payout_bank jsonb (encrypted)

operators                      id, organisation_id, status active | suspended | removed
agencies  (existing; add)      organisation_id, commission_billing_approved bool, credit_limit

operator_users / agency users  → app_users.role gains operator_owner | operator_staff
                                 (and app_users links to operator_id OR agency_id)

roster_periods                 id, month (YYYY-MM), published_at, published_by
roster_entries                 period_id, product_id, weekday 0–6 | date, operator_id
roster_swaps                   entry_id, from_operator, to_operator, date, state requested|approved|rejected

departure_assignments
  id, departure_id, operator_id, assigned_at, ack_due_at (assigned+12h),
  acknowledged_at, declined_at, state offered|acknowledged|declined|expired|replaced

── Rate card and settlement ────────────────────────────────────────────
rate_card_versions             id, product_id, currency, effective_from, created_by, notes
rate_card_lines
  version_id, component  per_traveller | land_per_traveller | departure_fee | room
  band  '4-6'|'7-9'|'10-12' (departure_fee), occupancy 1|2|3 + room_category_id (room),
  amount_minor

manifests                      departure_id, frozen_at, travellers jsonb (names, safety, add-ons, rooms),
                               seat_count, purge_at (tour end + 90 days)

operator_settlements
  id, departure_id, operator_id, rate_card_version_id, manifest_id,
  per_traveller_count (includes late-cancel + no-show), band,
  gross_minor, advance_minor, advance_paid_at/ref, balance_minor, balance_due_at, balance_paid_at/ref,
  penalties_minor, statement_path, state

── Agencies ────────────────────────────────────────────────────────────
agency_commission_rates        id, product_id, amount_minor_per_seat, currency, effective_from
agency_commissions             pledge_id, agency_id, rate_id, seats, amount_minor,
                               state accrued | earned (travelled) | partial (late-cancel share) | void,
                               statement_id
agency_statements              id, agency_id, month, total_minor, net_of_billing_minor, state, paid_at, bank_reference
agency_billing_invoices        → invoices with agency_id (published price − commission)

── Quality ─────────────────────────────────────────────────────────────
operator_ratings               departure_id, pledge_id, score 1–5, comment, created_at
operator_strikes               operator_id, departure_id, kind missed_ack | unapproved_substitution |
                               shopping_stop | service_failure, evidence, created_by, voided_at
operator_penalties             operator_id, departure_id, kind cancellation | no_show, amount_minor,
                               settlement_id
```

### 1.3 How existing records map

| Today | Target | Mapping |
|---|---|---|
| `tour_products.type='day_tour'` | `product_type` day_tour or one_way | Rate card #14–16 → one_way; the rest → day_tour |
| `tour_products.type='package'` | cruise or multi_day | #17–18 → cruise; #19–21 → multi_day |
| `published_rate` / `break_price` / `price_tiers` | `retail_price_minor` | Entered from the rate card, not derived. Old columns kept, unused |
| `tour_products.agency_id` (listing operator) | nothing | All live products are recorded as NULL (01 §7); verify, then retire |
| Agency-submitted listings (pending/rejected) | nothing | Archive (`active=false`) |
| `agencies` rows | `organisations` + `agencies` and/or `operators` | Every row gets an organisation. Rows that run tours (e.g. CTS, and any with `relationship='operator'`) get an operator row; rows that resell keep an agency row. **Decision D9** |
| `app_users` agency roles | unchanged for agencies; new operator roles | Operator logins are created fresh |
| `departures` (open / minimum_reached / supplier_confirmed) | status scheduled / goahead | `source=legacy_*`; `operator_id` NULL, to be set by hand for any date at GoAhead |
| `departures` pending_review | — | Resolve before removing requests (approve into scheduled, or decline) |
| `pledges` | pledges + booking_travellers | `payment_mode=legacy_link`; lead traveller from `customers`; the price columns stay as captured |
| `pledges.agency_id` + `ref_code` | `booking_agency_id` + `attribution` | Backfill from `passengerOwner` logic once, then store |
| `booking_payments` | legacy | Unchanged for legacy_link bookings |
| `departure_costs`, adjustments, payout runs/lines/transfers | legacy (read-only) | Kept for history. If 044–046 are in prod with approved runs, **no deletion** |
| `referrals` | kept for widget codes | `commission_percent` ignored; commission comes from `agency_commission_rates` |
| `operator_applications` | kept, plus an inbox | Link approved applications to organisations |

### 1.4 Departures and bookings mid-flight

Production held live pledges from 12 Aug (01 §7). Their current count is unknown, so **count before phase 2** (read-only query):
- departures by status and date;
- pledges by status, source and payment state;
- `booking_payments` by state;
- any `pending_review` requests;
- payout runs by state.

1. **Bookings made under "no card, pay by link" stay on that model.** Their terms promised no card and a payment link, and we can't retroactively save a card. They get `payment_mode=legacy_link`, and the existing manual Tab flow stays switched on for them until the last one has travelled or been refunded.
2. **A departure can hold mixed bookings** (legacy + saved-card). GoAhead counts all live seats, as today. At GoAhead, saved-card bookings are charged automatically; legacy ones get a link, as today. The guarantee applies to the departure, whichever payment route each seat uses.
3. **Prices.** Legacy bookings keep their captured `price_per_person`. New bookings on the same date pay the flat price. Where the flat price is higher than what earlier travellers were quoted, a mixed departure shows two prices; if it is lower, earlier travellers paid more. **Decision D16.**
4. **Departures already at GoAhead** before the roster exists are assigned an operator by hand (admin field) and marked `acknowledged` by staff. They settle under whichever model the operator agreed; old dates may still use the profit-share sheets.
5. **Empty legacy departures** that don't match the new calendar: cancel them, silently if they have no bookings. Ones that do match are adopted as calendar dates.
6. **Legacy settlements.** Runs in `draft` should be completed or discarded under the old rules before phase 4 turns on operator settlements. The Wednesday screens stay available read-only.

---

## 2. Phases

The order below changes the proposed one in two places. The code suggests both changes:
- **Roster and assignment move ahead of payments.** Charging cards at GoAhead also has to *assign* the departure to the rostered operator. Assigning after payments means the first automatic charges go out while the operator is still computed from passenger counts, and emails keep saying "this can change". Roster and assignment carry no money risk, so they can ship first and flush out operator-data problems.
- **Copy is not a final phase.** Each phase ships the copy for what it changes, because the payment and seller wording is legally binding (Terms §6, §12, §13) and currently says the opposite of the target. Phase 7 is a sweep of what's left.

A **phase 0** of prerequisites comes first.

### Phase 0: Prerequisites (1–2 weeks elapsed; mostly not code)
- **Scope:**
  - Fix the listing-takeover authorisation defect (01 §3). This could ship today, independent of the model.
  - Answer the decisions in §4.
  - Choose the payment provider and open the merchant account in CTS's name (§3); this has lead time.
  - Get counsel's Terms and Privacy wording for CTS as seller of record.
  - Fill the rate card and commission amounts.
  - Run the read-only production counts from §1.4.
- **Files:** `server/app.js:1018-1039` (defect only).
- **Migrations:** none.
- **Tests:** an agency editing a Sawa-owned product gets 403.
- **Could break:** nothing.

### Phase 1: Catalogue and calendar (M–L)
- **Scope:**
  - Four product types.
  - Product specification fields.
  - Flat retail price.
  - Import 21 products (merging #14/#15 if decided).
  - Calendar rules plus a generator job (idempotent; never removes a date with seats).
  - Admin calendar preview and publish.
  - Cut-off default 48 h; per-product GoAhead deadline in the editor.
  - Remove agency listing submission, operator pricing fields, date requests (per D7), the "first traveller required" rule, and the `quality` star.
  - Copy: "start your own date", "price drops as the group grows", operator-listing claims on the traveller pages.
- **Files likely touched:**
  - `server/db/` (new migration), `server/db/mappers.js`, `server/app.js` (product upsert 859-1144, departure creation 732-850, requests 1710-2011, bootstrap 619-718)
  - `shared/booking-policy.js` (`isPackage` branches → four types), `shared/pricing.js`, `shared/departure-state.js`, `server/domain.js` (pricing 141-147, 299-327)
  - `src/AdminDashboard.jsx` (ProductEditor), `src/main.jsx` (tour page, booking panel, widget), `src/AgencyDashboard.jsx` (drop listing sections, local `livePrice`)
  - `server/jobs/scheduler.js` + a new `calendar` job; `server/seo.js`, `site/*.html`, `scripts/sync-constants.js`
- **Migrations:**
  - add `product_type`, spec columns, `retail_price_minor`, `calendar_rules`, `departures.source`;
  - relax the date-request CHECKs;
  - backfill types from the mapping in §1.3.
- **Tests:**
  - generator idempotency and its no-delete guard;
  - type mapping;
  - flat price everywhere (server, browser and email agree);
  - a parity test for `rules.js` (`scripts/sync-departure-rules.js`);
  - the constants/copy tests (`server/constants.test.js`) updated for the new claims.
- **Could break:**
  - the SEO pages and sitemap (dates now exist without bookings);
  - the Autoura mirror (more departures, `server/autoura-sync.js`);
  - cached bootstrap payloads;
  - agency portal booking views that assume `livePrice`;
  - the audit-claims rules, which currently look for "price drops" wording.

### Phase 2: Operators, roster and assignment (M–L); was phase 3
- **Scope:**
  - Organisations; operator entity, roles and portal.
  - Roster periods, entries and swaps with admin approval.
  - Assign at GoAhead: from the roster for product × weekday, or by hand if none.
  - 12-hour acknowledgement with a timer job, escalation and an automatic strike record.
  - Operator view of assigned departures (headcount only until phase 4's manifest).
  - Remove `operatorForDeparture`/`DIRECT_BOOKINGS_OPERATOR` from bootstrap, emails and tour page.
  - Copy: "run by the partner with the most confirmed travelers" (`src/main.jsx:1845`; `server/email.js:495, 699`); "your operator has been notified" becomes true.
- **Files likely touched:**
  - `server/domain.js:494-634`, `server/operator-lookup.js`, `server/brand.js:170-174`, `server/auth.js` + `schema_002` roles, `server/app.js` (`attachUser`, new routes)
  - `server/departure-status.js` (GoAhead hook → create assignment), `server/goahead-alert.js`, `server/jobs/*`
  - new `src/OperatorDashboard.jsx`, `src/main.jsx` portal routing (1038-1060), `src/AdminDashboard.jsx`, `server/email.js`
- **Migrations:**
  - organisations, operators, operator roles on `app_users`;
  - roster tables, `departure_assignments`, `departures.operator_id`;
  - split `agencies` per D9.
- **Tests:**
  - roster resolution (weekday, date override, swap);
  - assignment written exactly once per GoAhead, inside the same transaction as `recordGoAhead`;
  - acknowledgement expiry creates a strike and alerts ops;
  - access: an operator sees only assigned departures.
- **Could break:**
  - settlement gating that uses the computed operator (`app.js:3403-3404, 3606-3626`). Keep it working for legacy dates or freeze legacy settlement first;
  - `server/operator-assignment.test.js` and `server/partners-page.test.js`, which encode the old rule;
  - the `/partners` page.

### Phase 3: Seat booking with saved card and GoAhead charge (L); was phase 2
- **Scope:**
  - Checkout collects the card through the provider's hosted fields, with explicit consent; nothing is charged.
  - Per-traveller names and safety needs (with consent), and listed add-ons.
  - At GoAhead a charge job runs with the idempotency key `departure:booking:attempt`. It retries, sends an update-card link and applies the failure rule (D5).
  - A booking made after GoAhead is charged at once.
  - Cancellation fees computed and refunded through the provider API.
  - Invoices and receipts in CTS's name.
  - Legacy link flow kept for `legacy_link` bookings.
  - Agency bookings: booking code plus a transactional confirmation; agency-billing bookings are not charged to the traveller (billing itself comes in phase 5).
  - **Seller-of-record switch-over:** brand constants, `server/entity-disclosure.test.js`, footer partial, Terms §§ 3, 6, 9, 12, 13, 15, Privacy (processor, controller, health data), JSON-LD `seller`.
  - All payment copy (01 §6d), shipped in the same release.
- **Files likely touched:**
  - `server/payments.js`, new `server/charges.js` + provider client, `server/app.js` (booking 1294-1353, agency pledge 1185-1219, cancel 1393-1652, payments 2939-3111)
  - `shared/booking-policy.js` (tiers rebased), `shared/payment-window.js` (retire for new bookings), `server/departure-status.js` (charge trigger)
  - `server/jobs/` (charge job, retry), `server/email.js` (confirmation, charge receipt, failure, refund)
  - `src/main.jsx` (checkout, booking lookup), `src/AdminPayments.jsx`
  - `server/brand.js`, `site/_partials/footer.html` (+ `scripts/sync-partials.js`), `site/terms.html`, `site/privacy.html`, `site/goahead-promise.html`, `site/how-it-works.html`, `site/faq.html`, `shared/site-copy.js`, `server/seo.js`
  - `package.json` (provider SDK), CSP in `server/csp.js` (provider script and frame origins)
- **Migrations:**
  - `payment_methods`, `charges`, `refunds`, `invoices`, `booking_travellers`, `booking_addons`;
  - `pledges.payment_mode` etc.;
  - backfill `legacy_link`.
- **Tests:**
  - GoAhead fires exactly one charge per booking under concurrency (two bookings reaching 4 at once);
  - provider webhook replay is idempotent;
  - failed-charge path;
  - cancellation-fee arithmetic per tier;
  - the legacy link path is unaffected;
  - no card data touches the server (only tokens);
  - the entity-disclosure test is inverted to assert CTS;
  - a rehearsal against the provider's test mode (in the style of `scripts/rehearse-goahead-alert.sh`).
- **Could break (highest risk in the programme):**
  - double charges;
  - charges on dates that should not have reached GoAhead (pending_review; the request-approval bug at `app.js:1942-1945`);
  - failures while `GOAHEAD_*` jobs are still dry;
  - CSP blocking the provider iframe;
  - legal exposure if copy and behaviour don't switch together.
  
  Roll out behind a flag per product, starting with one day tour.

### Phase 4: Rate card and operator settlement (M–L)
- **Scope:**
  - Rate-card versions and lines, with an importer from `sawa-rate-card.xlsx`; the version is stamped on the departure at first seat sold.
  - Manifest frozen at cut-off and shown to the operator (access expires 90 days after the tour, with a purge job).
  - Operator settlement: advance after assignment or acknowledgement (D14), balance within 7 days after the tour from the manifest, counting late cancellations and no-shows. No-show recording.
  - Statements; operator payout bank details (encrypted).
  - Retire the profit-share settlement for new departures.
  - Rooming and pairing for cruises and multi-day, which feeds per-room amounts (D15).
- **Files likely touched:**
  - `server/settlement.js` (legacy only), new `server/operator-settlement.js`, `server/app.js:3248-3635`
  - `src/AdminSettlements.jsx`, `src/AgencyMoney.jsx` → operator money view, new manifest views, `server/jobs/` (freeze at cut-off, purge)
- **Migrations:** `rate_card_versions`, `rate_card_lines`, `manifests`, `operator_settlements`, `departures.rate_card_version_id`, `manifest_frozen_at`, and the organisation bank fields.
- **Tests:**
  - band edges (6/7, 9/10);
  - late-cancel and no-show counted;
  - a rate change after the first sale doesn't move the settlement;
  - the room-occupancy arithmetic matches the workbook's example rows (EX rows: 58.6 / 181.2 / 303.8 margins; cruise 1252 / 752);
  - the purge removes safety data after 90 days.
- **Could break:** the legacy Wednesday runs, if the payout tables are shared. Keep the legacy code path separate.

### Phase 5: Agency commission, billing and statements (M)
- **Scope:**
  - Per-product commission rates (versioned).
  - Accrual at booking; earned when the traveller travels; partial on retained late-cancel fees (D13).
  - Monthly statements and payout (re-use the run/transfer/bank-reference pattern).
  - Agency billing for approved agencies: an invoice at GoAhead for published price minus commission, credit limits (D12).
  - Agency client flag, enforced in any marketing query.
  - Copy: `site/widget.html`, `src/AgencyMoney.jsx`, `src/AgencyDashboard.jsx` Promote and KPIs.
- **Files:** `server/app.js` (agency routes 1185-1441, 2066-2110, 3090-3111, 3601-3635), `src/AgencyDashboard.jsx`, `src/AgencyMoney.jsx`, `server/email.js`, admin agency screens.
- **Migrations:** `agency_commission_rates`, `agency_commissions`, `agency_statements`, `agencies.commission_billing_approved`/`credit_limit`.
- **Tests:**
  - commission earned only on travel;
  - late-cancel partial;
  - billing invoice equals published price minus commission;
  - agency A cannot see agency B's clients;
  - marketing exclusion.
- **Could break:** widget attribution, if `ref_code` is replaced; keep `ref_code` capture.

### Phase 6: Quality and penalties (S–M)
- **Scope:**
  - Post-tour rating request.
  - Strikes: automatic (missed acknowledgement) and manual (substitution, shopping stop, service failure).
  - Penalties as negative settlement lines.
  - A removal-from-roster rule and admin action.
  - Operator scorecard.
- **Migrations:** `operator_ratings`, `operator_strikes`, `operator_penalties`.
- **Tests:** penalty deduction; roster exclusion after N strikes.
- **Could break:** nothing live.
- **Note:** ratings shown publicly would re-open the "no reviews table" claim history (`docs/audit/approvals-register.md`); keep them internal until a review policy exists.

### Phase 7: Copy and terms sweep (S–M)
- **Scope:**
  - Everything in 01 §6 not already shipped: the operator recruitment pages (`site/operators.html`, `site/verify.html`), About, FAQ operator section, footer column "List with Sawa".
  - Remove the SPA copies of legal pages (`src/main.jsx:3378-3553`) in favour of the static ones.
  - `llms.txt`/`llms-full.txt` (`server/seo.js`).
  - The operator application form becomes a roster supplier application.
- **Tests:** `npm run audit:claims` with rules updated for the new model (`scripts/audit-claims.js` RULES); the partials and constants checks.
- **Could break:** SEO (titles and descriptions), and the audit-claims daily email if its rules aren't updated with the copy.

---

## 3. Payment-provider requirements

The current provider is **Tab (tab.travel), used only through links made by hand**. Nothing in the repo calls Tab (`server/payments.js:3-8`: "Nothing here talks to Tab"). So **the code cannot show whether Tab supports any capability below.** Each needs confirming with Tab, or with the provider chosen instead. This table does not guess.

| Capability | Needed for | Tab, per the code |
|---|---|---|
| Hosted card capture (the card never touches Sawa's server) | Checkout; PCI scope | Tab's hosted payment page is used today for one-off payments; card capture *without* charging: **can't tell** |
| Saved payment method / customer object with a merchant-initiated (off-session) mandate and consent record | Save at booking, charge later | **Can't tell** |
| Off-session charge **days to weeks** after saving (cruise GoAhead deadlines are 21–30 days out; bookings can be months ahead) | GoAhead charge | **Can't tell**. Also check card-network rules on stored credentials and how long the provider keeps the token |
| Strong Customer Authentication handling / 3-D Secure exemptions for merchant-initiated transactions, with a fallback "authenticate this charge" link | EU/UK cards charged off-session | **Can't tell** |
| API with idempotency keys | No double charge at GoAhead | **No API used today** |
| Webhooks (charge succeeded/failed, refund, dispute) | Charge state; failed-charge flow | **No webhooks today** (the only webhook in code is Autoura) |
| Partial refunds by API | Cancellation tiers, late-cancel fees | Refunds are done by hand in Tab and recorded with a reference (`app.js:3076-3088`); by API: **can't tell** |
| Card update link for failed charges | D5 | **Can't tell** |
| Merchant account in CTS's name; settlement currency (EUR vs USD, D1); Egyptian entity eligibility | Seller of record | **Not recorded in code** (DIR-18 vs DIR-22) |
| Statements / payout reports (per charge, fees, net) for reconciliation | Settlement, accounting | **Can't tell**; the rate card assumes a 3% placeholder fee |
| Disputes / chargebacks API | Operations | **Can't tell** |
| Invoices | Seller-of-record receipts | Can be generated by Sawa; doesn't depend on the provider |
| Payouts to operators and agencies | Advance, balance, commission | Today by bank transfer, recorded by hand. Keep as manual bank transfers unless the provider offers compliant payouts to Egyptian banks: **can't tell** |

---

## 4. Decisions needed from you

1. **D1 Currency.** The rate card is in USD (Assumptions sheet: "replace with the currency you agree with operators"); the site, prices, `booking_payments` and Terms are in EUR (`shared/currency.js:34`; `site/terms.html:198`). Do travellers pay EUR while operators are paid USD? Who carries the exchange risk?
2. **D2 What is charged at GoAhead.** The full seat price? Today there is a deposit (10% / 25%) plus a balance due 2 or 14 days before (`shared/booking-policy.js:53-86`). A GoAhead for a cruise can come weeks ahead; a day-tour GoAhead may come 48 h out. One full charge simplifies everything; confirm.
3. **D3 Seller-of-record mechanics.**
   - What is Online Era's role once CTS sells: platform licensor to CTS, or CTS trading as "Sawa Tours"?
   - Whose name appears in the footer, on invoices, on card statements (descriptor) and as data controller?
   - Tax treatment of invoices.
   - This supersedes DIR-19 and DIR-22 (`docs/audit/open-directives.md`) and inverts `server/entity-disclosure.test.js`.
4. **D4 Payment provider.** Tab (if it has the §3 capabilities) or another provider. That choice gates phase 3.
5. **D5 Failed charge at GoAhead.**
   - How long does a traveller have to fix a card?
   - Is the seat released?
   - If failures take paid seats below 4, is the departure still guaranteed? (The target says guaranteed after GoAhead; the Terms §13.2 refill/refund clause says otherwise.) Is GoAhead reached on *booked* seats or on *successfully charged* seats?
6. **D6 Day tours and one-way tours with no deadline.** The target gives GoAhead deadlines only for cruises and multi-day. Does a day tour that never reaches 4 stay open until the 48-h cut-off and then cancel? Today it auto-cancels 7 days out (`server/domain.js:80-81`) and the copy says so (`site/goahead-promise.html:94`).
7. **D7 "Start your own date".** Remove it entirely, or keep it as "ask us to add a date" feeding the calendar? It is a large feature with emails and copy (01 §4.1).
8. **D8 Cancellation tiers.** Today they are fractions of the deposit ("the most you can lose is your deposit"). With a full charge, what are the published tiers as a percentage of price, per product type, and for cruises?
9. **D9 Organisations and roles.**
   - Confirm one company can be both an agency and an operator, with separate records and separate logins.
   - Is CTS itself an operator on the roster?
   - Today CTS is the default operator for all direct bookings (`server/brand.js:174`).
10. **D10 Catalogue list.**
    - Merge #14 into #15?
    - Keep or drop #2 and #3, which compete with #1?
    - #3 and #7 are not in the repo yet.
    - #13 title fix: "Ramesses".
11. **D11 Roster granularity.** A weekday roster fits daily and weekly day tours. Cruises follow ship sailing days, and multi-day tours run fortnightly. Are those rostered by date instead? Who runs a GoAhead departure when no one is rostered?
12. **D12 Agency billing terms.** Invoice at GoAhead or at cut-off? Payment terms, credit limit, what happens if the agency doesn't pay. Is commission netted on the invoice (the target says yes: "published price less its commission"), and so excluded from the monthly statement?
13. **D13 Commission share of late-cancellation fees.** What percentage? Does it apply to no-shows?
14. **D14 Operator advance.** Paid at assignment or at acknowledgement? Is 50% fixed or per product? Is the advance recovered if the operator then cancels?
15. **D15 Solo travellers.** What are the pairing rules (gender, age, opt-in)? When is pairing fixed (at cut-off)? Is triple occupancy still offered? Is the "cost of single promise" budgeted per departure or absorbed?
16. **D16 Legacy bookings.** Confirm legacy bookings keep link payment and their captured prices, even when a flat price differs on the same departure. Offer legacy travellers an optional card save?
17. **D17 Safety data.** Is it collected per traveller at booking, or completed later? Does the operator see it before cut-off? What is the retention on Sawa's side (the target sets 90 days for operators only)?
18. **D18 Controls on money.** Is maker/checker required for operator advances, balances and agency statements, now that ops_staff can do everything alone (01 §3)?
19. **D19 Cut-off values.** Is 48 h right for every day tour, including the long ones (Minya, Abu Simbel)? What is the per-cruise cut-off?
