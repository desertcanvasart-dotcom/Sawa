# Payments readiness: what traveler charging needs (investigation only)

For the conversations with the Egyptian lawyer and the payment provider, before traveler charging (mode A or B) is built. **No code was written for this.**

> **Legal structure decided 27 Sep 2026.** The operator assigned at GoAhead is the **seller** of each departure. **Online Era** (Commercial Registration 148500), which holds a licence to collect payments as an agent, is its commercial and payment-collection agent and the **merchant** on the payment account. **Capital Travel Service is not involved in Sawa.** The questions below are updated accordingly; `docs/legal/terms-catalogue-draft.md` (v2) has the lawyer questions for this structure.

It answers five questions for the current provider:
1. Which provider and APIs does the current flow use?
2. Can it save a card and charge it later (mode A)?
3. Can it charge at booking and refund in full automatically (mode B)?
4. Can it make partial refunds?
5. Can it take EUR and settle to an Egyptian account?

It then lists what changes in the code for each mode. Two sections were added after the first findings:
- **Mode C** (section 9), "book now, pay at GoAhead": a design that works with Tab as it is today.
- **A provider comparison** (section 10): Tab, Paymob, Kashier, Geidea and Stripe.

**How the provider facts were gathered, and how far to trust them.** The repository shows what the code does. For the providers, this environment's network proxy blocks every provider's own site:
- `tab.travel`, `business.tab.travel` and `support.tab.travel`;
- `docs.paymob.com`;
- `developers.kashier.io`;
- `docs.geidea.net`;
- `stripe.com`.

So **no provider page could be read directly**. The only exceptions are Paymob's own GitHub organization (`github.com/PaymobAccept`), read directly, and two third-party API profiles, read directly and marked third-party.

Every other provider fact comes from a web search result that quotes or summarizes a named page on the provider's own site. Each one cites that page and is marked *(search summary, not read directly)*, or *unconfirmed* in the comparison table. Treat them as leads to confirm with the provider in writing, not as confirmed.

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

**Verdict.** On current evidence, **mode A isn't confirmed possible through Tab**. There's no pre-authorization, and no documented API to save and later charge a card from Sawa's own checkout. Ask Tab directly, in writing, before assuming either way. Mode A also depends on the lawyer's answer to Q3: whether Online Era, as collecting agent, may save a card and charge it later under CBE rules and the Consumer Protection Law (No. 181 of 2018).

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
| Who is merchant of record (Tab, or Online Era as collecting agent)? | **Unknown.** This decides whose name is on the traveler's statement. Decided on Sawa's side: Online Era holds the account as the operators' collecting agent, and receipts are issued by Online Era on behalf of the operator (the seller). | none found |

**For the lawyer:**
- Whether Online Era, as collecting agent, may receive EUR for services the operator sells to foreign travelers, and in what currency it must pay the operator.
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
6. For an **Egyptian company collecting as agent** (Online Era, Commercial Registration 148500):
   - Can we accept EUR, and hold or pay out in EUR to an Egyptian EUR account?
   - What documents does onboarding need?
   - Can the account be held by Online Era as collecting agent for several operators, and who is merchant of record?
7. What is on the **traveler's card statement and receipt**: Tab, or Online Era? Can the receipt name the operator as seller?
8. Can the booking **"check-in"** in Tab be left unused, so refunds after the tour stay possible?

## 7. Questions for the lawyer (payments only)

1. **Q3:** May Online Era, as collecting agent, save a traveler's card at booking and charge it later, at GoAhead, with consent, under CBE rules and Law 181/2018? This decides mode A.
2. If mode B, does charging the full price at booking with an automatic refund on no GoAhead need anything beyond clear pre-contract disclosure?
3. May the traveler pay a provider's 4% fee on top of the published price?
4. Receiving EUR from foreign travelers, and paying Egyptian agencies commission in EGP at the CBE rate (the phase 3 decision): is either restricted?
5. Seller: the operator assigned at GoAhead, with Online Era as its collecting agent (decided 27 Sep 2026). What must the receipt and the Terms say? (`docs/legal/terms-catalogue-draft.md`, v2)

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

---

## 9. Mode C: "book now, pay at GoAhead"

