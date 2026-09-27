# Rehearsal: one complete catalog departure on staging

A dry run of pay at GoAhead from booking to the agency's commission statement, on **staging**, with a real person in each role. One small real payment and one real refund go through Tab; every other payment is marked paid by hand with a `REHEARSAL-` reference, so no other money moves.

It takes about a week of calendar time, because GoAhead, deadlines, the cut-off and the tour itself happen on real clocks. The active steps take about an hour a day. Finish it, with every check ticked, before `catalogue_v2` goes on in production (runbook step 9).

## The cast

| Role | Who | Logs in as | Uses |
|---|---|---|---|
| T1 | traveler, 5 seats, pays (marked paid) | none: the public site | an email inbox and phone they can read |
| T2 | traveler, 3 seats, **does not pay** | none | inbox |
| T3 | the agency's client, 2 seats, pays (marked paid) | none | inbox |
| T4 | traveler, 2 seats, **pays for real**, then **cancels late** | none | inbox, a real card |
| W | a waitlisted traveler, 3 seats (any team member) | none | inbox |
| Agency | a test agency's owner | agency portal (`/agency`) | inbox |
| Operator | a test operator's owner | operator portal (`/portal`) | inbox |
| Ops | ops staff | admin (`/admin`) | Tab dashboard (staging or the real account: see 0.4) |
| Finance | super admin | admin | bank app, to note transfers (none are made) |

Use real inboxes. Every email in this rehearsal goes to someone in the cast.

## 0. Set up staging (ops and finance, the day before)

1. **Staging runs main's build.** It has its own database, never production's. Apply migrations 047–052 there, following the runbook's step 1 checks.
2. **Settings on the staging web service:**
   - `FEATURES=catalogue_v2`;
   - `ENABLE_JOB_SCHEDULER=1` and `CANCEL_JOB_DRY_RUN=0`, so the jobs run as in production;
   - `RESEND_API_KEY` set, with `APP_URL` at the staging URL, so links in emails open staging;
   - `EMAIL_REPLY_TO` = the ops inbox.
   - Check: `/api/modes` shows scheduler on and email live, and the boot log says `catalogue_v2 is ON`.
3. **The departure.** Pick one day tour (for example #1 Giza):
   - publish its spec and a rate version (runbook steps 2–3). Use real-looking amounts, e.g. 2,200 EGP a traveler and fees 1,500 / 2,000 / 2,600;
   - set its listing's price to **€1 a seat**, so T4's real payment is €2;
   - generate departures and choose one about **6 days out**: D is the tour date, and the cut-off is D − 48 h.
   - Check: Admin → Calendar lists it, open, 0 of 4.
4. **Tab.** Decide whether the rehearsal uses Tab's real account (T4's €2 is real money, refunded in step 6) or a Tab test account if Tab offers one. Either way, only T4's link takes a card.
5. **Operator:**
   - create it with its four documents, approve it for the product, and set it active;
   - enter and verify its bank details;
   - give its owner a login;
   - roster it for D and publish the month.
   - Check: Admin → Operators shows it active, approved and verified; Admin → Roster shows the month published.
6. **Agency:** a test agency with an owner login, **not** on billing (so T3 pays through a link), with commission on the rate card.
7. **Finance:**
   - today's EGP rate (e.g. 55);
   - payment window **24 hours**, to keep the rehearsal short (Admin → Finance → Pay at GoAhead → Settings);
   - waitlist hold 12 hours.
   - Check: Admin → Finance → Tiers and Terms shows tier version 1 in force, catalog Terms version 1 in force, and the loss check. At 2,200 EGP and 55, 10% of €1 loses money, so expect a warning: that is correct.

