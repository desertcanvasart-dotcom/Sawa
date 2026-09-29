# 02 · Gap analysis: current build against the target model

> **Maximum group is 8 since 29 Sep 2026** (`docs/model-audit/03-migration-plan.md` §4b). Where this document says 12, or the bands 4–6 / 7–9 / 10–12, read 8 and 4–8.


> **Superseded on the seller (27 Sep 2026).** The operator assigned at GoAhead is the seller of each departure; **Online Era** (Commercial Registration 148500), licensed to collect payments as an agent, is its commercial and payment-collection agent and holds the merchant account. **Capital Travel Service is not involved in Sawa.** Where this document says CTS is the seller of record, the merchant or the invoicing party, read the operator as seller and Online Era as collecting agent. See `docs/legal/terms-catalogue-draft.md` (v2) and `docs/phase4/REPORT.md`.

Each area has one table. File references point to the as-built evidence in [`01-current-state.md`](01-current-state.md).

§1–24 follow the brief. §25 adds the requirements that come from the *Operator Supply & Agency Reseller Agreements* draft (26 Sep 2026), cited as OSA / ARA clause numbers.

**Gap:** none / modify / new / remove.
**Effort:** S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks, for one engineer who knows this codebase.
**Risk:** the chance of breaking live bookings or money flows, or of shipping a false public claim.

---

## 1. Catalogue and product specifications

| Target capability | Current state (with file refs) | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Fixed catalogue owned by Sawa (21 products) | `tour_products` holds Sawa products *and* agency-submitted listings (`schema_013`; `server/app.js:1018-1039`). Prod has ~16–20 products (01 §7); #3 and #7 not found | modify | S | L | Add missing products; remove the agency submission path (§R). The draft advises launching with #1 as the daily Giza product, holding #2/#3 until #1 runs full, and merging #14 into #15, so about 18 products are active at launch. #7 (4×4 safari) needs a rate by vehicle, not by band |
| Four product types: day tour, one-way road tour, cruise, multi-day | `type` CHECK `day_tour`\|`package` (`schema.sql:34-60`). Cruises and multi-day are both `package`; one-way tours are `day_tour` | modify | M | M | `isPackage()` drives deposit, deadline, rooming, supplements and copy (`shared/booking-policy.js`, `server/domain.js`). Every branch needs a four-way decision |
| Itinerary, timings | `itinerary` JSONB, `duration`, `default_time`, `overview_html` (`schema.sql`, `schema_006`) | none | – | – | Keep |
| Vehicle class by group size | Single free-text `vehicle` (`schema.sql:34-60`) | new | S | L | Structured `[{band:'4-6', class:'...'}]` |
| Guide languages | Free-text `guide` only | new | S | L | |
| Meals | Only inside itinerary day `meals` text (fixture); no product field | modify | S | L | |
| Pickup area | `meeting_point`, `meeting_points`, `pickup_note` (`schema_006`, `schema_008`); `destinations.meeting_points` (`schema_009`) | modify | S | L | Add a structured pickup area (zone/hotels served) |
| Fixed inclusions / exclusions | `included` / `not_included` JSONB | none | – | – | Operator edits disappear once listing is removed |
| Listed paid add-ons | Not found | new | M | M | See §9 |
| GoAhead minimum (default 4) | `min_seats` CHECK ≥4, pinned =4 (`schema_022`, `schema_027`); `DEFAULT_GO_AHEAD=4` (`shared/group-size.js:24`) | none | – | – | 027 pins exactly 4. If any product should differ, drop the pin |
| Maximum group (default 12) | `max_seats` CHECK ≤12 (`schema_021`); `MAX_GROUP_SIZE=12` | none | – | – | |
| Cut-off (default 48 h; per product for cruises) | `booking_cutoff_hours` default **24** (`schema_006`; `server/domain.js:280-296`) | modify | S | M | Change the default to 48. Existing products keep 24 unless migrated; copy quotes the cut-off |
| GoAhead deadline (cruises and multi-day) | `confirm_deadline_days`, defaults 30 (package) / 7 (day tour) (`domain.js:80-81, 216-243`; `schema_019`). Not editable in UI (`app.js:929-937`) | modify | S | M | Mechanism exists. Make it per product in the editor. Decide what day tours do (decision D6 in 03) |
| Room / cabin categories | `accommodation_tiers` JSONB with per-person and **single** supplements (`domain.js:141-147`) | modify | M | M | Reframe as room/cabin categories with occupancy. Remove single supplement (§20) |
| Fixed published price per seat | Live price falling from `published_rate` to `break_price`, or `price_tiers` (`shared/pricing.js`); captured per booking at projected headcount (`domain.js:299-327`) | modify | M | **H** | Rate card has one "Retail price per seat". Switching to a flat price changes every quote, widget, email and "price drops" claim (01 §6b). Existing bookings keep their captured price |