**The design in one line.** The traveler books with no card and no payment. When the departure reaches GoAhead, each traveler gets a Tab payment link for the full published price, with a deadline and a reminder. Unpaid seats are released at the deadline and offered to the departure's waitlist. The departure stays guaranteed.

**Decided (27 Sep 2026):**
1. **A seat released for non-payment is treated exactly like a cancellation before cut-off** (Operator Supply Agreement, clause 10.1: "removed from the manifest, and the departure fee band is recalculated"). The operator isn't paid for it. The deadline is capped at the cut-off, so a release always happens before cut-off.
2. **The guarantee:** a departure that drops below 4 still runs. The operator is paid the 4–6 band plus the per-traveler amount for everyone on the manifest at cut-off.
3. **Agency-billed invoices** fall due at the mode C deadline after GoAhead.
4. **Refunds:** mode C has no deposit. The fee kept on a cancellation is the full price × the tier's retained percentage.
5. **Scope:** mode C applies only to catalog departures. Legacy bookings stay on the current deposit-plus-balance flow.

**Why it fits today's constraints:**
- **The promise stays literally true.** "Pay nothing until it goes ahead" is what the site says today (`shared/booking-policy.js` `CANCELLATION_BEFORE_GOAHEAD`, `site/terms.html`).
- **The lawyer's Q3 disappears.** No card is stored or charged later.
- **It needs nothing Tab doesn't do today:** a payment link per booking, a dashboard refund, and "mark paid" in Sawa (section 1).
- **Most of it is already built.** The legacy flow already sends Tab links after GoAhead (`server/payments.js`, Admin → Payments). Mode C changes how much is asked (the full price, once), how long travelers have, and what happens when they don't pay.

**The cost.** Some travelers won't pay. The departure runs anyway and Sawa absorbs the gap. At launch volumes (4–12 seats a departure) that is a small, known cost, visible per departure in the margin report built in phase 3.

### 9.1 The flow

1. **Booking.**
   - No card and no payment. The traveler accepts the Terms at booking; this is already recorded on the public booking route.
   - The booking counts toward GoAhead at once. Every booking already does: `catalogue_departure_seats` sums live bookings, and so does the legacy `refreshStatus`.
   - The phase 3 traveler details stay required under the flag, as built.
> **Superseded by phase 5 (28 Sep 2026, `docs/phase5/REPORT.md`).** The request charges the tier price at the time it is sent (not a fixed published price); agency-billed seats pay the full price; a cheaper tier by the cut-off refunds the difference.

2. **GoAhead** (the phase 1 status job; catalog departures only). Each live booking needs one payment link for the **full published price**, following the settled decision "charge at GoAhead = full published price". Legacy departures keep today's deposit link plus balance link.
   - **Agency-billed seats:** the agency gets the link, for its phase 3 invoice amount (published price less commission).
   - **Standard agency seats:** the traveler gets it, as for direct bookings.
3. **Deadline.** 48 hours after the link is sent (configurable, 24 or 48), capped at the departure's cut-off, so a manifest never freezes with a seat still pending (9.5).
   - This keeps today's floor of never less than 24 hours (`MIN_WINDOW_HOURS` in `server/payments.js`). When GoAhead comes so close to the cut-off that the floor can't be met, the deadline is the cut-off, and admin sees these as "short window".
   - **A reminder at the halfway point,** once: 24 hours in on a 48-hour window.
4. **Deadline passes unpaid.** The seat is released:
   - the booking is canceled with reason `unpaid`;
   - the traveler is emailed;
   - the seat is offered to the departure's waitlist first (9.4), then goes back on sale.
5. **The departure stays guaranteed** even if releases take it below 4: it is not canceled. This already holds in the code: `nextStatus` in `shared/catalogue.js` treats `go_ahead` as sticky, and `refreshStatus` in `server/departure-status.js` never moves the ordinary departure's `minimum_reached` back down. The operator is paid for the manifest at cut-off: the 4–6 band plus the per-traveler amount for each traveler on it (9.5).
6. **Admin sees each departure's seats** as paid, awaiting payment (with its deadline), released or short window. Admin can **extend one traveler's deadline**, with a reason. The original deadline is kept, not overwritten: this code base deliberately stores deadlines so one "can't quietly move itself" (`shared/payment-window.js`).
7. **A booking made after GoAhead** gets its link at once, with the same deadline rule.

