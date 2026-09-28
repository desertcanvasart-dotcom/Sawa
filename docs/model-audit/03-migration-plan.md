# 03 · Proposed migration plan

> **Superseded on the seller (27 Sep 2026).** The operator assigned at GoAhead is the seller of each departure; **Online Era** (Commercial Registration 148500), licensed to collect payments as an agent, is its commercial and payment-collection agent and holds the merchant account. **Capital Travel Service is not involved in Sawa.** Where this document says CTS is the seller of record, the merchant or the invoicing party, read the operator as seller and Online Era as collecting agent. See `docs/legal/terms-catalogue-draft.md` (v2) and `docs/phase4/REPORT.md`.

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

invoices                       (seller = the assigned operator; receipts by Online Era as collecting agent, decided 27 Sep 2026)
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

── Added for the draft agreements (OSA / ARA, 26 Sep 2026) ─────────────
products              + supplier_deadlines jsonb [{what, days_before, advance_pct}]  (OSA 9.2, Sched. 1)
                      + needs_nationality bool (tickets need it, OSA 7.1)
                      + launch_state active | later | merged  (catalogue advice: #2/#3 later, #14→#15)
booking_travellers    + pickup_point, nationality (only when the product needs it), contact_phone
pledges               + terms_accepted_at, terms_version   (ARA 4.2: agency bookings too)
                      + commission_rate_id               (stamped at booking, ARA Sched. 1)
                      + agency_client_until date          (departure end + 12 months, ARA 8.2)
roster_availability   operator_id, month, product_id, weekday, available bool   (OSA 4.1-4.2)
departure_assignments + reassigned_from_id, notified_whatsapp_at
manifest_amendments   departure_id, after_cutoff bool, operator_consent_at, by   (OSA 5.4)
manifest_flags        manifest_id, traveller_id, need, operator_note, raised_at, resolved_at  (OSA 7.2)
rate_card_versions    + proposed_at, signed_off_by_operator_at, signed_off_by_sawa_at     (OSA 8.2, Sched. 2)
settlement_lines      operator_settlement_id, kind per_traveller | departure_fee | room |
                      government_fee_difference | penalty | service_failure_deduction |
                      replacement_cost | force_majeure_cost, amount_minor, note
operator_settlements  + statement_state issued | accepted | disputed, disputed_at, accept_by (issued + 30 days)
complaints            id, departure_id, pledge_id, raised_by (traveller | agency | ops), body,
                      evidence_requested_at, evidence_due_at (+48 h), outcome, refund_minor, deduction_minor
complaint_evidence    complaint_id, party, file_path (private bucket), note
organisation_documents organisation_id, kind tourism_licence | etaa | liability_insurance | vehicle_insurance,
                      file_path, expires_on, received_at   → expiry job suspends from the roster (OSA 15.3)
pickup_checkins       departure_id, operator_id, scheduled_at, picked_up_at   (on-time pickups, OSA Sched. 3)
notifications         channel email | whatsapp | portal, recipient_kind, template, cc_agency_id, sent_at

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
| `departure_costs`, adjustments, payout runs/lines/transfers | legacy (read-only), except cost lines and receipts | Kept for history. If 044–046 are in prod with approved runs, **no deletion**. The cost-line and receipt flow is reused for force-majeure claims (OSA 14.2); the payout run and transfer pattern is reused for monthly agency commission |
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
  - Choose the payment provider and open the merchant account in Online Era's name, as collecting agent (§3); this has lead time.
  - Get counsel's Terms and Privacy wording for the operator as seller and Online Era as collecting agent (`docs/legal/terms-catalogue-draft.md`).
  - Get the Egyptian lawyer's answers to the draft's questions. **Question 3 gates phase 3:** can Online Era, as collecting agent, save a card at booking and charge it later, under Central Bank rules and Consumer Protection Law 181/2018? Question 5 (PDPL 151/2020 roles) shapes the data schedules and the 90-day deletion.
  - Fill the rate card and commission amounts, plus the other `[●]` values in the agreements (penalties, insurance minimum, payment currency, dispute route).
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
  - Receipts issued by Online Era on behalf of the operator (built); invoices per the lawyer's answer.
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
  - the entity-disclosure test keeps asserting Online Era, never CTS (CTS is not involved);
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

> **Superseded by phase 5 (28 Sep 2026, `docs/phase5/REPORT.md`).** Phase 5 became the final pricing and money model: tiered EGP prices, cost lines, operator fee, the collecting agent's commission and the pool shared per traveler; the operator is an agency on the departure, the roster the fallback. The commission rows below (per-product rates, per-seat accrual, billing at price less commission) are replaced.
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

### What the draft agreements add to each phase

The agreements (26 Sep 2026) don't change the order. They add scope, listed here rather than folded in, so you can see what came from the contract.

- **Phase 1:**
  - Launch catalogue per the draft's advice: #1 daily Giza; #2 and #3 held as `later`; #14 merged into #15; niche products on one or two fixed weekdays.
  - Supplier deadlines and `needs_nationality` in the product spec.
  - Worked examples as fixtures.
- **Phase 2:**
  - Availability collection before the roster is published on the 15th.
  - Every operator can see the whole roster.
  - 72-hour swap notice.
  - Reassign on a missed acknowledgement.
  - Assignment notice by WhatsApp as well as the portal. This needs a WhatsApp Business provider and approved templates. **If that isn't ready, ship email and portal first**; WhatsApp is in the contract, not a precondition for assignment.
  - CTS rostered and scored under the same rules as other operators.
- **Phase 3:**
  - **Gated on lawyer question 3.**
  - Terms acceptance and a saved card for agency-account bookings: the agency creates the booking, then the traveller completes it through a link (D20).
  - Per-traveller pickup point, contact number, nationality where needed, and safety needs from both direct and agency checkouts.
  - Operator name hidden from traveller surfaces if "Sawa only" is chosen (OSA 6.5).
- **Phase 4:**
  - Advance within 2 business days, or on supplier deadlines for cruises and multi-day.
  - Band recalculated for cancellations before cut-off.
  - Government-fee difference lines.
  - Statement accepted after 30 days unless disputed.
  - Set-off of penalties.
  - Force-majeure cost claims using the existing cost-line and receipt flow.
  - Rate-card sign-off by both parties, with 60 days' notice.
  - Schedule 4's examples (8 at cut-off → 520 with a 260/260 split; 2 late cancellations → 520; 2 early cancellations → 390) as unit tests.
  - Post-cut-off additions with operator consent.
  - The operator's "can't meet this need" flag within 24 h.
- **Phase 5:**
  - Commission rate stamped on each booking.
  - Monthly statement and payout by the 10th.
  - Billing agencies keep commission at payment.
  - Commission share of retained late-cancellation fees (draft suggests 50%).
  - Agency copied on operational messages.
  - Marketing exclusion for 12 months after departure.
  - Option A pricing only.
  - ARA Schedule 3 example (3 × 95; commission 12 → payout 36, or 249 billed) as a test.
- **Phase 6:**
  - Complaints with operator evidence due in 48 h, capped deductions and disputes.
  - On-time pickup check-ins feeding the quality score.
  - Document uploads with expiry and automatic roster suspension.
  - Penalties including replacement cost over the rate card.
  - 3 cancellations in 90 days, or N strikes → roster reduction or removal.
  - Quality-weighted allocation after 3 months (OSA Sched. 3).

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
| Merchant account in Online Era's name, as collecting agent; settlement currency (EUR vs USD, D1); Egyptian entity eligibility | Seller of record | **Not recorded in code** (DIR-18 vs DIR-22) |
| Statements / payout reports (per charge, fees, net) for reconciliation | Settlement, accounting | **Can't tell**; the rate card assumes a 3% placeholder fee |
| Disputes / chargebacks API | Operations | **Can't tell** |
| Split payments to several payees (marketplace/connect style) | Only if counsel later approves Sawa as a disclosed agent with the provider splitting each payment (draft overview; lawyer Q4). Not needed for launch | **Can't tell**. Worth asking now, so the provider doesn't have to change later |
| Legality of saving a card and charging it later, for an Egyptian merchant | The whole GoAhead charge (lawyer Q3: Central Bank rules, Law 181/2018) | Not a provider feature; a legal answer. Gates phase 3 |
| Invoices | Seller-of-record receipts | Can be generated by Sawa; doesn't depend on the provider |
| Payouts to operators and agencies | Advance, balance, commission | Today by bank transfer, recorded by hand. Keep as manual bank transfers unless the provider offers compliant payouts to Egyptian banks: **can't tell** |

---

## 4. Decisions (recorded 27 Sep 2026)

As supplied. **SETTLED** lines are decided. **CONFIRM** lines are your recommendations, still awaiting final confirmation; phase 1 builds on them where it needs to.

```
SETTLED   Charge at GoAhead = full published price
SETTLED   An agency that also operates signs a separate operator agreement; Capital Travel is rostered and scored like everyone else
SETTLED   Launch catalogue: #1 daily Giza; #2 and #3 held; #14 merged into #15 (about 18 active)
SETTLED   Operator advance: 50% within 2 business days of assignment
SETTLED   Cut-off: 48 hours for day tours
CONFIRM   Payment step runs in one of two modes, set by config: A = save card, charge at GoAhead; B = charge at booking, automatic full refund if no GoAhead
CONFIRM   Card declined at GoAhead: 24 hours to fix, then the seat is released; the departure stays guaranteed and Sawa absorbs any shortfall
CONFIRM   Standard agency seats count toward GoAhead only once the traveller completes the link; the hold expires after 48 h. Agency-billed seats count at booking.
CONFIRM   Traveller currency EUR; rate card and operator payouts in EGP
CONFIRM   Solo travellers on cruise/multi-day: Sawa pays the single supplement at launch
CONFIRM   Day tour below minimum at cut-off: cancelled automatically, no charge, next date or alternative offered. Admin may override and run it (operator paid at the 4–6 band)
CONFIRM   Operator names hidden from travellers at launch
```

How these map onto the open questions below:

| Decision | Resolves |
|---|---|
| Full published price at GoAhead | D2 |
| Separate operator agreement; CTS rostered like everyone else | D9 |
| Launch catalogue | D10 |
| 50% advance within 2 business days | D14 |
| 48 h cut-off for day tours | D19 (day tours; cruise cut-offs stay per product) |
| Payment modes A/B by config | D4 in part: mode B (charge at booking, refund if no GoAhead) doesn't need off-session charges. **New:** mode B changes the "you pay nothing until the GoAhead" promise, so copy must follow the mode |
| 24 h to fix a declined card; seat released; guarantee kept | D5 |
| Agency seats count once the link is completed; 48-h hold; billed seats count at booking | D20 |
| EUR for travellers; EGP for rate card and payouts | D1 |
| Sawa pays the single supplement at launch | D15 |
| Day tour below minimum at cut-off: cancelled, next date offered; admin override runs it at the 4–6 band | D6 |
| Operator names hidden at launch | D21 |

Still open: D3, D7, D8, D11, D12, D13, D16, D17, D18, D22, D23.

### Phase 2 decisions (recorded 27 Sep 2026)

As supplied, all CONFIRM (recommended, awaiting final confirmation). Phase 2 builds on them.

```
CONFIRM   Cruise and multi-day GoAhead deadline: 30 days (matches current site copy); per-product override allowed
CONFIRM   Site-wide spelling: US English   (change to British if preferred; applies to all new and phase-1 copy)
CONFIRM   Roster is published monthly by the 15th of the previous month
CONFIRM   Operator must acknowledge an assignment within 12 hours; a miss = one strike, and admin may reassign
CONFIRM   Strikes: 3 in 90 days = fewer roster days next month (admin decision, flagged in the UI); removal is manual
CONFIRM   Rate card in EGP; a rate version is locked to a departure when its first seat is sold
CONFIRM   Assignment notices by email and in the operator portal now; WhatsApp later
```

These replace the phase 1 placeholders: the 21-day deadline (now 30) and British English for new copy (now US). "Rate card in EGP" settles the operator side of D1; travellers still pay in EUR.

### Phase 3 decisions: settlements and commissions (recorded 27 Sep 2026)

As supplied, all CONFIRM. Phase 3 builds on them.

```
CONFIRM   Operator payouts use the EGP amounts of the locked rate version; no currency conversion in what operators are owed
CONFIRM   Agency commission is stored per seat in EUR (the traveller currency), locked at booking
CONFIRM   Agencies are paid commission in EUR; Egyptian agencies in EGP at the Central Bank of Egypt rate on the statement date (subject to the lawyer's answer on foreign-currency payments)
CONFIRM   Margin reporting converts EUR revenue at the CBE rate on the charge date, from a rate table admin maintains; realised FX differences are reconciled monthly
CONFIRM   Operator advance: 50% of the expected amount, due 2 Egyptian business days (Sun–Thu, excluding public holidays) after acknowledgement
CONFIRM   Operator balance: due 7 calendar days after the departure ends
CONFIRM   Settlement statement accepted automatically 30 days after it is sent unless disputed
CONFIRM   Commission on a late cancellation where Sawa keeps a fee: 50% of the seat's commission
CONFIRM   Commission statement: monthly, sent by the 10th for the previous month
CONFIRM   Service-failure deduction cap: the operator amount for that departure
CONFIRM   Penalty amounts (Operator Schedule 6): configurable, default 0 until set
CONFIRM   Catalog departures use the new settlement path; legacy departures keep the existing settlement tools until the last one completes
CONFIRM   New bookings under the flag require: every traveller's name, a phone number, a pickup point, and nationality where the product needs it. Safety needs are asked every time, with an explicit "none" option.
```

These settle the payouts questions phase 2's report left open: operators are owed EGP with no conversion, agency commission is EUR, and conversion appears only in margin reporting and in Egyptian agencies' commission statements.

## 4a. Decisions needed from you (as first written; superseded where §4 answers them)

"Draft" = what the *Operator Supply & Agency Reseller Agreements* draft (26 Sep 2026) already says or suggests. Where it settles a question, the item is marked **settled by draft**; confirm it and nothing else is needed. Everything else is still open.

| # | Decision | Why the code makes it matter | Draft | Status |
|---|---|---|---|---|
| D1 | **Currency:** what travellers pay in, what operators are paid in, and who carries the exchange risk | Site, Terms and payments are EUR (`shared/currency.js:34`; `site/terms.html:198`). The rate card is USD | OSA 9.4 "[EGP / USD]" to operators; rate card says USD | **Open** |
| D2 | **What is charged at GoAhead:** the full seat price, or a deposit and balance as today | Deposit 10%/25% plus balance at 2/14 days is built in (`shared/booking-policy.js:53-86`) | ARA example: "each client's card is charged 95 at GoAhead", i.e. the full published price | **Settled by draft:** full price. Confirm, then the deposit/balance machinery is retired for new bookings |
| D3 | **Seller-of-record mechanics:** Online Era's role; the name on the footer, invoices, card descriptor and privacy notice; tax on invoices | A test enforces "Online Era" and forbids "ETAA 2179" (`server/entity-disclosure.test.js:148-165`) | CTS sells and contracts "trading through the Sawa platform"; counsel may later allow Sawa as disclosed agent | **Open (legal):** needs counsel, then brand constants and that test change together |
| D4 | **Payment provider** (Tab or another) | Tab is used only through links made by hand; no API | — | **Open**, gated on lawyer Q3 |
| D5 | **Failed charge at GoAhead:** time to fix the card, seat release, and whether the departure stays guaranteed if failures take paid seats below 4 | Terms §13.2 promises refill/refund (`site/terms.html:273`) and conflicts with the guarantee | GoAhead = "four seats **sold**" (OSA 2); operator must run it after assignment (OSA 5.3) | **Partly settled:** GoAhead on seats sold, and the guarantee holds. Still open: the card-fix window and seat release |
| D6 | **Day and one-way tours without a GoAhead deadline:** stay open until the 48-h cut-off, then cancel? | Today they auto-cancel 7 days out (`server/domain.js:80-81`), and copy says so | Deadline only for cruises and multi-day (OSA 5.5); cut-off 48 h for day tours | **Open:** what happens at cut-off to a day tour below 4 |
| D7 | **"Start your own date":** remove, or keep as "ask us to add a date" | Large feature: routes, emails, jobs, copy (01 §4.1) | "Sawa owns the catalogue and the departure calendar" | **Open (leaning remove)** |
| D8 | **Cancellation tiers** as a percentage of price per product type, including cruises | Tiers are fractions of the deposit (`shared/booking-policy.js:100-152`) | Refunds and fees under the Traveller Terms (OSA 10.3); late-cancel commission implies a retained fee | **Open** |
| D9 | **Organisations:** one company holding both roles with separate records and logins; CTS on the roster | One `agencies` table for both today; CTS is default operator for direct bookings (`server/brand.js:174`) | Separate OSA for an agency that operates (ARA 1.2); CTS "scored and allocated under exactly the same rules" (OSA 4.4, Sched. 3) | **Settled by draft** |
| D10 | **Launch catalogue** | 16–20 products live; #3 and #7 missing | Launch with #1 as daily Giza; add #2/#3 when #1 runs full; merge #14 into #15; niche products on 1–2 weekdays; #13 title "Ramesses" | **Settled by draft** (confirm the #14/#15 wording) |
| D11 | **Roster granularity** for cruises (sailing days) and fortnightly multi-day; who runs a GoAhead date with no one rostered | Weekday roster is the brief's model | "Fixed at launch; quality-weighted after 3 months"; cruises and multi-day "follow ship sailing days" | **Open:** roster by date for cruises and multi-day, and the fallback |
| D12 | **Agency billing timing and credit** | Not found in code | "[within ● days of GoAhead / ● days before the Departure]" (ARA 6.2); approval for credit | **Open** |
| D13 | **Commission share of retained late-cancellation fees;** does it apply to no-shows? | No fee is ever computed today | Suggests "same share as the retained fee, e.g. 50%" (ARA 7.2) | **Open** (value) |
| D14 | **Operator advance** | Not found | 50% within 2 business days of assignment; cruises and multi-day follow supplier deadlines (OSA 9.2) | **Settled by draft** (values in brackets to confirm) |
| D15 | **No-single-supplement for cruises and multi-day** | A single supplement is charged today (`server/domain.js:145`) | "Either Sawa pairs solo travellers of the same sex, or Sawa pays the single supplement from its margin" | **Open (choose one).** Pairing means collecting sex/gender for solo travellers on those products, which is personal data, plus a pairing step at cut-off |
| D16 | **Legacy bookings** keep link payment and their captured prices | Live pledges since 12 Aug under "no card" terms | — | **Open** |
| D17 | **Safety data:** when it is collected, when the operator sees it, Sawa-side retention | Not collected today | At booking (ARA 4.4); on the manifest (OSA 7.1); operator deletes within 90 days (OSA 16.2); Schedule 5 is for the lawyer | **Partly settled:** Sawa's own retention is open, pending lawyer Q5 |
| D18 | **Maker/checker on money** | ops_staff can approve and pay alone (01 §3) | — | **Open** |
| D19 | **Cut-off values** | Default is 24 h today | 48 h for day tours; per product for cruises (OSA 2) | **Settled by draft** for day tours; cruise values open |
| D20 | **How an agency-account booking gets the traveller's consent and card** | Agency books with no consent or card (`server/app.js:1185-1219`) | Every agency traveller accepts the Traveller Terms (ARA 4.2) and pays through Sawa's checkout unless on agency billing (ARA 6) | **Open (design):** a completion link to the traveller is proposed. Unpaid, unconfirmed agency seats: do they count toward GoAhead? |
| D21 | **Show the operator's name to travellers?** | Shown on tour page, emails, `/partners`, JSON-LD | OSA 6.5 [●]; suggests "Sawa only at launch" | **Open (leaning Sawa only)** |
| D22 | **Penalty amounts, insurance minimum, dispute route, governing language** | — | All [●] in OSA 11, 15.2, 19, 22.6 and Sched. 6 | **Open** (contract values; the platform only needs the amounts) |
| D23 | **WhatsApp provider** for assignment notices | No WhatsApp messaging in code | Required by OSA 5.1 | **Open:** provider and number; email and portal can ship first |