## 1. Booking to GoAhead (day 1)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 1.1 | T1 | Book 5 seats on D from the tour page, with every traveler's details. | The confirmation email says nothing was charged, states the price, and lists the tiers "cancellation terms v1". `/booking/CODE` shows "Nothing to pay yet" and the terms. Five seats reach the minimum of 4: within 15 minutes Admin → Calendar shows the date **Going ahead**. |
| 1.2 | Ops | Nothing. | Admin → Finance → Pay at GoAhead: D is listed, T1's seat reads "Link to make". **To do in Tab** has "Make a Tab link for €5, reference CODE". The ops inbox has "1 payment link to make in Tab". |
| 1.3 | T2 | Book 3 seats. | Same confirmation. A new task appears for ops, and one ops email covers it. |
| 1.4 | Agency | In the agency portal, book 2 seats for T3, with T3's email. | The booking has a code. Admin → Bookings shows it, agency-made. The database records tier and Terms versions from this moment: `SELECT cancellation_tier_version_id, terms_version_id, terms_fixed_by FROM pledges WHERE booking_code = 'CODE'` → `agency`. |
| 1.5 | T4 | Book 2 seats. | The departure now has 12 of 12. The tour page shows the date as full and offers **Join the waitlist**. |
| 1.6 | W | Join the waitlist for 3 seats. | "You're on the waitlist (number 1)". |
| 1.7 | Operator | Log in to `/portal` → Assignments. | An assignment for D; the email arrived. **Acknowledge** within 12 hours. Admin → Finance → Owed and paid: the operator advance appears, 50% of the expected amount (12 travelers, fee 10–12), due 2 Egyptian business days out. |

## 2. Tab links and payments (day 1–2)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 2.1 | Ops | For each task, make a Tab link for the amount with the booking code as its reference, and paste it into **Send link**. Leave T2's link unsent for 6 hours first. | T2 gets no email yet. After 6 hours, ops **and** finance (super admin) get "Alert: 1 payment link not made 6h after GoAhead". The admin home and Finance show "1 unpaid seat… with no payment link". Then send T2's link. |
| 2.2 | T1, T3, T4 | Open the payment emails. | Each shows €amount and a deadline 24 hours after the link, which matches `/booking/CODE`. **T3's email and page ask T3 to accept the cancellation terms the agency booked under.** T3 clicks **I accept these terms**, and the page shows "Accepted". |
| 2.3 | T4 | **Pay the real €2** through the Tab link. | Tab's dashboard shows the payment with the booking code as reference. |
| 2.4 | Ops | Mark T4 paid with **Tab's own reference**. Mark T1 and T3 paid with `REHEARSAL-T1` and `REHEARSAL-T3`. | Pay at GoAhead shows 9 paid, 3 awaiting (T2). The operator's manifest in `/portal` shows "Paid" beside T1, T3, T4 and "Payment due by …" beside T2. |
| 2.5 | T2 | Do nothing. | At halfway (12 hours), T2 gets one reminder. 2 hours before the deadline, ops get "3 seats will be released in 2 hours unless paid". |

## 3. Release for non-payment and a waitlist resale (day 2–3)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 3.1 | nobody | The deadline passes. | Within 15 minutes, T2 gets "Your seat … was released". Admin: T2 reads "Released (unpaid)"; Pay at GoAhead counts released 3. Admin → Calendar: the date is still **Going ahead**. The operator's manifest no longer lists T2's travelers, and the expected amount (Admin → Operators → departure) is for 9 (fee 7–9). |
| 3.2 | W | The waitlist offer arrives ("3 seats have opened up… held until …", 12 hours). Open it and book, with the travelers' details. | The booking page shows a new code. The date is back to 12 of 12. Within 15 minutes ops get a new "link to make" for W. |
| 3.3 | Ops | Make and send W's link; mark it paid `REHEARSAL-W`. | W's seats read "Paid". |
| 3.4 | Ops | Try **Mark paid** on T2's released request. | Refused: "reinstate the booking first". Leave it released. |

