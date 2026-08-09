# U3 — What actually happens to money

**8 August 2026.** Factual investigation. **No copy changed.**

---

## U3.1 — The product fact

**No money moves at any point in the current system. There is no payment
integration at all.**

| Question | Answer | Evidence |
|---|---|---|
| Is money **taken** at reservation? | **No** | No payment gateway exists |
| Is money **authorized** or **held**? | **No** | No authorization code path anywhere |
| Is a **card stored**? | **No** | No card field is ever collected |
| Is there a **deposit**? | **A calculated figure, not a transaction** | `deposit_due` is arithmetic |

### 1. No payment provider is installed

Full dependency list: `@supabase/supabase-js`, `@tiptap/*`, `@vitejs/plugin-react`,
`concurrently`, `dotenv`, `express`, `express-rate-limit`, `helmet`,
`lucide-react`, `pg`, `playwright-core`, `react`, `react-dom`, `sanitize-html`,
`vite`, `zod`.

No Stripe, PayPal, Paymob, Fawry, Checkout.com, Braintree or Adyen. No
`payment_intent`, `charge`, `capture` or `authorize` anywhere in the codebase.

### 2. The booking endpoint cannot take a payment

`POST /api/public/departures/:id/bookings` validates against
`publicBookingSchema`, which accepts exactly:

```
customerName, customerEmail, customerPhone, seats,
roomingType, accommodationTier, refCode
```

**There is no card field, no payment token, no payment method.** A traveller
could not pay at reservation if they wanted to.

### 3. The database records amounts, not transactions

`pledges` holds `price_per_person`, `booking_total`, `deposit_percent`,
`deposit_due`, `balance_due`, `balance_due_date`.

Every one is a **computed figure**. There is no `paid` flag, no
`payment_status`, no `transaction_id`, no `refunded_at`. The only `paid` in the
schema is a value of the *departure* status enum, describing an operational
state, not a receipt.

### 4. It is a documented open decision

`docs/STATUS.md:29`, under "Open product decisions":

> **7. Online payments (deposits shown, not collected).**

So this is known and intended. Deposits are quoted on the site and settled off
the platform.

---

## U3.2 — What this means, and the recommendation

### "Reserve free" is TRUE

Every phrasing of it is accurate — "no charge until GoAhead", "you pay nothing",
"$0 USD charged until your trip is confirmed". Nothing is taken. It is, if
anything, **understated**: nothing is taken at GoAhead either, because there is
no mechanism to take it.

### The refund promise is not false — it is vacuous, and it weakens the true claim

> `/how-it-works` — "**100% refunded** if a date never confirms"

A date that never confirms never reaches GoAhead, so no deposit ever falls due,
so nothing was ever charged. The sentence promises the return of money that by
definition was never taken.

The damage is not inaccuracy, it is **framing**: a refund promise tells the
reader their money was at risk and will be given back. Sawa's actual position is
stronger — the money never left. Offering a refund invites the question "so when
were you holding my money?", and the answer is "never".

### 🔴 The serious one: a mechanism that does not exist

Three places describe a **card authorisation hold**:

| Where | Claim |
|---|---|
| `/goahead-promise` hero | "you pay nothing — and **any hold is released in full**" |
| `/goahead-promise` step 04 | "any hold is released in full **within your bank's normal window**" |
| `/goahead-promise`, `/faq` | "**Any authorisation hold is released in full by your bank**" |

This is a different class from the rest of the audit. It is not vague marketing —
it is a **specific, mechanical, falsifiable statement about the reader's bank
account**. It tells them an authorisation was placed and will drop off.

No authorisation is ever placed. No card is ever collected. A traveller who
checks their statement for a pending hold will find nothing, and a traveller who
believes funds are held may plan around money that was never encumbered.

Adjacent, same family:

> `/how-it-works` — "Money is **only released to the operator** once the
> departure reaches GoAhead"

This describes escrow. No money is held, so none is released.

### Recommendation

**Remove the refund and hold language; keep and strengthen "reserve free".**

The true story is simpler and better than what is written: *you are not charged
at any point before your date is confirmed, and there is nothing to refund
because nothing is taken.*

Specifically:

1. **Delete the three authorisation-hold sentences.** These are the priority.
   They describe a banking mechanism that does not exist.
2. **Delete or rewrite "100% refunded if a date never confirms"** and "Full
   refund if a date never confirms" — replace with a statement that nothing is
   charged, not that something is returned.
3. **Rewrite "money is only released to the operator"** — no funds are held.
4. **Leave the cancellation email alone.** It says "**If** you were charged
   anything for this booking, it is refunded in full" — conditional, and
   therefore true in both worlds. That is the right shape.
5. **Leave `/terms` alone.** Its refund language governs the deposit once
   payments exist, and is written as conditions rather than promises.

### The question this raises for the client

The gap is not really copy. It is that the site describes a payment flow the
product does not yet have — deposits that fall due, balances before travel,
money released at GoAhead — none of which any code performs.