## 2. Departure calendar

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Sawa creates departures from a calendar | **No generator.** Dates come from admin-with-first-traveller (`app.js:732-850`), traveller requests (`1846`), agency requests (`1878`). `operating_days` only restricts (`schema_015`). `set-package-dates.js` deletes and re-seeds by hand | new | M | M | Calendar rules per product (weekday pattern, sailing days, fortnightly), generator job, admin preview/publish. Must be idempotent and never delete a date with bookings |
| Empty departures are bookable | Admin route **refuses** a date without a first traveller (`app.js:734-753`) | modify | S | M | Reverses the 8 Aug decision "a date is created by its first booking". Public pages and SEO list dates, so empty dates become visible inventory |
| Cruise sailing days | Not found (`operating_days` weekday only) | new | S | L | Cruise calendar = ship's sailing dates, entered as explicit dates |
| "Start your own date" / date requests | Full flow: `createDateRequest` (`app.js:1710-1844`), approval (`1926-2011`), emails, lapse job, near-match | remove (or modify) | M | M | Decision D7. Removal touches the tour page, widget, agency portal, emails and a lot of copy |

## 3. Seat-based booking

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Traveller books a seat on product + date, not with an operator | Pledge is on a departure (`schema.sql:101-123`). But the tour page and emails name a changeable operator (`src/main.jsx:1845`; `server/email.js:495, 699`) | modify | S | M | Data model is already seat-on-date; the operator presentation is what must go |
| One booking per traveller identity | Anonymous; lead name + email; booking code is the credential (`app.js:304-321, 1294-1353`) | none | – | – | A traveller account isn't required by the target |
| Per-traveller names | `traveller_names` column never written (`schema_007`) | modify | S | L | Needed for manifest, rooming pairing and safety needs |
| Agency bookings get codes and confirmations | Agency pledges have no booking code and no customer email (`app.js:1185-1219`) | modify | S | M | Must respect agency client protection (§19): transactional email yes, marketing no |

## 4. Saved card and charge at GoAhead

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Save card with consent at booking; charge nothing | No card collected; no gateway (`server/payments.js:1-17`; `package.json`) | new | L | **H** | Needs a provider with tokenised saved cards and an off-session mandate (03 §3). Checkout must add a consent record |
| Charge every saved card at GoAhead | Manual Tab link per booking after GoAhead (`app.js:2977-3060`); ops alert dry by default | new | L | **H** | Idempotent charge job keyed on `departure.goahead`, with retries, failure handling (D5), receipts |
| Full price at GoAhead (vs deposit + balance) | Deposit 10% / 25% + balance at 2 / 14 days (`shared/booking-policy.js:53-86`); `payment-window.js`; balance links | modify / remove | M | H | Decision D2. If full charge, delete the deposit/balance machinery and its copy |
| Card for bookings that join after GoAhead | Not applicable today (links) | new | S | M | A seat bought on an already-GoAhead date is charged immediately |
| Failed charge handling | Not found (overdue only prompts "chase", `payments.js:133-164`) | new | M | H | Retry window, traveller update-card link, seat release rules |
| Refunds via provider API | Manual record with Tab reference (`app.js:3076-3088`) | new | M | M | Partial refunds for cancellation tiers |
| Legacy link-paid bookings | `booking_payments` (043) | modify | S | M | Keep for bookings made before switch-over (03 §1.4) |

## 5. GoAhead deadline for cruises and multi-day

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Cancel if not at GoAhead by deadline; nobody charged | `missedConfirmDeadline` + `cancel-unconfirmed` job (`domain.js:251-259`; `server/jobs/cancel-unconfirmed.js`), dry by default | modify | S | M | Logic exists and is correct for "nobody charged" (nothing is charged before GoAhead). Switch job live; per-product deadline editable; restrict to cruise/multi-day per D6 |