## 4. The cut-off and the manifest (D − 48 h)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 4.1 | nobody | The cut-off passes. | The tour page no longer offers D. The admin manifest (Admin → Operators → the departure → Manifest) says **frozen**, with 12 travelers (T1 5, T3 2, T4 2, W 3) and no payment marks. |
| 4.2 | Operator | Open the manifest in `/portal`. | The same 12, names, pickups and safety needs. The view is logged. |
| 4.3 | Finance | Admin → Finance → Margin, for D. | Charged is €12: T4's real €2, plus the `REHEARSAL-` payments (T1 €5, T3 €2, W €3), which count as payments too. The operator amount is in EGP at the day's rate, and the loss warning for "less than 48 hours" is shown. |

## 5. A late cancellation with a real refund (D − 24 h)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 5.1 | T4 | Ask to cancel, by replying to the confirmation email. | The public cancel button refuses after GoAhead and points to the Terms; that is correct. |
| 5.2 | Ops | Admin → Finance → Pay at GoAhead → T4 → **Cancel…**, reason "The traveler". | Before confirming, the dialog shows terms v1, about 24 hours before the start, 10% kept: €0.20 fee, **€1.80 refund** of €2 paid. Confirm. A task appears: "Refund €1.80 in Tab for CODE". |
| 5.3 | Ops | In Tab's dashboard, refund **€1.80** of T4's payment. Record Tab's refund reference on the task (**Refund made**). | T4's card is refunded €1.80. Finance → Pay at GoAhead → Refunds shows it done with Tab's reference. The frozen manifest still lists T4: after the cut-off the operator is paid for the seat (clause 10.2). |

## 6. The tour, and the departure completed (D)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 6.1 | Operator | Run the tour (or confirm it would), and note any issue for the statement. | — |
| 6.2 | nobody | The day after D. | Admin → Calendar: the departure is **Completed** within 15 minutes of its end. |

## 7. Settlement: the advance, the balance and the statement (D + 1 to D + 7)

| # | Who | Do | Check, and where |
|---|---|---|---|
| 7.1 | Finance | Admin → Finance → Owed and paid → the operator's advance → **Record payment**: the amount, today's date, reference `REHEARSAL-ADV`. | It reads Paid. It's refused if the bank details aren't verified; that's a check in itself. |
| 7.2 | nobody | After completion. | A **balance** appears: the final amount from the frozen manifest (12 travelers: 12 × per traveler + the 10–12 fee), less the advance, due 7 days after D. |
| 7.3 | Finance | Admin → Operators → the departure → Settlement: check the lines, then **Send statement**. | The operator gets the email. `/portal` → Statements shows it, and the PDF downloads and matches. |
| 7.4 | Operator | Open the statement; don't dispute it. | It stays "sent"; it would be accepted automatically after 30 days. |
| 7.5 | Finance | Record the balance payment, reference `REHEARSAL-BAL`. | Paid; nothing overdue on the admin home. |

## 8. The agency commission statement

| # | Who | Do | Check, and where |
|---|---|---|---|
| 8.1 | nobody | The commission is decided after completion. | Admin → Finance → Agency commission: T3's seats **earned** (paid and traveled), 2 × the rate card's EUR commission. |
| 8.2 | Finance | Build the statement now: `POST /api/admin/commission-statements/rebuild` with the agency and D's month. | A draft with T3's line and the total. |
| 8.3 | Agency | By the 10th of the next month, the daily job sends the statement. | The agency owner's email, and the agency portal's commission page, show the month's statement. |
| 8.4 | Finance | Record its payment (`REHEARSAL-COM`). | Paid. |

## 9. After the rehearsal

- [ ] Every check above ticked, with a note of anything that surprised a cast member.
- [ ] T4's refund arrived on the card; the amounts in Tab and in Sawa agree.
- [ ] Admin → Audit shows each staff action: links, payments, the cancellation, the refund, the statement.
- [ ] Nothing reached anyone outside the cast (check the email log).
- [ ] Clean up staging, or keep it as the reference for the next rehearsal.

**Paths this rehearsal doesn't cover**, with automated tests only (`server/pay-at-goahead.integration.test.js`):
- a link never made until 24 hours before the cut-off, and the three admin decisions;
- a link made too late (under 12 hours);
- an agency-billed invoice;
- extending a deadline.

Add any of them to a second rehearsal if ops want to practise.
