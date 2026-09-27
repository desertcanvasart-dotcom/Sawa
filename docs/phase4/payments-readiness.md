# Payments readiness: what traveler charging needs (investigation only)

For the conversations with the Egyptian lawyer and the payment provider, before traveler charging (mode A or B) is built. **No code was written for this.**

It answers five questions for the current provider:
1. Which provider and APIs does the current flow use?
2. Can it save a card and charge it later (mode A)?
3. Can it charge at booking and refund in full automatically (mode B)?
4. Can it make partial refunds?
5. Can it take EUR and settle to an Egyptian account?

It then lists what changes in the code for each mode.

**How the provider facts were gathered, and how far to trust them.** The repository shows what the code does. For Tab's capabilities, this environment's network proxy blocks `tab.travel`, `business.tab.travel` and `support.tab.travel`, so **none of Tab's pages could be read directly**. Every Tab fact below comes from a web search result that quotes or summarizes a named Tab page. Each one cites that page and is marked *(search summary, not read directly)*. Treat them as leads to confirm with Tab in writing, not as confirmed.

Where nothing was found, the answer is **unknown**.

---

## 1. The current flow

| | Fact | Source |
|---|---|---|
| Provider | **Tab (tab.travel)**, a London-based payment platform for tourism businesses | `server/payments.js:3-4, 17` (`PAYMENT_PROVIDER = "tab"`); [api-evangelist/tab](https://github.com/api-evangelist/tab) |
| APIs used | **None.** "Nothing here talks to Tab." Staff make a payment link in Tab's dashboard, paste it into the Sawa portal, and Sawa emails it to the traveler. Staff then mark it paid with Tab's reference. | `server/payments.js:3-8`; `server/app.js` payment-link routes; `docs/model-audit/01-current-state.md:38, 471-472` |
| SDK / webhooks | None in `package.json`. No webhooks, saved payment methods, off-session charges or holds. | `package.json`; `docs/model-audit/01-current-state.md:472` |
| When money is asked | After GoAhead only: a deposit link, then a balance link before the trip, with 3 days to pay each | `server/payments.js:5-6`; `shared/payment-window.js` |
| Refunds | Done by hand in Tab, then recorded in Sawa with Tab's refund reference. No calculation in the code. | `server/app.js` (`/api/admin/payments/:id/refund`); `booking_payments.refund_reference` |
| Currency | Links are in EUR (`booking_payments.currency` defaults to EUR) | `server/db/schema_043_booking_payments.sql` |
| Traveler promise today | "Nothing is charged before GoAhead"; no card is collected at booking | `site/terms.html`; `shared/booking-policy.js` `CANCELLATION_BEFORE_GOAHEAD` |

**Tab's integrations.** Tab says it connects to booking engines, PMSs and websites "with no developer needed". It names Cloudbeds and Bookinglayer, and offers a "Checkout Flow" booking widget ([Integrations](https://business.tab.travel/features/integrations?cc=us), search summary, not read directly).

**No public developer API or API reference for Tab was found.** A third-party API profile exists, but it is an empty stub: "a lead awaiting the enrichment pipeline" ([api-evangelist/tab](https://github.com/api-evangelist/tab), read directly). The search results for "Tab developers" returned **TabaPay** ([developers.tabapay.com](https://developers.tabapay.com/)), which is a different company.

---

## 2. Mode A: save a card with consent, charge it off-session at GoAhead (days or weeks later)

| Capability | Answer | Source |
|---|---|---|
| Save a card at booking, with consent | **Unknown as an API.** Tab's "take payments in advance" page says businesses can "charge saved cards and OTA VCCs". That describes charging cards held from booking channels such as Booking.com and Expedia virtual cards. It doesn't describe tokenizing a card on Sawa's own checkout and charging it by API later. | [Take payments in advance](https://business.tab.travel/features/in-advance) *(search summary, not read directly)*; [Charging Booking.com/Expedia cards](https://business.tab.travel/blog/how-to-charge-booking-com-or-expedia-cards?cc=us) *(search summary)* |
| Pre-authorization hold | **No, per Tab's own help article title.** "Can I pre-authorise cards with Tab?"; the summary says "Tab cannot be used to hold pre-authorisation charges". | [Tab Support: Can I pre-authorise cards with Tab?](https://support.tab.travel/en/articles/9337040-can-i-pre-authorise-cards-with-tab) *(search summary, not read directly)* |
| Off-session charge by API, days or weeks later, with retries | **Unknown.** No API documentation found. | none found |
| Strong Customer Authentication handling (merchant-initiated transaction flagging, and 3DS at save time for EU cards) | **Unknown.** This needs care: most of Sawa's travelers pay with EU and UK cards. | none found |
| Updating a declined card (the 24-hour fix rule, D5) | **Unknown** | none found |

**Verdict.** On current evidence, **mode A isn't confirmed possible through Tab**. There's no pre-authorization, and no documented API to save and later charge a card from Sawa's own checkout. Ask Tab directly, in writing, before assuming either way. Mode A also depends on the lawyer's answer to Q3: whether Capital Travel may save a card and charge it later under CBE rules and the Consumer Protection Law (No. 181 of 2018).

## 3. Mode B: charge at booking, refund in full automatically if no GoAhead

| Capability | Answer | Source |
|---|---|---|
| Charge at booking | **Probably yes, through Tab's hosted checkout.** It offers "deposits or full prepayment", and the Checkout Flow widget can be installed on any website. It is not confirmed whether Sawa's server can create the payment and learn its result without staff (API or webhook). | [Take payments in advance](https://business.tab.travel/features/in-advance), [Integrations](https://business.tab.travel/features/integrations?cc=us) *(search summaries)* |
| Know automatically that a payment succeeded (webhook or API) | **Unknown.** Today staff mark payments paid by hand. | none found |
| Full refund, automatically, when a date doesn't reach GoAhead | **Unknown as an API.** Refunds are documented from Tab's web dashboard (see 4). An automatic refund on many bookings at once would need an API. | [Tab Support: How can I refund my customer?](https://support.tab.travel/en/articles/836712-how-can-i-refund-my-customer) *(search summary)* |
| Fees on a refunded payment | Per Tab's support, "Tab refunds its fees to both you and your customer" on a refund. Confirm this for full refunds of never-run dates. | [Tab Support: Refunds](https://support.tab.travel/en/collections/2971450-refunds) *(search summary)* |

**Verdict.** Mode B is **workable by hand today**: a payment link at booking, then a dashboard refund when a date fails. Doing that at scale needs an API or webhook, which is **unknown**.

Mode B also **breaks the current promise** that nothing is charged before GoAhead. The Terms, the booking pages and every piece of payment copy must switch in the same release (`docs/model-audit/03-migration-plan.md`, D4).

## 4. Partial refunds

| Capability | Answer | Source |
|---|---|---|
| Partial refund | **Yes, from the dashboard.** "You can issue a refund for all or part of a transaction from your Tab web dashboard." For a partial refund you enter the amount and a reason, and Tab emails both parties. | [Tab Support: How can I refund my customer?](https://support.tab.travel/en/articles/836712-how-can-i-refund-my-customer) *(search summary, not read directly)* |
| Partial refund by API | **Unknown** | none found |
| Caveat | "Please do not check-in the booking now, because you will not be able to refund it later." This is Tab's own booking check-in. If Sawa's flow ever marks bookings checked in inside Tab, refunds after the tour would be blocked. | same article *(search summary)* |

The cancellation schedule's tiers (half or all of the deposit kept) need partial refunds, and so does the late-cancellation commission rule built in phase 3.

## 5. EUR payments, settled to an Egyptian account

| Capability | Answer | Source |
|---|---|---|
| Travelers pay in EUR | **Likely.** "Tab handles 100+ currencies"; guests "pay in their own currency", "converted at the pure mid-market rate, without markup". EUR isn't named in the summaries. | [Pricing](https://business.tab.travel/pricing?cc=us), [Tab Support: What exchange rates does Tab use?](https://support.tab.travel/en/articles/836710-what-exchange-rates-does-tab-use) *(search summaries)* |
| Payout to an Egyptian bank | **Yes, per Tab's Egypt page:** "free payouts to bank accounts in Egyptian Pounds, USD or any other major currency", to "all major banks in Egypt". | [Tab in Egypt](https://business.tab.travel/global-coverage/egypt) *(search summary, not read directly)* |
| Payout timing | Weekly, on Wednesdays; automatic when the balance is $500 or more; arrives in 1–4 business days | [Payments by Tab](https://business.tab.travel/payments) *(search summary)* |
| Keep EUR (not convert to EGP) on payout | "Receive funds in your choice of 140+ local currencies", which suggests a EUR payout to an Egyptian EUR account is possible. **Unknown whether allowed for an Egyptian company's account.** | [Payments by Tab](https://business.tab.travel/payments) *(search summary)* |
| Fees | Travelers pay a 4% fee when they use Tab. Businesses pay "between 2.6% and 5.9% for international card payments". | [Tab Support: What are the fees?](https://support.tab.travel/en/articles/836715-what-are-the-fees), [International payment fees](https://support.tab.travel/en/articles/7169701-international-payment-fees) *(search summaries)* |
| Who is merchant of record (Tab or Capital Travel)? | **Unknown.** This decides whose name is on the traveler's statement and receipt, and matters for the seller-of-record switch-over. | none found |

**For the lawyer:**
- Whether Capital Travel may receive EUR, or must receive EGP, for services sold to foreign travelers.
- Whether a UK platform paying out to an Egyptian company is acceptable under CBE rules.
- Whether a 4% traveler-paid fee may be added on top of the published price under the Consumer Protection Law. If Tab adds it, the price a traveler pays isn't the price Sawa shows.

**Margin report.** The phase 3 margin report reads the provider fee from a finance setting. Tab's 2.6–5.9% business fee is the number to enter there.

---

## 6. Questions to put to Tab, in writing

1. Is there a **server API** (with keys) to:
   - create a payment or checkout for a given amount and reference;
   - read its status;
   - receive a **webhook** on success, failure, refund and dispute?
2. Can a card be **saved with the customer's consent** on our checkout and **charged later by API**, merchant-initiated and without the customer present, 1–60 days after saving? How is SCA handled at save time and at charge time?
3. Can we issue **full and partial refunds by API**, including in bulk (every booking on a canceled date)?
4. On a full refund, are **all fees** (the traveler's 4% and ours) returned?
5. Can the **4% traveler fee** be absorbed by us, so the traveler pays exactly the published price?
6. For an **Egyptian company** (Capital Travel Service):
   - Can we accept EUR, and hold or pay out in EUR to an Egyptian EUR account?
   - What documents does onboarding need?
   - Who is merchant of record?
7. What is on the **traveler's card statement and receipt**: Tab, or Capital Travel?
8. Can the booking **"check-in"** in Tab be left unused, so refunds after the tour stay possible?

## 7. Questions for the lawyer (payments only)

1. **Q3:** May Capital Travel save a traveler's card at booking and charge it later, at GoAhead, with consent, under CBE rules and Law 181/2018? This decides mode A.
2. If mode B, does charging the full price at booking with an automatic refund on no GoAhead need anything beyond clear pre-contract disclosure?
3. May the traveler pay a provider's 4% fee on top of the published price?
4. Receiving EUR from foreign travelers, and paying Egyptian agencies commission in EGP at the CBE rate (the phase 3 decision): is either restricted?
5. Seller of record: Capital Travel (as the migration plan assumes). What must the receipt and the Terms say?

---

## 8. What changes in the code, per mode

**Common to both modes:**

- **A provider client** (`server/charges.js` or `server/provider.js`) for create payment, read status, refund, and verifying and handling the webhook. A webhook endpoint with signature checks and idempotent processing (replays are harmless). Provider keys come from the environment, never the repo.
- **Migrations:**
  - `charges` (one row per provider charge: amount, currency, provider id, state, idempotency key);
  - `refunds`;
  - `pledges.payment_mode` (`legacy_link` | `A` | `B`), backfilled to `legacy_link` for every existing booking.

  Legacy bookings keep the manual Tab-link flow (`server/payments.js`, Admin → Payments) until the last one has traveled or been refunded.
- **Checkout** (`src/main.jsx` tour page and widget; `src/AgencyDashboard.jsx` for agency seats that aren't billed): the provider's hosted fields, or a redirect. **No card data touches Sawa's server.** The traveler-details fields built in phase 3 (`src/TravelerDetails.jsx`) stay as they are.
- **Cancellation fees:** computed from `shared/booking-policy.js` `CANCELLATION_SCHEDULE` and refunded through the provider. The phase 3 commission rule (`commissionOutcome`) should then read whether a fee was actually kept, not the schedule band.
- **Margin report** (`server/finance.js` `marginReport`): read revenue from `charges` minus `refunds` by charge date, with the provider's actual fee per charge instead of the flat setting.
- **Agency-billed seats** (phase 3 `agency_invoices`): never charged to the traveler. Standard agency seats count toward GoAhead only once the traveler has paid or saved a card, with a 48-hour hold (decided, not built).
- **Copy, released together** (`docs/model-audit/03-migration-plan.md`, phase 3 file list): Terms §§ 3, 6, 9, 12, 13, 15; Privacy; the footer; `site/goahead-promise.html`, `how-it-works.html`, `faq.html`; `shared/site-copy.js`; the booking emails. Plus the seller-of-record switch: `server/brand.js`, `server/entity-disclosure.test.js` inverted, JSON-LD `seller`.
- **CSP** (`server/csp.js`): the provider's script and frame origins.
- **Tests:**
  - webhook replay is idempotent;
  - exactly one charge per booking under concurrency;
  - the refund arithmetic per tier;
  - the legacy link path is unchanged;
  - a rehearsal against the provider's test mode.

**Mode A (save the card, charge at GoAhead):**
- Booking: create a "setup" (save card, with consent and SCA) instead of a payment. Store the provider's payment-method token on the booking (a new `payment_methods` table).
- At GoAhead (`server/catalogue.js` `runStatusJob` → the `go_ahead` event, or `server/departure-status.js` for legacy): a **charge job** charges each booking's saved card once. The idempotency key is `departure:booking:attempt`. It runs after the status job, like the phase 2 assignment tick.
- **Failure rule (D5):** on a declined charge, email an update-card link and allow 24 hours. Then release the seat; the departure stays guaranteed and Sawa absorbs any shortfall.
- A booking made after GoAhead is charged at once.
- Before GoAhead, a cancellation deletes the saved card and charges nothing. The "nothing charged before GoAhead" copy stays true.
- Highest risks: double charges, and charges on dates that shouldn't have reached GoAhead (`pending_review`).

**Mode B (charge at booking, full refund if no GoAhead):**
- Booking: take the full published price (or the deposit, if decided) at booking, through the provider's checkout. The booking is confirmed only when the provider says paid (webhook).
- When a date is canceled below its minimum (phase 1 status job, phase 2 notice): an **automatic full refund** of every payment on it. It runs from the same job that queues the cancellation notice, once per booking, idempotent. The phase 2 cancellation email's "is being refunded" wording already exists (`belowMinimumCancellationEmail`, `paid: true`).
- **The copy changes:** "nothing is charged before GoAhead" becomes "charged at booking, refunded in full if the date doesn't run". That is in the Terms, the booking form, the GoAhead promise page and the emails, in the same release.
- Refunds for traveler cancellations follow the schedule (partial refunds by API).
- Highest risks: a missed refund on a canceled date; the copy and the behavior switching separately.

Both modes can live behind a per-product flag, starting with one day tour, as the migration plan suggests.
