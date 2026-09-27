# Phase 1 report: catalogue and departure calendar

Branch `feat/catalogue-calendar`. Built to `docs/model-audit/03-migration-plan.md` and the decisions recorded in its §4 (27 Sep 2026). Where this phase's brief and the migration plan disagree, the brief was followed; the differences are listed under "Conflicts".

**Nothing here changes checkout, payment, charging, refunds or payouts.** With the `catalogue_v2` flag off (the default), the public site and booking behave as before; an integration test asserts it.

---

## What was built

### Migration 047 (additive and reversible)

- **Forward:** `server/db/schema_047_catalogue_calendar.sql`, registered in `server/db/migrate.js`.
- **Rollback:** `server/db/down/schema_047_catalogue_calendar.down.sql`. It drops only what 047 creates.
- **No existing table or row is altered.** Re-running `db:migrate` changes nothing: every insert is keyed and create-only, so admin edits survive.

| Object | What it holds |
|---|---|
| `catalogue_products` | code (`P01`–`P21`), catalogue number, slug, title, type (`day_tour`, `one_way_road_tour`, `cruise`, `multi_day`), base city, end city (required for one-way), status (`active`, `held`, `retired`), `merged_into_id`, GoAhead minimum (4), maximum group (12), cut-off hours (48), and a GoAhead deadline in days. The deadline is required for cruise and multi-day and must be empty otherwise; a CHECK enforces both. `legacy_product_id` links to the `tour_products` listing the product is sold through. |
| `catalogue_spec_versions` | Versioned specification: `draft` or `published`, effective date, content (itinerary with timings, inclusions, exclusions, vehicle class per band, guide languages, meals, pickup area and window, listed paid add-ons, room or cabin categories), and the source of any pre-filled text. **At most one draft per product. A trigger refuses any change to a published version.** The active version is the latest published one in effect. |
| `catalogue_calendar_rules` | Either weekdays (optionally every N weeks from an anchor date, for the fortnightly tours) or a list of explicit dates (ship sailing days), each with active-from and active-to. |
| `catalogue_departures` | Product, date, the spec version it is sold under, status (`open`, `go_ahead`, `cancelled_below_minimum`, `completed`), origin (`generated`, `adopted`), `legacy_departure_id` (the ordinary departure it is sold through), and the override (who, why, when). **`UNIQUE (product_id, date)`.** |
| `catalogue_departure_seats` (view) | Seats sold, derived from `pledges` on the linked departure. Never stored by hand. |
| `catalogue_events` | Stubs for later phases: `traveller_notice.cancelled_below_minimum`, `next_date_offer`, `go_ahead`, `completed`. One of each type per departure. Nothing sends them yet. |

### How the new departures link to bookings

This follows the migration plan's "evolve, don't rebuild" principle.
- A catalogue departure is sold through an ordinary `departures` row. Bookings are ordinary `pledges` on that row, taken by the existing booking endpoint, so **booking behaviour is unchanged**.
- The generator creates that ordinary row **only with the flag on**, and only for products with a published spec in effect.
- Existing future departures of a linked listing are **adopted** (linked as they are), never duplicated. Adopted departures keep the old rules, so bookings in progress are unaffected.

### Jobs

`server/jobs/catalogue-calendar.js`, scheduled from `server/jobs/scheduler.js`. Both are no-ops until 047 is applied.

- **catalogue-generate** (daily, and on demand from the admin Calendar):
  - Creates departures from the rules over a rolling window: 90 days for day and one-way tours, 365 for cruises and multi-day.
  - Idempotent: a second run creates nothing, enforced by the unique constraint.
  - Held and retired products generate nothing.
  - Dates already past their decision point are not generated.
- **catalogue-status** (every 15 minutes). **Status only; no money.**
  - `open → go_ahead` when seats sold reach the minimum. This is sticky: after GoAhead the departure runs even if cancellations take it below.
  - Day and one-way tours below the minimum at the cut-off become `cancelled_below_minimum`.
  - Cruise and multi-day tours below the minimum at the GoAhead deadline become `cancelled_below_minimum`.
  - `go_ahead → completed` once the departure has ended.
  - A cancelled generated departure also cancels its ordinary departure and releases its bookings, exactly as the existing unconfirmed-date job does. Traveller messages and the next-date offer are written as `catalogue_events` only, and only when someone had booked.
- **The existing `cancel-unconfirmed` job now skips generated departures,** leaving them to the new rules. The skip list is empty with the flag off.