**Before the blog launches:** is the deposit currently collected off-platform,
by transfer or WhatsApp, after GoAhead? If yes, some of this copy is describing
a real manual process and needs rewording rather than deleting. If no — if no
money has ever changed hands — then the whole payment narrative is describing a
future product, and that is a larger editorial decision than this task.

**Nothing changed. Awaiting your decision.**

---

## Found while investigating — a group-size error the numeric sweep missed

`/how-it-works` renders:

> "Reserve a seat — no charge until GoAhead · **Travel in a group of 4–8** with
> one guide"

The ceiling is **twelve**, not eight. This contradicts `MAX_GROUP_SIZE`, the
booking conditions and the database CHECK constraint.

*Correction:* I first reported this as contradicting the "Never more than
twelve. Ever." line "on the same page". It does not — P1.3 put that line on the
homepage's how-it-works *section*, the GoAhead explainer and the product pages,
not on the `/how-it-works` page itself. The contradiction with the constant and
the constraint stands; the one with the adjacent sentence was mine.

`sync-constants.js` did not catch it: its range rule requires the word
"travellers" after the numbers (`4–12 travellers`), and this reads "group of
4–8 with one guide". A rule written for one phrasing.

Reported rather than fixed, as it is a numeric claim rather than a wording
choice — but this one is unambiguous and I would take it.


---

# V1 — authorization-hold copy removed (8 August 2026)

## V1.1 — six instances, not three

My U3 report said three. The sweep found **six**, and two were worse than
reported — they did not merely describe a hold being released, they said Sawa
**places one to verify the reader's card**:

| Where | Was |
|---|---|
| `/faq` (when am I charged) | "we may place a temporary **authorisation hold to verify your card**" |
| `/faq` (group never fills) | "**Any hold is released in full by your bank**" |
| `/goahead-promise` hero | "you pay nothing — and **any hold is released in full**" |
| `/goahead-promise` step 01 | "We may place a temporary **authorisation hold to confirm the card is valid**" |
| `/goahead-promise` step 04 | "any hold is released in full **within your bank's normal window**" |
| `/goahead-promise` FAQ | "**Any authorisation hold is released in full by your bank**" |

All six now carry the approved minimum — "No card is charged and no hold is
placed" — with the second clause included as instructed, so the assumption the
old copy created is closed rather than left open.

## The Terms already said so

`site/terms.html` carries an HTML comment, not rendered, above section 6:

> "Accurate to the current build: reserving takes contact details only. No card
> is requested, no processor is integrated and no authorisation hold is placed.
> Rewrite this section and section 12 together on the day payments go live."

So the legal page was written correctly and knew the truth. **The marketing
pages contradicted the Terms**, which is the reverse of the usual direction and
means the fix was available in-repo the whole time.

## V1.2 — the claim class, swept

`audit-claims.js` gains a `phantom-payment-process` rule covering holds,
authorizations, pre-authorizations, "released by your bank", "your bank may
show", pending charges, statement descriptors, chargebacks and refund timelines.
Proved to fire on all six removed strings and on unseen variants ("your bank may
show a pending charge", "raise a chargeback"), and to stay silent on the CORS
`Authorization` header, "unauthorised use" and "authorised adult".

Across all rendered routes, bundles, database columns and machine-readable
files, **two hits remain, both in `/terms`**:

> "Refunds, where due, are returned to the **original payment method** within
> **14 business days** of our confirming the refundable amount"

Left in place per the U3 recommendation you accepted: Terms language governs the
deposit once payments exist and is written as conditions rather than promises.
Flagged here because it will read oddly until then.

`server/email.js` has one, and it is the right shape: "**If** you were charged
anything for this booking, it is refunded in full."

## V1.3 — every deposit display (reported, not changed)

Blocked on the client's answer about what happens after GoAhead.

| Where | What it says |
|---|---|
| `/` step 03 | "payment begin — a **deposit at GoAhead**, the balance before you travel" |
| **`/faq`** | "the date locks, **everyone's deposit is charged**, and the tour is confirmed" |
| `/goahead-promise` hero | "a **deposit then**, the balance before you travel" |
| `/goahead-promise` step 02 | "your **deposit falls due** — not a minute before" |
| `/goahead-promise` step 03 | "a deposit on the per-person price — **typically 10% on a day tour**" |
| `/terms` §11 | "day tours require a **10% deposit** at GoAhead; multi-day tours **20%**; the remaining balance is due the day before departure" |
| Product pages (SPA) | `depositDue` / `balanceDue` rendered per booking from `computePledgePricing` |
| Booking confirmation email | `depositDue` and `balanceDue` amounts |

**The sharpest is `/faq`.** "Everyone's deposit **is charged**" is present tense
and unconditional — it states that money moves at GoAhead. Nothing charges it.
That is the same class as the hold copy, not the same class as a schedule in the
Terms, and I would treat it as urgent once the answer below lands.

`src/main.jsx` (35 references), `server/domain.js` (17), `server/app.js` (34) and
`server/email.js` (7) all compute and display deposit figures. They are
arithmetic on a real price, so they are not false — they describe an amount that
would be due. Whether they should render at all depends entirely on the answer.