## 6. Guarantee after GoAhead

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Departure runs even if cancellations drop it below minimum | `minimum_reached` is sticky (`server/departure-status.js:20-28`; `shared/departure-state.js:68-95`); parity-tested | none | – | – | Already the as-built rule |
| No path un-confirms a guaranteed departure | Admin cancel works in any status (`app.js:3648-3704`); Terms §13.2 promises refill/refund if a payment fails (`site/terms.html:273`, not implemented) | modify | S | M | Admin cancel stays (force majeure) but should require a reason and trigger operator/traveller flows. Delete §13.2 |
| Request approval triggers GoAhead | Approval skips `refreshStatus` (`app.js:1942-1945`) | modify | S | M | Bug today; moot if requests are removed |
| One confirmation to travellers | Admin confirm route + notify job can double-send (`app.js:1147-1182`) | modify | S | L | `supplier_confirmed` becomes "operator acknowledged" (§11) |

## 7. Cut-off and manifest freeze

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Seats sell until cut-off | `bookingClosed` / `bookingClosesAtMs` (`domain.js:280-296`) | none | – | – | Default changes to 48 h (§1) |
| Manifest frozen at cut-off | Not found. Only the computed operator "freezes" at cut-off (`domain.js:568`) | new | M | M | Snapshot table of travellers, seats, safety needs, add-ons at cut-off; drives operator pay (§14) |
| Operator receives the manifest | Not found; operators see only a headcount (`app.js:3241, 3624`). Copy promises it (`site/operators.html:113`; `site/privacy.html:156`) | new | M | M | Operator portal view + email, access-limited (§22) |

## 8. Safety-needs capture

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Allergies, medical dietary needs, mobility collected at booking | Not found in any schema, route or form. Privacy page claims it (`site/privacy.html:118-122, 158`) | new | M | M | Special-category health data: explicit consent wording, access limited to the assigned operator, deletion. Per traveller, not per booking |
| No other special requests | Only date requests take a free-text note, stored in `departures.notes`, visible to every agency (`app.js:250-252, 1805-1807`) | modify | S | M | Drop the free-text note; stop exposing `notes` to agencies |

## 9. Listed paid add-ons

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Per-product catalogue of paid add-ons, bought at booking | Not found. Closest: settlement "optional tours" income lines entered after the tour (`schema_046`; `server/settlement.js:33-40`) | new | M | M | Add-on price, operator cost (rate card), inclusion on manifest and charge |

## 10. Roster and assignment

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Monthly roster operator × product × weekday, published in advance | Not found. Rate-card workbook has a "Roster" sheet template (Schedule 3) | new | M | M | Roster periods, entries, publish state, admin grid UI |
| Swaps need approval | Not found | new | S | L | Swap request → admin approve → entry change, audited |
| Departure assigned to rostered operator at GoAhead | Operator computed per read from passenger counts (`server/domain.js:520-597`); `DIRECT_BOOKINGS_OPERATOR` = CTS (`server/brand.js:170-174`); GoAhead alert uses listing agency (`alert-goahead.js:31-34`) | **remove + new** | M | H | Replace `operatorForDeparture` everywhere it's read (bootstrap, emails, settlement gating, tour page) with a stored assignment |
| Operator is a distinct role from agency | One `agencies` table and one portal for both (`schema_025`, `schema_029/036`; `src/AgencyDashboard.jsx`) | new | L | H | New operator entity + operator portal; an org can hold both roles (D9) |

## 11. Operator acknowledgement

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Operator acknowledges an assignment within 12 h | Not found. `supplier_confirmed` is set by Sawa staff (`app.js:1147-1182`) | new | M | M | Assignment email/portal link, acknowledge action, 12-h timer job, escalation to ops, strike on miss (§15) |

