# Automatic EUR/EGP exchange rate — report (28 Sep 2026)

The market rate is LIVE once migration 064 is applied and this is deployed. It feeds the Finance rate table. The traveller side sits behind `catalogue_v2`.

## 1. Research: where the rate comes from

### How this was checked

This session's network blocks every provider's site, so no API was called from here. Each claim below comes from the provider's own pages, found by searches limited to their domain. The Frankfurter claims come from its source code, cloned from GitHub (last commit 27 Sep 2026). Open the linked pages before relying on any price or quota.

| Provider | EGP? | What the rate is | Updates | Free tier | Paid from | Key | Terms |
|---|---|---|---|---|---|---|---|
| **Central Bank of Egypt** ([cbe.org.eg](https://www.cbe.org.eg/en/economic-research/statistics/cbe-exchange-rates)) | yes (source) | **Official** CBE buy and sell rate, per 1 EUR | Sunday–Thursday | web pages only | — | — | Credit CBE as the source; say if the data is transformed ([disclaimer](https://www.cbe.org.eg/en/disclaimer)) |
| ECB reference rates ([ECB](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)) | **no** | ECB reference rates for 29 currencies; EGP is not one of them | working days | free | — | no | — |
| **Frankfurter v2** ([api.frankfurter.dev/v2](https://api.frankfurter.dev/v2), [source](https://github.com/lineofflight/frankfurter)) | yes | With `providers=CBE`: the **CBE rate**, midpoint of buy and sell (its `cbe.rb` adapter, added in v2.1.0, 24 May 2026). Its default is a blend of official sources | daily, as CBE publishes | free, no key, no quota in the code | free (MIT; can be self-hosted) | no | Credit CBE for CBE data |
| **ExchangeRate-API** ([data](https://www.exchangerate-api.com/product/our-exchange-rate-data), [free docs](https://www.exchangerate-api.com/docs/free), [terms](https://www.exchangerate-api.com/terms)) | yes ([list](https://www.exchangerate-api.com/docs/supported-currencies)) | **Market** midpoint blended from 30+ central-bank and commercial sources (at least 3 per currency) | open access every 24 h; paid hourly | open access `open.er-api.com`: no key, rate-limited (HTTP 429) | about $10/mo Pro ([home](https://www.exchangerate-api.com/)) | open: no | Open access needs a "Rates By Exchange Rate API" link where its rates are shown; commercial use and caching allowed |
| Open Exchange Rates ([about](https://openexchangerates.org/about), [license](https://openexchangerates.org/license)) | yes | Market blend from undisclosed sources | hourly | 1,000 requests/mo, **USD base only**, **not for commercial use** | $12/mo ([signup](https://openexchangerates.org/signup)) | yes | — |
| Fixer / exchangeratesapi.io (APILayer) ([fixer](https://fixer.io/pricing), [eri](https://exchangeratesapi.io/pricing/)) | yes | Market aggregate | by plan | 100 requests/mo (Fixer's free-plan base and HTTPS not verified) | about $10–15/mo | yes | — |
| currencyapi.com ([pricing](https://currencyapi.com/pricing/)), CurrencyFreaks ([pricing](https://currencyfreaks.com/pricing.html)) | yes | Market aggregate | daily on free | 300 or 1,000 requests/mo | about $10/mo | yes | — |
| fawazahmed0/exchange-api ([README](https://github.com/fawazahmed0/exchange-api)) | yes | **Source not stated** | daily | free, served from a CDN | — | no | no SLA |
| Wise ([docs](https://docs.wise.com/api-reference/rate)), XE ([help](https://help.xe.com/hc/en-gb/articles/4414092026769-Currency-Data-API-packages-pricing-and-payment)) | yes | Mid-market | live | Wise needs an account; XE paid only | — | yes | Overkill here |

### Does the Central Bank of Egypt have an API?

No public or documented API was found: no JSON, XML or CSV feed. The site shows rates as web pages. Its historical-data page has an undocumented form that returns an Excel file. That form needs a session cookie and an anti-forgery token, and the site sits behind a firewall that rate-limits. (This comes from Frankfurter's `cbe.rb`; it couldn't be checked on cbe.org.eg itself.) Frankfurter already does this scraping and republishes the result as JSON.

### Official rate versus market rate

Since the March 2024 float, the CBE rate follows the interbank market. The IMF says the parallel-market gap has closed ([PR 25/58](https://www.imf.org/en/news/articles/2025/03/11/pr-2558-egypt-imf-completes-4th-rev-eff-arrangement-under-rsf-concl-2025-art-iv-consult), [PR 26/064](https://www.imf.org/en/news/articles/2026/02/26/pr-26064-egypt-imf-completes-5th-and-6th-revs-under-ext-arrange-under-eff-and-1st-rev-under-rsa)). So market midpoints and the CBE midpoint should normally sit a fraction of a percent apart. What remains is CBE's buy/sell spread and timing: CBE doesn't publish on Friday or Saturday.

### Recommendation

- **Primary: Frankfurter with the CBE provider**, `GET https://api.frankfurter.dev/v2/providers/CBE/rate/EUR/EGP`.
  - It gives the official Central Bank of Egypt rate. That is the defensible number for an Egyptian business, and the one the old manual entry already used ("CBE").
  - It is free, needs no key, and is open source, so it can be self-hosted with Docker if the public instance becomes a concern.
  - The risk is that it depends on a scraper of a firewalled site. Frankfurter's changelog records at least one outage where the CBE feed stalled.
- **Fallback: ExchangeRate-API open access**, `GET https://open.er-api.com/v6/latest/EUR` (`rates.EGP`). No key, updated daily, commercial use allowed. It is a market midpoint rather than the official rate, and the stored row says which source it came from.
  - Its attribution rule applies where its rates are shown. Sawa shows the rate only in admin screens; travellers see EUR prices, not the rate. If that ever changes, add the link or move to the $10/mo plan.
- Both are configured: `FX_PROVIDERS` picks and orders them, and the default is CBE first, then ExchangeRate-API. Changing provider needs no code change.
- Finance shows "CBE data: source Central Bank of Egypt", as the CBE disclaimer asks.

## 2. The daily fetch

**Where:** `server/fx.js` (`runFxDaily`), run by `server/jobs/fx-daily.js` from the scheduler, and by hand with `npm run job:fx-daily` or **Finance → Rates and settings → Fetch today's rate now**.

**When:**
- The job ticks every 6 hours but fetches only on the first tick of each Cairo day.
- A day that already has a rate is left alone, whether fetched or entered by hand. A restart or deploy therefore never causes a second call, and a failed morning fetch is retried the same day.
- `FX_FETCH_DISABLED=1` stops the fetch.

**Where it's stored:** Finance's existing rate table, `fx_rates`, one row per day. Migration 064 adds:
- `status`: approved, pending or rejected;
- `source`, plus `source_note` for the provider's label;
- `fetched_at`, and `provider_as_of` (the provider's own date, e.g. Thursday's CBE rate stored for a Friday);
- `previous_egp_per_eur`, and who decided on the rate and when.

A rate entered by hand is `approved` / `manual`, and replaces a fetched rate for that day, including one waiting for approval.

**When the fetch fails:**
- Nothing is stored and the last good rate stays in use.
- An admin alert (`fx_alerts`, `fetch_failed`) records the errors and the rate still in use. It is emailed to ops once, not on every tick. It shows as a banner in Finance, and the next good fetch clears it.
- An answer more than 5 days old counts as a failure, which catches a source that has stopped updating.

**When the rate jumps more than 5%** from the last approved rate:
- It is stored as `pending` and an alert (`rate_pending`) is raised and emailed.
- Finance lists it with **Approve** and **Reject**.
- Nothing uses it until it is approved. Every reader of `fx_rates` now filters on `status = 'approved'`: the FX line, commission statements, operator settlement, the margin report and the cancellation-tier loss check.
- A rejected rate stays in the table for the record.

## 3. The traveller rate (behind catalogue_v2)

**One site-wide rate.** The rate is kept in `fx_traveller_rates`, one row per change. The latest row is the one in force, and every row records its date, the market rate it came from, the buffer, the reason and who set it.

**How it's set:** latest approved market rate × (1 − buffer). It is rounded down to 2 decimals, so it's never kinder to the traveller than the buffer allows. The buffer is set in Finance and defaults to 3%.

**Automatic renewal:**
- It updates weekly.
- It updates at once when the market rate moves more than 3% (see the decision below).
- It is also re-checked when a pending rate is approved, or when a rate is entered by hand.
- With `catalogue_v2` off, the market rate is still fetched but the traveller rate is not renewed.

**Bookings keep their rate:**
- `stampBookingPrice` stores the rate in force on the booking (`pledges.published_eur_rate`).
- Payment requests and tier-difference refunds use that stored rate.
- The pool-model integration test books at 50, changes the rate to 45, and shows the earlier booking still charged at 50 while a later booking pays at 45.

**Manual override:**
- Finance → Traveler rate → Override, with a reason that is required both by the API and by a database check.
- Each override is recorded in the rate's history (who, when, why) and in the audit log (`finance.traveller_rate.override`).
- An override stands until the next weekly or early renewal.

**Migration from per-version rates:**
- The per-version rate (`catalogue_rate_versions.eur_rate`) is removed.
- The most recently published version's rate becomes the first site-wide rate (`reason = migrated`), so prices don't vanish before the first fetch.
- Each version keeps a note of its old rate in `source.migration064`, which the rate-card history shows.
- The rollback puts each version's rate back.

### Decisions to confirm

1. **"More than 3% from the current traveller rate."** Taken literally, this fires every day. The traveller rate is 3% below the market by design, so the market is always about 3.1% above it. The rule is therefore implemented as: the market moves more than 3% **from the market rate the current traveller rate was worked out from**.
   - For an override, that is the market rate on the day of the override.
   - For the migrated rate, it is the migrated rate ÷ (1 − buffer).
2. **An override is not permanent.** It is replaced at the next weekly or early renewal. The alternative, keeping it until an admin clears it, is a small change if you prefer it.
3. **Rounding up.** EUR prices are now EGP ÷ rate **rounded up**, as asked; until now they rounded to the nearest euro. At 50 EGP per EUR, 2,360 EGP was €47 and is now €48. The worked-example tests were updated to match.
4. **Who can change it.** Staff roles (super admin and ops staff) can approve or reject rates, set the buffer and override, the same roles as the other Finance settings.
5. **Alerts go to the ops address** (`OPS_NOTIFY_TO`) and appear as banners in Finance.

## 4. Where EUR prices come from now

| Where | Source |
|---|---|
| Rate card editor | Shows the site-wide rate (read-only, with a pointer to Finance), the EUR price of each tier and the tour-page line. The per-version rate field and the "EUR rate" column are gone |
| Tour pages and the embed widget | `server/catalogue-public.js` prices every tier from the site-wide rate (the widget renders the same product data) |
| Bookings and charges | The rate stored on the booking at the time it was made |

The public price caches are cleared when the job changes the rate (`onTravellerRateChange`). Admin changes clear them anyway, because they are writes.

## 5. Tests

**`server/fx-rules.test.js`** (rules, no database): the 5% approval threshold; the traveller rate = market less the buffer, rounded down; EUR rounded up; and the weekly, market-move and initial renewal rules, including the migrated-rate base.

**`server/fx.integration.test.js`** (real Postgres, stubbed fetch):
- The daily fetch stores the rate with its source and timestamp, and a second run the same day makes no call.
- The fallback source is used when CBE's fails.
- A failed fetch keeps the last good rate and alerts once; the next good fetch clears the alert.
- A stale answer counts as a failure.
- A jump over 5% waits for approval and isn't used; approving it applies it and renews early; rejecting it keeps it out.
- The weekly update applies the buffer, and a changed buffer takes effect from then.
- A market move over 3% triggers an early update; 3% or less waits for the week; every change is recorded with its date.
- With the flag off, the market rate is fetched and the traveller rate is left alone.
- A manual override needs a reason and is logged in the history and the audit log, and the database refuses one without a reason.

**`server/pool-model.integration.test.js`** (updated):
- The tour page shows prices at the site-wide rate, rounded up.
- A booking keeps its locked rate after the rate changes, and a later booking pays at the new one.
- The per-version column is gone and stays gone after re-running 061 and 064.
- The tier-drop refund is now €4 (it was €6).

`node scripts/ci-gate.js` passes all 11 runnable steps.

## 6. Applying it

The order matters: apply migration 064 **before** deploying.

The new code reads `fx_rates.status`, so Finance's rate screens and the margin report would fail on a database without 064. The other order has a smaller gap: after the migration and before the deploy, only saving a rate-card draft would fail, because the old code still writes the dropped column.

- Supabase SQL editor: `docs/ops/apply-migration-064.sql` (one transaction, safe to rerun).
- Or: `DATABASE_URL=<production> npm run db:migrate`.
- Rollback: `server/db/down/schema_064_automatic_fx.down.sql`.

After deploying, open Finance → Rates and settings, press **Fetch today's rate now** and check the row it adds. The scheduled job then runs on its own; the scheduler is on in production.