### 9.2 Creating the links and matching payments, with Tab as it is

No Tab API was found (sections 1–3), so link creation and the "paid" signal stay manual. Everything around them can be automated.

| Step | Today | Mode C with Tab | Automatable without a Tab API? |
|---|---|---|---|
| Know a link is needed | Admin → Payments shows "Deposit link needed" (`paymentSummary`) | The same queue, one "Payment link needed" per booking at GoAhead. An email to ops lists them. | **Yes**: the queue, the email to ops and the count |
| Make the link | Ops create it in Tab's dashboard | Same. Put the **booking code** in Tab's description or reference field so the payment can be matched. | **No**: manual in Tab. Whether Tab has a reference field is unconfirmed; ask Tab. |
| Send it | Ops paste it into Sawa; Sawa emails the traveler | Same, and Sawa stamps the deadline (9.1 step 3) | **Yes**: Sawa emails, stores the deadline and schedules the reminder |
| Reminder | none | At the halfway point, once | **Yes**: a job |
| Know it was paid | Ops mark it paid with Tab's reference | Same. Tab notifying the business on payment is unconfirmed; ops mark it in Sawa. | **No**: manual. It becomes automatic with any provider that has webhooks (section 10). |
| Release at the deadline | none | A job releases unpaid seats | **Yes**: a job. A payment made but not yet marked would be released, so the job warns ops 2 hours before each release. |

**Volume.** One link per booking, typically 2–6 bookings per departure. At launch volumes a daily queue of a few links is workable by hand. The same design runs unchanged on a provider with a link API and webhooks (section 10); only "make the link" and "know it was paid" become automatic.

### 9.3 Recording payment, and refunds under the cancellation tiers

- **Recording payment** is unchanged: `POST /api/admin/payments/:id/paid` with Tab's reference, and the booking moves to "paid in full".
  - A booking released for non-payment can't be marked paid. It must first be reinstated in Admin → Bookings, which checks capacity.
- **Refunds.** Mode C has no deposit, so the tiers are stated as a **retained percentage of the full price**:
  - **Fee kept:** full price × the tier's retained percentage. The refund is what was paid, less that fee.
  - **Today's schedule, as percentages of the price** (the same money the deposit-based wording keeps today):

    | Product | Tier | Kept | Refunded |
    |---|---|---|---|
    | Day tour | 48 hours or more before | 0% | 100% |
    | Day tour | less than 48 hours, or no-show | 10% | 90% |
    | Package (cruise, multi-day) | 30 days or more | 0% | 100% |
    | Package | 29–15 days | 12.5% | 87.5% |
    | Package | 14 days or fewer, or no-show | 25% | 75% |

  - **Examples:** a €100 day tour canceled 24 hours before keeps €10 and refunds €90. A €900 cruise canceled 20 days before keeps €112.50 and refunds €787.50.
  - The build adds a `retainedPct` to each tier of `CANCELLATION_SCHEDULE`, so the Terms' mode C table is generated from the same numbers.
  - **How:** refunds are made by hand in Tab's dashboard, which supports partial refunds (section 4), and recorded in Sawa.
  - **What changes:** today `/refund` marks the whole payment refunded. Mode C records the **refunded amount**, and shows ops the computed fee before they refund. The phase 3 commission rule can then read whether a fee was actually kept.
- **A date that doesn't reach GoAhead:** nothing was paid, so nothing is refunded. The phase 2 cancellation notice already says "Nothing was charged".

### 9.4 Waitlist

- When a departure is full, travelers can join its waitlist: name, contact, seats wanted and the traveler details.
- When a seat is released:
  1. The first waitlisted traveler whose seats fit is emailed an offer: a booking link, held for them for a set time (suggested 12 hours, capped at the cut-off).
  2. If it isn't taken, the next one is offered it.
  3. After the waitlist, the seat goes back on general sale.
