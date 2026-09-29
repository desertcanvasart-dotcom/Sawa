# Phase 6 report: groups of 8, numbered departures, one price, the operator fee

29 Sep 2026. Built to the decisions of 29 Sep 2026, recorded in `docs/model-audit/03-migration-plan.md` §4b. **Nothing here was run against production**: migrations 062 and 063 and every SQL in `docs/ops/live-groups-of-8.md` are applied by hand.

| Part | What | PR | State |
|---|---|---|---|
| LIVE | Maximum group 8 on the live site, price grid 4–8, "up to 8" copy, special-arrangement requests, list of live dates above 8 | [#246](https://github.com/desertcanvasart-dotcom/Sawa/pull/246) | own PR against `main`; merges on green CI |
| Catalogue | Numbered departures, one price, operator fee (per product and per departure), the maximum in the catalogue, the documents | the phase 6 catalogue PR | behind `catalogue_v2`; **not merged**, as asked |

## Where the brief and the code differ (please read)

1. **The 8% override example.** The brief expected entitlement **27,917.9** and pool **9,464.5** for 8 travelers at an 8% fee. The arithmetic is exact: operating cost 25,850 (transport 2,650 + guide 2,000 + 8 × 2,250 + 8 × 400), × 1.08 = **27,918.0**, so the pool is 41,536 − 27,918 − 4,153.6 = **9,464.4**. The tests assert 27,918 and 9,464.4. The other two examples match exactly: 4 travelers **2,678.7**; 8 travelers at 5% **10,239.9**. If the intended numbers came from a different rounding rule, tell me which.
2. **Unconfirmed reservations do not hold a seat today.** The brief says they hold a seat "only for their 24 h expiry". In the code an unconfirmed booking is a row in `booking_confirmations`, not in `pledges`: it counts toward nothing, and capacity is re-checked (and the departure re-chosen) when the traveler confirms. I kept that, because it cannot oversell and needs no new hold to expire. The 24-hour expiry is unchanged. If you want unconfirmed reservations to reserve seats, that is a separate change.
3. **"Open the next one only when every existing departure is full" vs. "a party of 3 when departure 1 has 6 goes whole to departure 2".** Both are built: a further departure opens when the last open one fills (so a new traveler always has one), **and** when a party fits in none of the existing ones (the party of 3 with 2 seats left).
4. **The roster is per product and day.** A second departure on the same day would silently have inherited the first's rostered operator. The roster now names the operator of **departure 1 only**; a further departure goes to agency selection (the agencies with travelers on it) or to an admin. Change it if a rostered operator should run both vehicles.
5. **Euro tier prices round up** (decided 29 Sep, earlier in the session; recorded in phase 5's header note). One price makes it "€X per person" with X = EGP price ÷ published rate, rounded up.
6. **Spelling.** The site and emails use US spelling ("travelers"), as the brief's wording "travellers" would break the repo's spelling check.

## Maximum group

**Values set for catalogue products:** every product goes to **8**, including the cruises and multi-day products. None had chosen a value: all sat at the old default of 12. The per-product override is kept: `catalogue_products.max_group` may be above 8 (up to 12) **only for a cruise or multi-day product** (a database CHECK and the admin field say so). A cruise that should hold more than 8 is set in Admin → Catalog → the product → Maximum group. `node scripts/phase6-report.js` prints every product's value after migration 063.

Catalogue-linked ordinary departures take the product's maximum; a date already holding more than that keeps every booking and becomes full.

### Every 12 → 8 change

Constants and logic: `shared/group-size.js` (`MAX_GROUP_SIZE` 12 → 8, so `capacityError`, `GROUP_MAX_WORD` and the sync scripts follow); `server/app.js` (`|| 12` defaults → the constant; waitlist seats `max(12)` → the constant); `server/seo.js` (two fallbacks); `server/autoura-sync.js`; `server/pay-at-goahead.js`; `src/AdminDashboard.jsx` (new-tour default, min/max seats inputs, price-grid bound); `src/AgencyDashboard.jsx`; `src/main.jsx` (the pooling request input); `src/PayAtGoAheadPublic.jsx`; `src/AdminCatalogue.jsx` (GoAhead minimum 1–8, maximum 1–8, or up to 12 for a cruise or multi-day product); `server/catalogue-routes.js` (GoAhead minimum ≤ 8); `server/catalogue.js` (the constraint message); `shared/pool-model.js` (`RATE_TABLE_TO` 12 → 8; default tier 4–8); `server/departure-merge.js` (a merge total may not exceed 8).

Site copy (`scripts/sync-constants.js` plus by hand where the script does not reach): `site/index.html` ("Never more than eight. Ever.", "4 / 8", "4 of 8 joined · 4 seats left", twice), `site/how-it-works.html` ("8 travelers maximum", "4 of 8 joined", "a group of 4–8", "never more than eight", "four to eight"), `site/goahead-promise.html`, `site/operators.html` ("8 seats maximum", twice), `site/goahead.html` (fallback), `site/assets/rules.js` (generated). The SPA and server-rendered pages render from the constant ("Never more than eight", "4–8 travelers").

Documents: `docs/legal/terms-catalogue-draft.md` (v4: C3a, C3b, C4a, C8 and questions 27–29), `docs/model-audit/03-migration-plan.md` (§4b and the schema sketch), `docs/launch/catalogue-v2-runbook.md`, `docs/launch/rehearsal.md` (the rehearsal now fills 8 seats), and notes on `docs/phase2`, `docs/phase4`, `docs/phase5`, `docs/model-audit/01` and `02`.

Not changed, on purpose: the "10–12" band columns (`fee10_12`, `vehicleByBand["10-12"]`) in the operator rate import and the vehicle facts. They are data and column names, unreachable with a maximum of 8, and removing them is a separate migration. Hours (12-hour windows), months, "section 12" and the like are unrelated.

## Numbered departures (catalogue_v2)

- **Migration 063** adds `catalogue_departures.departure_no` (1 by default) and replaces `UNIQUE (product, date)` with `UNIQUE (product, date, departure_no)`. The generator makes number 1 only (`ON CONFLICT (product, date, departure_no)`); adoption of existing dates targets number 1. The uncontrolled-duplicate guard is unchanged for the ordinary flow (`departures`: one date per tour and day by the admin and date-request routes).
- **Routing** (`server/catalogue-departures.js`, rules in `shared/departure-numbers.js`): a booking (public and agency) goes to the lowest-numbered departure with room for the whole party; if none has, the next number is opened. The date is locked (an advisory lock) before any is read, so two bookings at once cannot both take the last seats or both open departure 2. After a booking, if every departure of the date is full, the next opens. A daily sweep (`openNextForFullDates`) opens the next for a date that was already full.
- **Full = 8 seats reserved** (booked plus seats held for a waitlist offer).
- **"Join my group":** the party stays where it is if the joiners fit; otherwise the **whole party and the joiner move together** to the lowest departure with room for all of them (opened if needed). A party moves only while none of its bookings has a payment request or payment; after that a joiner who does not fit is refused there and the party is never split. A party that would exceed 8 cannot grow.
- **Independent departures:** GoAhead, operator offer and acknowledgement, payment requests, releases, cut-off, manifest, pool and statements are all keyed on the departure id, so each numbered departure has its own. Departure 2 below 4 at its cut-off is canceled like any other while departure 1 runs.
- **Public list:** a date is shown once, with the status of the departure a new booking would join. A full departure is never shown as bookable.
- **Merge tool:** refuses a merge whose total exceeds 8 (a catalogue date's own maximum applies to a catalogue date). Merging two **numbered catalogue** departures is still refused (it only merges an ordinary duplicate into a catalogue date); that would be new code.
- **Admin:** the calendar shows "Departure N" and an "Open another departure" button (`POST /api/admin/catalogue/departures/:id/open-another`, audited).
- **A waitlist** is for a full departure. Because a new departure opens when one is full, a walk-in now lands on it instead of being refused, so the waitlist is for those who prefer the first departure's seats.

## One price and the operator fee

- **Default:** one tier, 4–8, with a single EGP price, cost lines "per group" (per departure) and per traveler, and Online Era's 10%. The editor shows "Add a tier (optional)". Tier support stays in the code.
- **Operator fee:** required per product (per tier if tiers), **no default** (the old 5/6/10% defaults are gone); a version cannot be published while it is empty. The rate card table runs 2–8 travelers.
- **Migration 063, rate versions:** every product whose latest version has several tiers gets a **new draft** with one tier 4–8 from the first tier's price, cost amounts and operator fee (a draft that still has several tiers is reduced in place; a draft already at one tier is left). **Nothing is published.** `node scripts/phase6-report.js` prints each product for your review, with the fee "NOT SET" where the first tier's fee was blank. It could not be run here (no production database).
- **Per-departure override:** Admin → Calendar → the departure → "Operator fee for this departure": a percentage and a reason, logged with who and when (`catalogue_departures.operator_fee_pct_override`, and the audit log). Editable until the operator acknowledges that departure's offer, then locked (409). It changes that departure's entitlement and pool only. The operator's offer (portal) shows the % that applies, marked when set for the departure. The operator statement, the agency statements and the margin report show the % used and "override".
- **Tour pages and widget:** "€X per person". The "from 7 / from 10" lines and the refund promise appear only for a product that still has several tiers. **Until you publish the new drafts, a product whose published version still has three tiers keeps showing its tiers.**
- **Tier-drop refund:** returns early for one tier (a departure is locked to one version, so nobody pays a dearer tier); the code and its tests stay.

## Groups of more than 8 (LIVE and catalogue)

The booking form (tour page and widget) stops at more than 8 and shows "Groups of more than 8: request a special arrangement": name, email, group size, date, tour. It creates a lead in **Admin → Group requests** (and emails the operations inbox); no booking is made and no seat is held.

## Tests

`server/phase6.integration.test.js` (real Postgres): departure calendar makes number 1 only; a 9th traveler opens departure 2 and it needs its own 4; a party of 3 when departure 1 has 6 goes whole to departure 2; departure 2 below 4 at cut-off is canceled while 1 runs; each departure has its own operator offer and settlement; the public list shows a date once; a "Join my group" party moves whole; a party over 8 is not booked; merging above 8 is refused; an empty operator fee can't be published; an override moves one departure only, is refused after acknowledgement, and the statements show the % used; migration 063 makes a new draft from the first tier. `server/departure-numbers.test.js`, `server/single-price.test.js` (the three worked examples, the fee override), `server/groups-of-eight.test.js` and `.integration.test.js` (LIVE), plus the existing tests updated for 8 (`constants`, `domain`, `booking-flow`, `booking-parties`, `catalogue`, `pay-at-goahead`, `payments`, `pool-model`).

## Not done

- Live production data was not queried: the list of live dates above 8 and the per-product rate report come from the SQL and scripts in `docs/ops/live-groups-of-8.md` and `scripts/phase6-report.js`, which you run.
- Merging two numbered catalogue departures, moving a party whose bookings already have a payment request, and an unconfirmed reservation that holds a seat (see above) are not built.
- The operator offer **email** does not show the fee % (the portal and the admin panel do): a fee an admin may still change before acknowledgement would go stale in an email.