### Run below minimum (admin override)

- `POST /api/admin/catalogue/departures/:id/run-below-minimum`, or the button in the admin Calendar.
- **Records:** a reason is required; who, why and when are stored on the departure and in the audit log.
- **Effect:** sets `go_ahead` and marks the linked departure confirmed, so the status job doesn't cancel it at the cut-off. The operator is paid at the 4–6 band in a later phase; `run_below_minimum` is the flag that phase reads.
- **Refused:** once the departure has started, and after a below-minimum cancellation that released bookings. This phase won't reinstate bookings behind a traveller's back.

### Admin tools

Admin only, behind the existing staff auth (`super_admin`, `ops_staff`). Every write is audit-logged.

| Screen | What it does |
|---|---|
| Catalogue | All 21 products: type, status, live and draft spec versions, how many fields are still to complete, calendar rules, upcoming departures, and whether `catalogue_v2` is on. |
| Product editor | Product fields; the listing it is sold through; spec versions (one draft at a time, pre-filled text shown with its source, publish with an effective date); calendar rules (weekdays, fortnightly, or explicit sailing dates). Publishing requires inclusions and exclusions, because the public page prints them from the spec. |
| Calendar | Departures by date with seats sold, the public label, status and the cut-off or deadline time; "Run below minimum"; "Run generator now". |

API: `server/catalogue-routes.js`. It answers 503 "not switched on yet" until 047 is applied.

### Public side (only with `FEATURES=catalogue_v2`)

- **Products:** only **active** products with a **published spec in effect** and a linked listing. Held, retired and unpublished products are hidden.
- **Product pages** (SPA, server-rendered HTML and JSON-LD) read the catalogue title and the active spec. **Every published inclusion and exclusion comes from the spec,** as do the itinerary, timings and pickup. A new "The details" section shows guide languages, meals, pickup, vehicle, rooms and extras when the spec states them.
- **Date picker:** only the catalogue's open departures, up to their cut-off, labelled **"X of 4 needed"** or **"Going ahead"**. "Start your own date" is hidden on the tour page and in the widget.
- **Redirects:**
  - A retired product's old URL returns **301** to the product it merged into (#14 → #15), keeping the query string.
  - A slug changed by the catalogue title returns 301 to the new one.
  - A hidden product returns **302** to `/itineraries`.
- **No operator names anywhere:** `operatorsByProduct` is empty, the server-rendered page and JSON-LD name no company, booking and GoAhead emails name none (`server/operator-lookup.js`), and `/partners` returns 302 to `/itineraries`.
- **Unchanged:** price, photos and the overview text still come from the listing, because pricing is not part of this phase.

### How to switch it on

1. `DATABASE_URL=<production> npm run db:migrate` applies 047. Nothing public changes yet.
2. In Admin → Catalogue, check each product's link to its listing. Complete and **publish** each spec you want on sale, and check the calendar rules.
3. Set `FEATURES=catalogue_v2` on the deployment. The next generator run (or "Run generator now") makes the dates bookable.

**Read "Before switching the flag on in production" below first.**

### Tests

- `server/catalogue-rules.test.js`: 16 unit tests of the pure rules.
- `server/catalogue.integration.test.js`: 13 tests on a real Postgres and the real server:
  - **flag-off parity:** bootstrap, product API and route heads are identical after the catalogue jobs run and a spec is published, and a booking still succeeds;
  - the unique constraint;
  - the seed;
  - idempotent generation and adoption, with held and retired products generating nothing;
  - cut-off and deadline cancellation, sticky GoAhead, completion, and adopted departures left alone;
  - the override (in-process and via the admin API with its audit row) and its refusals;
  - spec versioning (sold departures keep their version; published specs are immutable);
  - the flag-on payload, labels, 301 and no operator names.
- **Full gate** (`node scripts/ci-gate.js` with a local Postgres for the integration tests):
  - GREEN, all 11 runnable steps;
  - `npm test`: 992 pass, 0 fail, 0 skipped;
  - `npm run build` passes.
- **Not available:** the repo has no lint or type-check step (no ESLint, no TypeScript). The gate's own checks (catch handlers, duplication, status literals, vacuous tests, and so on) stand in for them and pass.
- **Browser check** (Chromium, against a flag-on server with a fake sign-in):
  - the admin Catalogue, product editor and Calendar render;
  - the override records its reason;
  - the tour page shows "4 of 4 needed", with no "start your own date" and no operator card.
  - The only console errors were web fonts that the sandbox's proxy refused.