- A waitlisted traveler who books goes straight to the "pay now" path (9.1 step 7).
- Below full, a released seat simply goes back on sale, since anyone can book it. The waitlist matters for full departures (12 seats).

### 9.5 The operator manifest, and phases 2 and 3

- **Manifest before cut-off.** Paid seats and unpaid seats (marked "Payment due by …"), so the operator can plan for everyone booked.
- **Released seats (clause 10.1).** A seat released for non-payment is treated exactly like a cancellation before cut-off:
  - it is removed from the manifest;
  - the departure fee band is recalculated;
  - the operator isn't paid for it.

  The deadline is capped at the cut-off, so a release always happens before cut-off, and the frozen manifest holds only the seats that were paid (or are agency-billed).
- **At cut-off.** The manifest freezes with those seats only, and the operator is paid on it as in phase 2.
- **Below 4.** A departure that drops below 4 still runs (the guarantee). The operator is paid the 4–6 band plus the per-traveler amount for each traveler on the manifest at cut-off. `bandFor` already returns 4–6 for any count under 7, so this needs no new arithmetic.
- **The advance.** It was 50% of the expected amount at acknowledgement. If releases then shrink the manifest, the balance is smaller, or negative. A negative balance becomes a receivable, set off against the operator's next payment (phase 3, clause 9.4).

How the phase 2 and 3 rules change:

| Rule | Today (as built) | Under mode C |
|---|---|---|
| GoAhead counting | Counts every live booking, paid or not | **Unchanged.** Booked seats count at booking; payment is asked after. GoAhead is sticky after a release. |
| Rate-version lock (phase 2) | At the first seat sold (booking), by the `pledges` insert trigger | **Unchanged.** The first booked seat still fixes the rate the operator is paid on. A departure whose seats are all released keeps its locked version, which is harmless. |
| Agency commission lock (phase 3) | Locked at booking, EUR per seat | **Unchanged** (locked at booking) |
| When an agency seat "travels" | Earned when the departure completes and the booking is live | **Earned only if the seat was paid (or agency-billed and its invoice paid) and it traveled.** A seat released for non-payment has its commission voided, and its agency invoice voided. |
| Agency-billed seats | Count at booking; invoiced at booking, due after N days | Count at booking. **The invoice falls due at the mode C deadline after GoAhead** (decided), not N days after booking, so agencies never pay earlier than travelers. The agency's billing approval still decides whether it is invoiced at all. |
| "Standard agency seats count toward GoAhead only once the link is paid, with a 48-hour hold" (decided earlier, not built) | not built | **Superseded.** Under mode C every booking counts at booking, and nobody pays before GoAhead. |
| Operator advance (phase 3) | 50% of the expected amount at acknowledgement | **Unchanged.** It is 50% of the expected amount on booked seats. Releases shrink the final amount (clause 10.1), and any excess advance is set off (clause 9.4). |
| Margin report (phase 3) | EUR charged, by charge date | **Unchanged.** A departure that runs below 4 shows the guarantee's cost: the 4–6 band against fewer paying travelers. |

### 9.6 Code changes against the existing modules (not made)

- **Migration 051 (additive):**
  - `pledges.payment_mode` (`legacy_link` | `pay_at_goahead`), backfilled to `legacy_link`;
  - on `booking_payments`:
    - `reminder_sent_at`;
    - `original_due_at`, `extended_at`, `extended_by` and `extend_reason`;
    - `refunded_amount`;
    - `release_warned_at`;
  - `pledges_cancelled_reason_chk` gains `unpaid`. That is a new value for the `L-4` register: update `docs/audit/latent-defects.md` and its test;
  - a new `departure_waitlist` table: departure, contact, seats, details, position, offered_at, offer_expires_at, state;
  - a `finance_settings` key `pay_at_goahead_hours` (24 or 48).
- **`shared/payment-window.js`:** a mode C due-date function. It takes the window in hours, caps it at the cut-off, keeps the 24-hour floor, and records `boundBy` as `window`, `cutoff` or `minimum`. Traveler copy is generated from it, as today.
- **`server/payments.js`:** unchanged for legacy bookings. Mode C gets its own module, with the fee from a new `retainedPct` on each `CANCELLATION_SCHEDULE` tier: full price × retained percentage.
- **A new job, `server/jobs/pay-at-goahead.js`**, in the 15-minute tick and behind the flag:
  - the ops email listing links needed;
  - the halfway reminder, once;
  - the warning 2 hours before a release;
  - the release at the deadline;
  - the waitlist offer on a release, and expiring stale offers.