## 12. Rate card, with versioning and effective dates

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Day / one-way: departure fee by band (4–6, 7–9, 10–12) + per-traveller amount | Not found. `base_cost` unused; costs entered after the fact (`departure_costs`) | new | M | M | |
| Cruise / multi-day: land per traveller + per-room/cabin by occupancy + departure fee by band | Not found | new | M | M | Rooms by occupancy needs a rooming list per departure (§20) |
| Rate changes never affect departures with seats sold | Not found; admin repricing rewrites every departure (`app.js:1105-1144`) for *retail* price | new | S | H | Stamp `rate_card_version_id` on the departure when its first seat sells |
| Import from `sawa-rate-card.xlsx` | Workbook has structure but only EXAMPLE rows filled; USD | new | S | L | One-off importer; currency decision D1 |

## 13. Operator settlement (advance + balance + statement)

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Advance (e.g. 50%) after assignment | Not found | new | M | M | Needs payout bank details (none stored: `schema_025…:35-41`) |
| Balance within 7 days after tour, from manifest at cut-off | Profit-share payout runs every Wednesday (`server/settlement.js`; `app.js:3508-3597`) | **remove + new** | L | H | Profit-share and cost sheets are replaced by rate-card arithmetic. Existing payout runs/transfers must stay readable |
| Settlement statement | Not found (AgencyMoney screen shows profit share, `src/AgencyMoney.jsx`) | new | M | L | PDF/HTML statement per departure per operator |

## 14. Late cancellation and no-show rules for operator pay

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Late cancellers and no-shows still count for per-traveller amount | Not found. Settlement counts only paid, non-cancelled passengers (`settlement.js:111-118`) | new | S | M | Count from the cut-off manifest, not from current status. Record no-shows (new attendance field) |
| Departure-fee band from manifest count | Not found | new | S | L | |

## 15. Operator penalties, strikes and quality score

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Ratings | No reviews table (`schema_025…:104-107`). `quality` 4.7 default still renders as stars in embed (`src/main.jsx:2757`) | new + remove | M | M | Post-tour rating collection; remove the fake `quality` star now |
| Strikes (missed ack, unapproved substitution, shopping stop, service failure) | Not found | new | M | L | Strike records with evidence, appeal note |
| Penalties for operator cancellation / no-show | Not found (settlement adjustments are manual money moves, `schema_044`) | new | S | L | Penalty = negative settlement line |
| Removal from roster after repeated strikes | Not found | new | S | L | Rule + admin action |

## 16. Agency commission per seat per product

> **Superseded by phase 5 (28 Sep 2026, `docs/phase5/REPORT.md`).** There is no per-seat commission: agencies are paid a share of each departure's pool (shared/pool-model.js).

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Fixed amount per seat, set per product | `referrals.commission_percent` (report only, `app.js:2040-2064`); agencies actually paid by headcount profit share (`settlement.js:105-148`) | **remove + new** | M | M | Commission table per product, versioned like the rate card |
| Earned when the traveller travels | Not found | new | S | M | Accrue on completion from the manifest |
| Partial commission on late-cancellation fees Sawa keeps | Not found; no fee is ever computed (`shared/booking-policy.js:98-99`) | new | S | M | Depends on computing the fee (§4 refunds) |
| Attribution (agency account or widget) | Works: `agency_id` or `ref_code` → `passengerOwner` (`domain.js:553-561`; `src/main.jsx:2586-2625`) | none | – | – | Keep; ref code only after cookie consent — widget iframe path passes it directly |

## 17. Agency billing option

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Approved agencies pay published price less commission | Not found; agencies book at retail and the customer pays (`app.js:1197-1211`, payment links to customer) | new | M | M | Approval flag per agency, net invoice at GoAhead, credit terms (D12) |

## 18. Agency payouts and statements

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Monthly commission payment with statement | Wednesday payout runs of profit share (`app.js:3508-3597`; `src/AgencyMoney.jsx`) | modify | M | M | Re-use the run/transfer/bank-reference skeleton (`payout_runs`, `payout_transfers`) but monthly, from commission lines. Netting against agency-billing invoices |

## 19. Agency client protection

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Sawa doesn't market to agency travellers | No marketing sends exist; `route_alerts` unused (`schema_026`); consent columns unwritten (`schema_023`) | modify | S | L | Add a durable "agency client" flag on the traveller record that marketing queries must exclude; test it. Transactional mail (charge receipts, safety) still goes |
| Other agencies can't see an agency's clients | Redaction in `viewPledges` (`app.js:220-246`), but `departures.notes` leaks request notes (`250-252`) | modify | S | M | |