---

## Weekdays chosen for "N× weekly" products (please review)

Stored as calendar rules (active from 1 Oct 2026) and editable in Admin → Catalogue. The only real dates in the repo are a snapshot (`site/_dev_bootstrap.json`); where it showed a product's existing dates, I kept that day.

| # | Product | Frequency | Days chosen | Why |
|---|---|---|---|---|
| 4 | Memphis, Saqqara & Dahshur | 3× weekly | **Tue, Thu, Sat** | Existing dates were Tuesdays |
| 5 | Cairo to Alexandria | 2× weekly | **Sun, Thu** | The listing ran Sundays; existing dates were Thursdays |
| 6 | Fayoum Oasis, Meidum & Hawara | Weekly | **Wed** | Kept apart from #7 |
| 7 | Whale Valley & Wadi El Rayan | Weekly | **Sat** | Kept apart from #6 |
| 8 | Full Day Minya | Weekly / on request | **Thu** | |
| 10 | The Grand West Bank | 3× weekly | **Mon, Wed, Fri** | Existing dates were Mondays |
| 11 | Dendera & Abydos | 2× weekly | **Wed, Sat** | Existing dates were Wednesdays |
| 15 | Luxor → Aswan (Esna, Edfu & Kom Ombo) | 3× weekly | **Mon, Wed, Fri** | Existing dates were Fridays |
| 16 | Aswan → Luxor (Kom Ombo, Edfu & Esna) | 3× weekly | **Tue, Thu, Sat** | Alternates with #15, so a vehicle that goes down one day can come back the next |
| 19 | Cairo and Luxor 4-Day | Weekly | **Sat** | |
| 20 | Egypt in Depth, 9 days | Fortnightly | **Fri**, every 2 weeks from 13 Nov 2026 | Anchored on an existing departure date |
| 21 | Egypt End to End, 12 days | Fortnightly | **Sat**, every 2 weeks from 10 Oct 2026 | The listing ran Mondays and Saturdays |

- **Daily** (every day): #1, #9, #12, #13.
- **No rules:** cruises #17 and #18 (enter the ship's sailing days as dates); held #2 and #3; retired #14.

---

## Specs still to complete

**Every spec is a draft; none is published.** So with the flag on, nothing appears publicly until you publish.

The seed copies a listing's own text into its product's draft, and records the source: `tour_products.<id>`, snapshot in `site/_dev_bootstrap.json`. It invents nothing. Vehicle and guide wording is kept as "reference" only, because it doesn't state a class per band or a language.

**Empty in every draft**, because no listing states them:
- vehicle class per group-size band;
- guide languages;
- meals;
- pickup window;
- listed paid add-ons (or "no add-ons").

**What else is empty**, as run against the repo's listing snapshot:

| # | Linked to a listing? | Copied from the listing | Still to complete beyond the list above |
|---|---|---|---|
| 1, 4, 5, 9, 10, 11, 12, 13, 14, 15, 16 | yes | start time, duration, inclusions, exclusions, pickup area | itinerary with timings (day-tour listings have none) |
| 18, 20 | yes | itinerary, start time, duration, inclusions, exclusions, pickup area, room categories (names only) | occupancies for each room or cabin category |
| 19, 21 | yes | itinerary, start time, duration, inclusions, exclusions, room categories (names only) | pickup area; room occupancies |
| **2, 3, 6, 7, 8, 17** | **not in the snapshot** | nothing | **everything** |

- **#3 (Secrets of the Grand Egyptian Museum) and #7 (Whale Valley safari)** exist in no listing in the repo, so their specs are entirely empty. #7 also needs a 4×4 rate structure, which is out of scope for this phase.
- **#2, #6, #8 and #17** are live in production (your 26 Sep admin screenshot shows them) but absent from the repo snapshot. The migration links them by title when exactly one approved listing matches, and copies their text the same way. **Check those four links in Admin → Catalogue after migrating.**

---

## Conflicts with the migration plan or existing data