- **`server/app.js`:**
  - `POST /api/admin/bookings/:pledgeId/payment-links` sets the mode C deadline;
  - a new `POST /api/admin/payments/:id/extend`, with a required reason and an audit entry;
  - `POST /api/admin/payments/:id/refund` takes an amount;
  - the public booking route shows the pay-at-GoAhead terms line;
  - new public routes to join the waitlist and take an offer;
  - `/api/admin/payments` adds a per-departure paid and unpaid summary.
- **`server/email.js`:**
  - the link email states the deadline and says "your seat is released if unpaid by …";
  - new emails: the reminder, the release notice and the waitlist offer.
- **`server/assignments.js`:** `manifestRows` marks unpaid rows ("Payment due by …") before cut-off. Released rows are canceled bookings, so they drop out of the live manifest, and `freezeManifests` freezes only the remaining seats (clause 10.1).
- **`server/commissions.js`** (`decideCommissions`, `recordAgencyBooking`) **and `shared/settlement-rules.js`** (`commissionOutcome`): `unpaid` voids the commission and the agency invoice. The invoice due date moves to the mode C deadline (9.5).
- **UI:**
  - Admin → Payments shows, per departure, paid, awaiting, released and short-window seats, with an "extend" action;
  - the Calendar operator panel shows the counts;
  - the tour page and widget offer "join the waitlist" when full;
  - the operator manifest shows the new row marks.
- **Copy:**
  - the Terms' payment and cancellation sections: the full price is due within the window after GoAhead, and seats are released if unpaid;
  - the GoAhead promise page and the FAQ;
  - the booking confirmation and GoAhead emails, which today say "the deposit only falls due once this date reaches its minimum";
  - `shared/site-copy.js`.

  "Pay nothing until it goes ahead" stays.

### 9.7 Tests mode C needs

1. **Due date:**
   - 48 hours;
   - capped at the cut-off;
   - the 24-hour floor;
   - "short window" when GoAhead is near the cut-off;
   - the traveler copy matches the stored deadline.
2. **At GoAhead:**
   - exactly one "link needed" per live booking;
   - agency-billed bookings go to the agency, for the invoice amount;
   - none for canceled bookings.
3. **Reminder:** sent once, at the halfway point, and never after payment.
4. **Release at the deadline:**
   - the booking is canceled as `unpaid`, and the traveler is emailed;
   - the departure stays `go_ahead` / `minimum_reached` when it drops below 4;
   - a paid booking is never released;
   - a payment marked after the warning and before the deadline stops the release.
5. **Extension:**
   - the original deadline is kept, and an audit row is written;
   - the release follows the new deadline;
   - a reason is required.
6. **Waitlist:**
   - the offer order and offer expiry;
   - the seat goes back on sale after the waitlist;
   - a waitlisted booking goes straight to "pay now".
7. **Manifest and operator pay (clause 10.1):**
   - before cut-off the manifest shows paid seats, and unpaid ones as "Payment due by …";
   - a released seat is removed from the manifest, and the band is recalculated;
   - the operator isn't paid for a released seat;
   - at cut-off the frozen manifest holds manifest seats only.
8. **Guarantee below 4:**
   - releases take the departure to 2 travelers, and it stays going ahead;
   - the operator is paid the 4–6 band plus 2 × the per-traveler amount;
   - an advance paid on 8 travelers becomes a receivable and is set off.
9. **Commission:**
   - void on `unpaid`;
   - earned when paid and traveled;
   - an agency-billed invoice falls due at the mode C deadline and is voided on release.
10. **Refunds:** full price × the tier's retained percentage, for day tours and for packages; a partial refund is recorded with its amount.
11. **Flag off, or a legacy departure:** the existing deposit and balance link flow is unchanged, and the current `server/payments.test.js` passes as is.

---

## 10. Provider comparison

