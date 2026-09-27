# Capital Travel Service: every reference in the repository

**Why:** Capital Travel Service (CTS) is no longer involved; no deal was reached with its owner. This lists every reference to **Capital Travel Service**, **CTS**, **ETAA 2179** (its travel-agency registration) and **1 Farouk Mahmoud** (its address). Nothing has been changed yet: the replacement depends on your licence decision.

> **Status, 27 Sep 2026, later.** Capital Travel Service no longer operates Sawa; Online Era does, under General Sales Agent license no. 32241. The live items below are dealt with in [#226](https://github.com/desertcanvasart-dotcom/Sawa/pull/226):
> - **L1**: the privacy page shows Online Era's own license, and the build check now catches any wording of ETAA 2179.
> - **L2**: new migration 054 lets a record be unlisted. The production SQL and its rollback are in `docs/ops/remove-cts-from-partners.md`, **to be run by hand**. `dom-smoke.js` no longer requires CTS.
> - **L3**: `DIRECT_BOOKINGS_OPERATOR` has no default. Remove it from Railway if it is set there.
> - **`server/pdf.js:89`**: the header reads "Sawa (Online Era)".
>
> The seller and merchant references in the planning docs, and the Terms draft, are updated in [#225](https://github.com/desertcanvasart-dotcom/Sawa/pull/225). The agreements .docx still names CTS and is awaiting a redraft. The inventory below is kept as it was found.

Searched on `main` at `af18a94` (27 Sep 2026), plus open PR #224. The search covered text files (`git grep -i`) and the text inside the Word and Excel files. Matches for "Capital Travel" (without "Service") are included. `package-lock.json` has none.

## First: what is live on the site today

| # | Where | What a visitor sees | Live? |
|---|---|---|---|
| L1 | `site/privacy.html:106` | Under the controller **"Online Era, trading as Sawa Tours"**: **"ETAA license: 2179"**. That is CTS's registration, presented as Online Era's. | **Yes.** A static page, served as it is in the repo. The build check (`server/entity-disclosure.test.js`) only looks for the spelling `ETAA 2179`, so this one passes it. |
| L2 | **`/partners`**, built from the production `agencies` table (`server/seo.js:652`, `src/main.jsx:3367`) | "Capital Travel Service", licensed, verified by Sawa, with a link to the ETAA registry at `licc=2179` (from the row's `etaa_registration_no`). | **Yes.** The daily production check (`scripts/dom-smoke.js:81`) requires this name and two ETAA links on `/partners`. Its DOM step **passed on 27 Sep 2026 09:58 UTC** (Daily verify run 46). The row lives in the database, not the repo: the founding-partner insert the client ran on 11 Aug (`docs/audit/staged-seed-rehearsal.md:58`). |
| L3 | **Tour pages and booking confirmations**: "Run by …" (`server/domain.js` `operatorForDeparture`, `server/operator-lookup.js`, `server/email.js` booking confirmation) | For a date whose travelers booked directly, the operator shown is **Capital Travel Service**, with its verified mark. | **Very likely.** Direct bookings count for the company named by `DIRECT_BOOKINGS_OPERATOR`. Its default is `"Capital Travel Service"` (`server/brand.js:174`), unless Railway sets that variable, and the matching `agencies` row exists (L2). Check Railway → Variables for `DIRECT_BOOKINGS_OPERATOR`. |
| L4 | Search results and link previews for `/partners` and tour pages | The same names, from the same server-rendered pages. | Follows L2 and L3. |

**Not live today:**
- the footer, Terms, cookies page, JSON-LD and email footers (all name Online Era since DIR-19, 10 Aug 2026);
- the `catalogue_v2` screens (flag off);
- migrations 047–052 (not applied in production).

### Database rows (production, not in the repo)
To see them, run this read-only query in the Supabase SQL editor:

```sql
SELECT id, name, relationship, verification_state, etaa_registration_no, tourism_license_no, contact_name
  FROM agencies WHERE name ILIKE '%capital travel%' OR etaa_registration_no = '2179';
-- What hangs off it: listings it operates, bookings counted for it, its logins.
SELECT (SELECT COUNT(*) FROM tour_products WHERE agency_id = a.id) AS listings,
       (SELECT COUNT(*) FROM pledges WHERE agency_id = a.id)       AS bookings_as_agency,
       (SELECT COUNT(*) FROM app_users WHERE agency_id = a.id)     AS logins
  FROM agencies a WHERE a.name ILIKE '%capital travel%';
```

## Code (server, client, scripts)

| File:line | What it is | Live? |
|---|---|---|
| `server/brand.js:174` | `DIRECT_BOOKINGS_OPERATOR` defaults to `"Capital Travel Service"`. Direct travelers count for this company when choosing a departure's operator and in the legacy settlement split. | **Yes** (L3) |
| `server/brand.js:49–54` | A comment: "ETAA 2179 is not Online Era's…"; a warning, not output. | No (comment) |
| `server/pdf.js:89` | The operator settlement statement PDF header reads **"Sawa - Capital Travel Service"**. | No: phase 3 statements, behind `catalogue_v2`. It **would print on every statement** once the flag is on. |
| `server/settlement.js:16` | A comment on the legacy split ("direct travellers count for Capital Travel Service"). | Comment; the behavior is `brand.js:174` |
| `server/domain.js:530` | A comment on the operator rule. | Comment |
| `scripts/dom-smoke.js:81` | The daily production check **requires** "Capital Travel Service" on `/partners`. | Runs daily against production: **it will fail the day CTS is removed from `/partners`** |
| `scripts/audit-claims.js:123` | The claims audit treats "Capital Travel Service" as a vouched-for partner name. | Runs in preflight: it would stop flagging the name if it reappeared |
| `site/_dev_bootstrap.json:2602–2606` | A dev-only snapshot: operator "Capital Travel Service", ETAA link `licc=2179`. | No: excluded from deploys (`.railwayignore`), but it shows what production served |
| `site/privacy.html:106` | "ETAA license: 2179" | **Yes** (L1) |

## Migrations

| File:line | What it does | Applied in production? |
|---|---|---|
| `server/db/schema_029_agency_relationship.sql:4, 16` | Comments: CTS as a verified operator; DIR-19.3. | Yes (comments only) |
| `server/db/schema_036_no_founding_partner.sql:1, 4, 8` | Comments: "there is no founding partner; CTS is an operator". | Yes (comments only) |
| `server/db/schema_044_settlements.sql:15, 19` | Comments on the legacy settlement split. | Yes (comments only) |
| `server/db/schema_049_operators_roster_rates.sql:348, 359` | **Data:** creates an operator record for any `agencies` row named exactly `'Capital Travel Service'`, copying its licence and **ETAA 2179**. | **No.** 049 isn't applied. **Remove or change this before 049 runs in production**, or CTS becomes a pending operator. |
| `docs/migration-044-settlements.sql:26, 30`, `docs/migrations-043-044.sql:135, 139` | Copies of 044's comments. | n/a (docs) |

No seed file (`server/db/seed*.js`) names CTS. The production row came from the client's own insert (above).

## Tests

These use CTS as a **fixture name**; some assert the current rule. Rename them when the replacement is known. None is visible to anyone.

| File | Lines | Use |
|---|---|---|
| `server/operator-assignment.test.js` | 22 | `CTS = "ag_cts"` as the direct-bookings operator in the operator rule |
| `server/settlement.test.js` | 10 | The client's settlement example (CTS 7 / A 5 / B 3) |
| `server/operator-email.test.js` | 7 | "Run by: Capital Travel Service" in the booking confirmation |
| `server/entity-disclosure.test.js` | 6 | **Guards the disclosure:** CTS never presented as the operator of the platform, and no "ETAA 2179" (the spelling in L1 isn't caught) |
| `server/accreditation.test.js` | 6 | Guards that ETAA 2179 isn't presented as Sawa's credential |
| `server/operator-record.test.js` | 5 | An operator record fixture with ETAA "2179" |
| `server/booking-flow.integration.test.js` | 3 | A CTS agencies row, as the direct-bookings operator |
| `server/operators.integration.test.js` | 3 | 049's mapping of CTS (see migrations) |
| `server/partners-page.test.js` | 3 | `/partners` renders CTS |
| `server/settlements.integration.test.js` | 3 | The settlement split with CTS |
| `server/catalogue.integration.test.js` | 2 | A CTS row; asserts no operator name in the catalog payload |
| `server/payments.integration.test.js` | 2 | Direct seats count for CTS |
| `server/ops-notify.test.js` | 2 | A sample agency name in an ops email |
| `server/pass-state.test.js` | 1 | Old footer wording used as a fixture |

## Legal and agreement drafts

| File | References | Status |
|---|---|---|
| `docs/model/Sawa-Operator-Supply-and-Agency-Reseller-Agreements-draft.docx` | The **contracting party** in both agreements: "Capital Travel Service, a tourism company licensed in Egypt (**ETAA 2179**…), of **1 Farouk Mahmoud St, Giza**…", the signature blocks "For Sawa (Capital Travel Service)", the structure note ("CTS sells every seat…") and the lawyer questions about CTS. | Draft; not signed as far as the repo knows. **The only place "1 Farouk Mahmoud" appears.** |
| `docs/legal/terms-catalogue-draft.md` (**PR #224, not merged**) | C1.1 names CTS as the Seller; lawyer question 2 is about it. | Draft for the lawyer, unpublished. Needs rewording before it goes to the lawyer. |

## Payment and Tab setup notes

| File:line | Reference |
|---|---|
| `docs/phase4/payments-readiness.md:93, 96, 114, 118, 123, 127` | The open questions assume CTS as merchant or seller of record: whether it may receive EUR, what's on the card statement, whether it may save cards. |
| `docs/phase4/payments-readiness.md:59` | Mentions Capital Travel in the mode A verdict. |

The repo doesn't record **whose name the Tab account is in**. If it's CTS's, that is outside the repo and needs changing at Tab. That's a question for whoever opened the account.

## Planning, audit and report documents (history; not on the site)

| File | Lines | Content |
|---|---|---|
| `docs/model-audit/03-migration-plan.md` | 91, 182, 223–225, 300, 323, 409, 457, 473, 491, 551, 557 | CTS as seller of record, merchant account, invoices, rostering; decisions D3 and D9 |
| `docs/model-audit/README.md` | 18, 33, 38, 50, 61 | The same, summarized |
| `docs/model-audit/02-gap-analysis.md` | 105, 186–189 | "CTS (ETAA 2179) sells every seat"; the merchant account; `DIRECT_BOOKINGS_OPERATOR` |
| `docs/model-audit/01-current-state.md` | 327, 409, 497, 581 | The current state, including L1 (privacy page, 497) |
| `docs/phase2/REPORT.md` | 54, 154, 215 | "CTS is an operator like any other"; 049 maps it |
| `docs/phase3/REPORT.md` | 205, 221 | Card saving, invoices in Capital Travel's name |
| `docs/launch/catalogue-v2-runbook.md` | 121, 135, 253 | Pre- and post-checks for 049's CTS operator record; operator setup, "Capital Travel Service included" |
| `docs/audit/entity-disclosure-sweep.md` | 44–48, 98, 105–106, 115, 123, 138–139 | DIR-19, the removal of CTS as the platform's operator (history) |
| `docs/audit/legal-register.md` | 32–34, 197–204 | The same history |
| `docs/audit/operator-records.md` | 73–74, 104–110, 151 | "CTS should become an operator record" |
| `docs/audit/open-directives.md` | 556, 560, 756 | DIR-19.3, OOO3.3 |
| `docs/audit/privacy-policy-revision.md` | 76–77 | History |
| `docs/audit/cancellation-copy-proposal.md` | 60, 77 | History |
| `docs/audit/migration-023-proposal.md` | 140 | An example referrer name |
| `docs/audit/staged-seed-rehearsal.md` | 58 | The client's CTS founding-partner insert, 11 Aug 2026 |

## Suggested order, once the replacement entity is known

1. **Live first:**
   - L1, the privacy page's "ETAA license: 2179";
   - the `/partners` row (L2), by verification state or relationship in the database;
   - `DIRECT_BOOKINGS_OPERATOR` (L3): set the variable on Railway or change the default;
   - the daily check (`scripts/dom-smoke.js`), in the same change as L2, or it fails.
2. **Before 049 is applied:** the CTS clause in migration 049, and the runbook's 049 checks.
3. **Before `catalogue_v2`:** the settlement PDF header (`server/pdf.js:89`), the catalog Terms draft (#224), and the payments-readiness questions.
4. **The agreements draft (.docx):** the contracting party, the address and the signature blocks.
5. Tests and history documents: rename the fixtures; leave the audit history as a record, or add a note.

The entity-disclosure test should gain the spelling `ETAA license: 2179` (and the bare `2179` beside "ETAA"), so that L1 can't come back unnoticed.