1. **Side tables, not an in-place rewrite.** The plan sketched evolving `tour_products`/`departures` in place. The brief requires additive, reversible migrations with no change to existing tables, so the catalogue lives in new tables linked by id.
2. **Price is not flat yet.** The plan put "one flat published price" in phase 1. The brief excludes pricing, so prices still come from the listing and still fall as a group fills, including under the flag.
3. **Cut-off enforcement.** The catalogue cut-off (48 h) hides a date from the picker and drives the status job. But the booking endpoint still enforces the listing's own `booking_cutoff_hours` (24 h on every listing in the snapshot). So between 48 h and 24 h before departure, a direct API call can still book a date the site no longer shows. Moving the cut-off check into the booking route changes booking behaviour, so it's left for the booking phase.
4. **GoAhead deadline for cruises and multi-day.** Seeded as **21 days**, the draft agreements' example ("for example 21 days before departure"). The existing site and Terms say **30 days** for packages (`server/domain.js`, `site/goahead-promise.html`). Set the real value per product, and bring the copy in line before switching on.
5. **British English.** New user-facing copy (admin screens, tour-page catalogue text, server-rendered catalogue sentences) is British, as the brief asks. The rest of the site is US English: the standard recorded as U4.3, enforced for static pages by `server/constants.test.js`, and applied site-wide on 26 Sep at your request. With the flag on, pages now mix the two (e.g. "4–12 travelers" beside "travellers"). Pick one standard.
6. **Adopted departures and duplicates.** Existing future departures are adopted and keep the old rules. Where a listing already had two departures on one date (the snapshot has Nile Majesty twice on 26 Oct), only the one with more seats is adopted. The other stays an ordinary departure: its bookings are valid, but with the flag on it isn't shown in the picker.
7. **Retired #14 still has dates** in the snapshot (2 departures). They are adopted under #14 and visible in the admin Calendar. Their bookings stand, but with the flag on #14 isn't sold.
8. **"Start your own date"** is hidden on the tour page and widget with the flag on. The request API routes (`/api/public/departure-requests`, `/api/agency/departure-requests`) still work, because decision D7 is still open.
9. **URLs.** Only #13's slug changes under the catalogue title (`…temples-ramses-ii-…` → `…temples-ramesses-ii-…`); the old URL returns 301. All others keep their URLs.
10. **Linking by title** works only when one approved listing matches. If a production title differs from the pattern (e.g. Minya), the product stays unlinked and unbookable until linked in the editor.
11. **Generated departures record `created_by = 'admin'`,** the closest value the existing CHECK allows. `catalogue_departures.origin` records the real origin.
12. **Flag on, then off.** Departures made bookable while the flag was on stay open on the old site, and the catalogue status job still governs them. Turning the flag off is safe but not a full undo.
13. **Payload size.** With every product published, about 700 departures (90 days of daily tours) go into the public bootstrap, several times today's. It's fine at this size, but watch the page weight when publishing.
14. **Found and fixed while testing, not in the plan:**
    - The admin catalogue routes had been registered after the `/api` 404 catch-all. They would have returned 404 in production.
    - A date generated earlier and later given an ordinary departure would have been duplicated.

### Before switching the flag on in production

- **Bookings on generated departures below the minimum are cancelled at the cut-off with no message to the traveller.** This phase only writes the events. Either build the messaging first (the events are queued), or accept that for the first dates.
- Set the real GoAhead deadlines and cruise cut-offs (conflict 4), and review the weekday choices above.
- Publish specs. Nothing is public until at least one is published.

---

## What the next phase (roster and rate card) needs from this one

- **The assignment moment:** the `go_ahead` event in `catalogue_events` (one per departure, written in the same transaction as the status change). The roster phase consumes it to assign the rostered operator.
- **The anchor:** `catalogue_departures` is where `operator_id`, the assignment and `rate_card_version_id` should be added. It already carries product, date, status and the spec version.
- **Rate lock at first sale:** the status job already stamps the spec version when a departure first shows seats sold. Rate-card versioning needs the same stamp, ideally moved into the booking write itself (a booking-phase change) so there is no 15-minute gap.
- **Bands and overrides:** `run_below_minimum` marks departures to pay at the 4–6 band. Seats sold are derived from `catalogue_departure_seats`.
- **Manifest at cut-off:** the status job already acts at the cut-off. A manifest freeze belongs beside it.
- **Product types:** the four types and `usesDeadline()` in `shared/catalogue.js` decide which rate-card shape applies (bands plus per traveller, or rooms plus land plus bands).
- **Roster granularity (D11):** the calendar produces weekday dates and explicit sailing dates. A weekday roster covers the first; cruises need rostering by date.
- **Still owed to travellers:** a consumer for `traveller_notice.cancelled_below_minimum` and `next_date_offer`, and moving the 48-hour cut-off into the booking route (conflict 3).
- **Still to decide:** D3, D7, D8, D11–D13, D16–D18, D22, D23 (`03-migration-plan.md` §4).