Every cell cites the provider's own page and is **unconfirmed**: no provider site could be read from here (see the top of this document). Two kinds of source were read directly and are marked:
- "(read: Paymob GitHub)": Paymob's own repository;
- "(third-party)": a third-party profile.

"—" means nothing was found. Confirm every cell with the provider in writing before deciding.

### Can an Egypt-based company hold a Stripe account?

**No, per Stripe's availability list** as summarized by search ([stripe.com/global](https://stripe.com/global), unconfirmed). Egypt is not among the supported countries, and third-party guides agree.

Stripe's own rule is that an account needs a legal entity, tax ID, address and bank account in a supported country ([Stripe Support: requirements to open an account in another country](https://support.stripe.com/questions/requirements-to-open-a-stripe-account-in-another-country), unconfirmed). So Stripe is possible only through a company incorporated abroad. That company, not Online Era, would be the one collecting the money, which is a question for the lawyer, not a configuration.

The Stripe column below describes Stripe's product in general and applies only on that route.

| Question | Tab | Paymob | Kashier | Geidea | Stripe (only via a non-Egyptian company) |
|---|---|---|---|---|---|
| **Server API and webhooks** | No public API found. Integrations are via booking engines and a "Checkout Flow" widget, "no developer needed" ([Integrations](https://business.tab.travel/features/integrations?cc=us)). Webhooks: — | **Yes.** The Intention API creates payments ([APIs](https://developers.paymob.com/paymob-docs/integration-paths/apis)). A server-to-server "Transaction Processed Callback", signed with HMAC-SHA512 ([Webhook callbacks and HMAC](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac)). A "V2 QuickLink API" for payment links and a Transaction Inquiry API (read: [Paymob GitHub](https://github.com/PaymobAccept/API-Postman-Collections)). | **Yes.** A REST API, with payment sessions that take an `expireAt` ([Payment sessions](https://developers.kashier.io/docs/accept-payments/payment-sessions)). Webhooks for payment and refund events ([Webhook](https://developers.kashier.io/payment/webhook/)). | **Yes.** Hosted checkout and a Direct API; Pay by Link APIs ([Pay by Link APIs](https://docs.geidea.net/docs/pay-by-link-apis)); callback notifications ([Webhook/Callback notifications](https://docs.geidea.net/docs/sample-callback-responses)). | Yes: the general Stripe product ([docs.stripe.com/webhooks](https://docs.stripe.com/webhooks), unconfirmed) |
| **Save a card with consent; charge off-session days or weeks later (mode A)** | "Charge saved cards and OTA VCCs" is advertised ([Take payments in advance](https://business.tab.travel/features/in-advance)), but no API was found to save a card on our checkout and charge it later. **Pre-authorization: no** ([Can I pre-authorise cards with Tab?](https://support.tab.travel/en/articles/9337040-can-i-pre-authorise-cards-with-tab)). | **Yes, as described.** "Pay with saved card", with customer-initiated (CIT) and merchant-initiated (MIT) transactions (read: [Paymob GitHub](https://github.com/PaymobAccept/API-Postman-Collections); also [third-party profile](https://github.com/api-evangelist/paymob)). Whether an unscheduled MIT days or weeks later suits this use: confirm. | Cards can be saved at payment and paid with later by token; recurring payments via subscriptions ([Developers](https://developers.kashier.io/), [Subscriptions](https://www.kashier.io/en/payment-acceptance/subscriptions)). Unscheduled merchant-initiated charges: — | **Yes.** Tokenization with the cardholder's consent, then MIT with `agreementType` "Unscheduled" ([Tokenization](https://docs.geidea.net/docs/tokenization), [Merchant Initiated](https://docs.geidea.net/docs/merchant-initiated-mit)) | Yes: SetupIntents, then off-session PaymentIntents ([docs.stripe.com/payments/save-and-reuse](https://docs.stripe.com/payments/save-and-reuse), unconfirmed) |
| **Charge at booking, with automatic refund by API (mode B)** | Charging at booking works by link or widget. Refund by API: —. Refunds are made from the dashboard ([How can I refund my customer?](https://support.tab.travel/en/articles/836712-how-can-i-refund-my-customer)). | **Yes:** a Refund API, and Void for same-day payments before settlement ([Refund](https://docs.paymob.com/docs/refund-transaction), [Void](https://developers.paymob.com/paymob-docs/developers/manage-payment-apis/void)) | **Yes:** refund by API, `PUT /v3/orders/:orderId` ([Refunds](https://developers.kashier.io/docs/accept-payments/refunds)) | **Yes:** a Refund API ([Refund](https://docs.geidea.net/docs/refund-2)) | Yes ([docs.stripe.com/refunds](https://docs.stripe.com/refunds), unconfirmed) |
| **Partial refunds** | Yes, from the dashboard ([How can I refund my customer?](https://support.tab.travel/en/articles/836712-how-can-i-refund-my-customer)) | Yes: "full or partial reversal" ([Refund](https://docs.paymob.com/docs/refund-transaction)) | Yes: leave out the amount for a full refund, send it for a partial one, never more than the original ([Refunds](https://developers.kashier.io/docs/accept-payments/refunds)) | Yes, full or partial, and more than once per payment ([Refund](https://docs.geidea.net/docs/refund-2)) | Yes (unconfirmed) |
| **Accept EUR cards** | Likely: "100+ currencies", and guests pay in their own currency ([Pricing](https://business.tab.travel/pricing?cc=us)). EUR isn't named. | International cards, yes. EUR pricing and settlement are "on inquiry" (third-party summaries only). | Yes: "EGP, USD, EURO and GBP", with international Visa and Mastercard ([FAQs](https://www.kashier.io/en/faqs)) | "180+ currencies", with international Visa and Mastercard ([Payment gateway, Egypt](https://www.geidea.net/egy/en/solutions/payments/payment-gateway)) | Yes (unconfirmed) |
| **Pay out to an Egyptian bank account** | Yes: "free payouts to bank accounts in Egyptian Pounds, USD or any other major currency", to all major Egyptian banks ([Tab in Egypt](https://business.tab.travel/global-coverage/egypt)) | Yes. An Egyptian acquirer settling in EGP; USD and other currencies are mentioned (third-party). It serves merchants in Egypt, KSA, UAE, Oman and Pakistan ([third-party profile](https://github.com/api-evangelist/paymob)). | Yes: to the bank account or wallet after 3 working days, and **for Egypt-based businesses only** ([FAQs](https://www.kashier.io/en/faqs)) | Yes: an Egyptian gateway ([geidea.net/egy](https://www.geidea.net/egy/en/solutions/payments/payment-gateway)); settlement terms per merchant | **No:** no Egyptian accounts (above) |
| **The fee, and whether the merchant can absorb it** | Travelers pay **4%**. Businesses pay 2.6–5.9% on international cards ([What are the fees?](https://support.tab.travel/en/articles/836715-what-are-the-fees)). **Whether the merchant can pay the 4% instead of the traveler: not found.** Tab presents it as the traveler's fee, and no merchant-paid option was found. Ask Tab. | The merchant pays: 2.75–2.85% plus a small fixed amount on local cards; international is negotiated (third-party summaries, not from Paymob) | The merchant pays: 2.75% plus EGP 3 per transaction ([FAQs](https://www.kashier.io/en/faqs)). International rates: — | The merchant pays; quoted per merchant, not published (search summaries) | The merchant pays (general) |

### What the table suggests, to confirm with the providers

- **The three Egyptian gateways (Paymob, Kashier and Geidea) document the APIs Tab lacks:** payment links by API, webhooks and refunds by API. Any of them would make mode C's two manual steps ("make the link", "know it was paid") automatic.
- **Paymob and Geidea could also support mode A,** subject to the lawyer's Q3: both document saved cards with merchant-initiated charges. For Kashier, only recurring use of saved cards is documented; unscheduled charges are unconfirmed.
- **With all three the merchant pays the fee.** No traveler surcharge is described, which fits "Sawa's price is the price the traveler pays". With Tab the 4% traveler fee is the open question.
- **For each gateway, ask:**
  - whether an Egyptian company can accept EUR and settle it, and the international-card rate;
  - how SCA and 3-D Secure behave for EU cards on a saved-card charge;
  - who is merchant of record.