## 20. No single supplement (multi-day and cruises)

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Solo travellers pay no supplement | Single rooming adds `singleSupplement` (`server/domain.js:145`; UI `src/main.jsx:2007-2009, 3084`; `src/AgencyDashboard.jsx:668, 838`), while copy says "no solo surcharge" (`site/index.html:668`; `site/about.html:89`) | remove | S | M | Already a live contradiction |
| Pair solo travellers, or Sawa absorbs cost | Not found | new | M | M | Rooming list per departure (pairing by stated gender/preference?), operator paid per room by occupancy (§12); rate card shows "Cost of single promise" |

## 21. Seller-of-record changes

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| ~~CTS (ETAA 2179) sells every seat~~ superseded: the assigned operator sells, Online Era collects as agent | Platform presented as "Online Era, trading as Sawa Tours" (`site/_partials/footer.html:45`; `site/terms.html:101`; `server/email.js:447`; `server/brand.js:44-54`). **A test forbids** "ETAA 2179" and "Capital Travel Service, trading as" in public files (`server/entity-disclosure.test.js:148-165`) | modify | M | **H** (legal) | Change brand constants, test, footer, Terms, Privacy, JSON-LD `seller` (`server/seo.js:261-283`) together. Needs counsel's wording (D3) |
| Merchant account in Online Era's name, as collecting agent (was: CTS) | Not recorded in code; DIR-18 "Sawa's own merchant account" vs DIR-22 "on the operator's behalf" (`docs/audit/open-directives.md`) | new | M | H | Provider account opened by CTS; config per environment |
| Receipts by Online Era on behalf of the operator (was: in CTS's name) | No invoices; receipts name no entity (`server/email.js:768-787`) | new | M | M | Sequential invoice numbering, tax treatment (D3) |
| CTS as operator record | `DIRECT_BOOKINGS_OPERATOR="Capital Travel Service"` (`server/brand.js:174`) | remove | S | M | CTS stops being "the operator for direct bookings"; if CTS also runs tours it gets an operator role like anyone else |

## 22. Data retention and access limits for operators

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Operators see traveller data only for their assigned departures | Operators see only their own-agency pledges (`app.js:220-246`); no manifest at all | new | S | M | Scope by assignment, not by who booked |
| Operators delete within 90 days | No retention or purge code anywhere (01 §3, §8) | new | M | M | Platform side: expire operator access and purge manifest snapshots 90 days after the tour; contractual side for their own copies. Privacy page promises more retention rules with no code (`site/privacy.html:210-218`) |

## 23. Admin tools

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Catalogue editor with full spec | `ProductEditor` (`src/AdminDashboard.jsx:660+`) | modify | M | L | New spec fields; drop agency mode |
| Calendar generation & preview | Not found | new | M | M | |
| Roster grid, swaps, publish | Not found | new | M | L | |
| Rate card and commission editor (versions) | Not found | new | M | L | |
| GoAhead / charge monitor, failed charges | Payments queue for manual links (`src/AdminPayments.jsx`) | modify | M | M | |
| Assignment & acknowledgement board | Departures screen (`AdminDashboard.jsx:1700-1810`) | modify | M | L | |
| Operator settlement & statements | Settlements screen (profit share, `src/AdminSettlements.jsx`) | **remove + new** | M | M | |
| Agency commission statements | Payout runs (`AdminSettlements.jsx:452-499`) | modify | S | L | |
| Operator quality (strikes, ratings) | Not found | new | S | L | |
| Operator applications inbox | Table written, never read (`schema_017`; `app.js:1456-1475`) | new | S | L | |
| Maker/checker on money | None: ops_staff can approve and pay a run alone | new | S | M | Recommended now that cards are charged automatically |

## 24. Public copy that must change

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Operator recruitment pages describe supplier role | `site/operators.html`, `site/verify.html`, operator sections of `site/how-it-works.html`, `site/faq.html:91-98`, `site/about.html:90,144`, `site/index.html:779-780`, footer "List with Sawa" | modify | M | M | Near-total rewrite |
| Agency pages describe per-seat commission | `site/widget.html`, `src/AgencyMoney.jsx`, `src/AgencyDashboard.jsx` Promote/nav | modify | S | L | |
| Payment wording: card saved, charged at GoAhead | ~40 instances across `site/goahead-promise.html`, `site/how-it-works.html`, `site/faq.html`, `site/terms.html`, `shared/site-copy.js`, `src/main.jsx`, `server/email.js`, `server/seo.js` (01 §6d) | modify | M | **H** | Must ship *with* phase 2, not before or after |
| Seller of record in footer, Terms, Privacy, emails, JSON-LD | 01 §6a | modify | M | H | See §21 |
| "Price drops as the group grows" | 01 §6b pricing rows | modify | S | M | Ships with the flat price |
| "Start your own date" | 01 §6e | remove | S | L | Per D7 |
| Cancellation text rebased off "deposit" | `shared/booking-policy.js:100-152` feeds tour page, emails, Terms | modify | S | H | |
| SPA duplicates of legal pages | `src/main.jsx:3378-3553` (About, FAQ, Terms, Privacy, with a "review with your own counsel" draft banner) | remove | S | M | Route those paths to the static pages instead of keeping two copies |

## 25. Requirements added by the draft agreements

The *Operator Supply Agreement* (OSA) and *Agency Reseller Agreement* (ARA) draft of 26 Sep 2026 is more specific than the target brief. These rows cover what the areas above don't. Clause numbers refer to that draft.

| Target capability | Current state | Gap | Effort | Risk | Notes |
|---|---|---|---|---|---|
| Assignment notice **by platform and WhatsApp** (OSA 5.1) | No WhatsApp messaging; WhatsApp is only a contact link (`server/brand.js:32`). Twilio is used for one-time codes only (`server/phone-verify.js`) | new | M | M | A WhatsApp Business provider plus approved message templates. Email + portal can ship first |
| Reassign when acknowledgement is missed (OSA 5.2) | Not found | new | S | M | Part of §11: the 12-h expiry offers the date to the next rostered or approved operator |
| Travellers added after cut-off only with operator consent (OSA 5.4) | Not found; cut-off simply closes sales (`server/domain.js:280-296`) | new | S | L | Admin "add after cut-off" action that records the operator's consent |
| Manifest fields: names, **pickup point per traveller**, contact number, **nationality where tickets need it**, safety needs (OSA 7.1) | Only a lead name, email, phone and optional per-booking meeting point; no nationality; no per-traveller pickup (01 §4.2) | new | M | M | Nationality is personal data; collect it only for products whose tickets need it (a product flag) |
| Operator flags an unmeetable safety need within 24 h (OSA 7.2) | Not found | new | S | M | "Can't meet" action on the manifest → ops task → traveller contact |
| Rates fixed per season; new rates on 60 days' notice (OSA 8.2) | Not found | new | S | L | `effective_from` must be ≥ 60 days after proposal unless both sign off; each version signed off by both parties (Sched. 2) |
| Government fee change after sale: Sawa pays the difference (OSA 8.3) | Not found | new | S | L | A settlement adjustment line type "government fee difference" per seat |
| Advance within 2 business days of assignment; cruise and multi-day advances follow **supplier deadlines** in the spec (OSA 9.2, Sched. 1) | Not found | new | S | M | Product spec gains supplier-deadline entries; advance schedule per departure |
| Statement lists each traveller and amount; accepted unless disputed within 30 days (OSA 9.3, 19.1) | Not found | new | S | L | Statement state issued → accepted (auto, 30 days) or disputed |
| Set-off of penalties and deductions against pay (OSA 9.4, 12.2) | Settlement adjustments exist for a different purpose (`schema_044`) | modify | S | L | Negative lines on the operator settlement, capped per OSA 12.2 |
| Payment currency EGP or USD to a registered bank account (OSA 9.4) | EUR only (`shared/currency.js:34`); no bank fields (`schema_025…:35-41`) | new | S | M | D1 |
| **Band recalculated** when travellers cancel before cut-off; fixed at cut-off after (OSA 10.1-10.2, worked examples Sched. 4) | Not found | new | S | M | Use Schedule 4's three examples (520 / 520 / 390) as test fixtures |
| Operator cancellation penalty, plus replacement cost over the rate card (OSA 11.1-11.2, Sched. 6) | Not found | new | S | M | Replacement operator's settlement vs the original rate → difference charged to the original operator |
| 3 operator cancellations in 90 days → may remove from roster (OSA 11.3) | Not found | new | S | L | Rule and admin prompt |
| **Complaints:** investigation, operator evidence within 48 h, capped deduction, dispute (OSA 12; ARA 11.2) | Not found (no complaints table, route or screen) | new | M | M | Complaint record linked to departure and booking, evidence uploads (the private receipts bucket, `server/receipts.js`, can be reused), outcome, deduction |
| Operator sees its own ratings and quality score (OSA 13.1) | Not found | new | S | L | Operator portal view |
| Quality score = average rating + **on-time pickups** + strikes; 3 strikes in 90 days → fewer days, N → removal (OSA Sched. 3) | Not found; no pickup-time record | new | M | M | On-time pickup needs a signal: an operator "picked up" check-in, or a traveller rating question |
| Roster published by the 15th; operators state availability and may decline days before publication; 72-h swap notice; **every operator can see the whole roster** (OSA 4.1-4.4) | Not found | new | M | L | Availability collection step before publishing; a read-only roster view for all operators. CTS scored and allocated under the same rules |
| Force majeure: pay for services delivered and **evidenced non-refundable costs** (OSA 14.2) | The cost-line and receipt machinery exists (`departure_costs`, `server/receipts.js`; 044–046) | modify | S | L | **Keep and repurpose** the cost-sheet and receipt flow for force-majeure claims instead of retiring it (see §R) |
| Licence and insurance copies on signing and renewal; lapse → suspension from roster (OSA 15.3) | Verification fields on `agencies` (`schema_025`, `schema_035`); no document storage; no expiry check; verification gates nothing (01 §4.10) | modify | M | M | Document uploads per organisation, expiry job, automatic roster suspension |
| Operator non-solicitation for 12 months; penalty for off-platform rebooking (OSA 16.3, Sched. 6) | Not found | new | S | L | Contract-side mostly; platform records the penalty when evidenced |
| Traveller accepts Sawa's Traveller Terms at booking, **including agency-account bookings** (ARA 4.2) | Agency portal books without any customer consent or card (`server/app.js:1185-1219`) | new | M | **H** | Under standard payment an agency booking needs the traveller's own card and consent. Proposed: agency creates the booking → the traveller gets a link to accept the Terms and save a card. Agency-billing bookings skip the card (D20) |
| Agency collects and passes safety needs (ARA 4.4) | Not found | new | S | L | Same per-traveller fields as direct checkout, in the agency booking form |
| Agency may not sell below the published price; Option A (no agency fee) at launch (ARA 5) | Agencies book at the server-computed price (`server/app.js:1197`) | none | – | – | Option B later would need a separate fee line |
| Commission rate fixed at booking: "a change in Commission applies only to seats booked after the change" (ARA Sched. 1) | Not found | new | S | M | Stamp the commission rate on the booking, not the departure |
| Commission paid by the 10th of the following month; under agency billing the agency keeps it at payment (ARA 7.4) | Wednesday profit-share runs (`app.js:3508-3597`) | modify | S | L | Monthly run; billing agencies excluded from payout |
| No Sawa marketing to agency travellers **for 12 months** after their departure (ARA 8.2) | No marketing sends exist | new | S | L | A time-bounded "agency client until" date on the traveller, which marketing queries must respect |
| Operational messages go to agency travellers **and copy the agency** (ARA 11.1) | Sawa emails agency customers only for payment links, GoAhead and cancellation, never copying the agency; agency bookings get no confirmation (01 §4.9) | modify | S | M | CC the agency on transactional mail for its travellers |
| Guides introduce the tour as a Sawa departure; operator name shown to travellers only if decided (OSA 6.5; draft suggests "Sawa only at launch") | Operator name is shown on the tour page (`src/main.jsx:1834-1845`), in emails (`server/email.js:495, 699`), on `/partners` (`server/seo.js:718-736`) and in JSON-LD `provider` (`server/seo.js:261-283`) | modify / remove | S | M | If "Sawa only": hide operator names from traveller surfaces; keep the licence and safety claims about operators in general |
| Future option: Sawa as disclosed agent, **payment split by a licensed provider** (draft overview; lawyer Q4) | Not found | – | – | – | Not in scope now. Prefer a provider that can also do split payments, so a later switch doesn't need a new provider (03 §3) |

---

## R. What must be removed or retired

| Item | Where | Live data depends on it? |
|---|---|---|
| Agency/operator tour submission and approval | `POST /api/agency/tour-products` (`server/app.js:1018-1039`); approve/reject (`1067-1102`); `ProductEditor` agency mode (`src/AdminDashboard.jsx:660+`); "List a tour" (`src/AgencyDashboard.jsx:114, 238+`); listing emails (`server/email.js:663, 789-808`); `tour_products.status/submitted_*/reviewed_*/rejection_reason` (`schema_013`) | Probably not: prod notes record all products with `agency_id` NULL and 2 `listing.submit` events in July (`open-directives.md:647-681`). **Contains the takeover defect**; retiring the route also fixes it. Verify in prod before dropping columns |
| Operators setting prices, tiers, deposit %, cancellation text | Same editor fields (`AdminDashboard.jsx:939-951`); `upsertTourProduct` agency path; `policies_html` operator-authored; "operator's own schedule" clause (`shared/booking-policy.js:152`; `site/terms.html:248`) | No (all live prices entered by Sawa) |
| Live price that drops with group size | `livePriceFor` / `break_price` / `price_tiers` (`shared/pricing.js`; `server/domain.js:299-327`; `schema_020`); duplicate in `src/AgencyDashboard.jsx:37-46` | **Yes**: every existing pledge stores a price computed this way. Keep stored values; stop computing new ones |
| Operator = "partner with most confirmed travellers" | `operatorForDeparture` / `passengerOwner` in operator role (`server/domain.js:520-607`); `server/operator-lookup.js`; `DIRECT_BOOKINGS_OPERATOR` (`server/brand.js:174`); copy in `src/main.jsx:1845`, `server/email.js:495, 699` | Only as a computed value; nothing stored. Emails already sent quoted it |
| Pooling across operators / "join others' dates" framing | Copy (01 §6b), footer tagline; `NEAR_MATCH_WINDOW_DAYS` join-first (`app.js:414, 1763-1779`) | No stored dependence. Pooling of *travellers* on one departure stays; only the operator framing goes |
| Profit-share settlement (10% / 90% by headcount) and operator cost sheets | `server/settlement.js`; `departure_costs`, `settlement_adjustments`, `departure_settlements`, `payout_runs/lines/transfers` (044–046); `src/AdminSettlements.jsx`; `src/AgencyMoney.jsx` | **Possibly**: if 044–046 are applied in prod and any run was approved/paid. Keep tables read-only for history; don't drop. **Retire only the profit split, not the whole thing:** the cost-line and receipt flow is reused for force-majeure cost claims (OSA 14.2, §25) |
| Traveller and agency date requests | `createDateRequest` and routes (`app.js:1710-2011`); lapse branch of `cancel-unconfirmed.js`; request emails (`server/email.js:537-587`); `departures.created_by` traveler/agency (`schema_014`); `request_*` window columns (`schema_037`) | Possibly: any `pending_review` departures in prod must be resolved (approve into calendar or decline) before removal |
| Admin "date requires a first traveller" rule | `app.js:734-753` | No |
| Deposit / balance / payment-link machinery | `booking_payments` (043) routes and `src/AdminPayments.jsx`; `shared/payment-window.js`; `pledges.deposit_*`, `balance_*`; goahead-alert job; payment-link emails | **Yes** if any booking has a link sent or paid. Keep for legacy bookings until they have travelled (03 §1.4) |
| Single supplement | `server/domain.js:145`; booking UIs | Yes if any single-rooming package booking exists; honour stored totals |
| `quality` star rating | `src/main.jsx:2757`; `tour_products.quality` default 4.7 (`app.js:975`) | No |
| Referral `commission_percent` | `schema_011`; `app.js:2040-2110` | Report only |
| Unused 023 / 026 / 028 columns | per 01 §8 | No writers; drop or repurpose (023's `cancelled_reason` and consent fields are useful: repurpose) |
| Legacy SPA desk & scheduling code | `src/main.jsx:754-822, 4375-4441` | No |
| `set-package-dates.js`, seed scripts with 20% / min 6 / max 16 | `server/db/` | No (manual scripts); retire to avoid a destructive re-run |
