// Pure business rules: pricing, status, deposits. No DB, no HTTP — easy to test.
import { zonedDateTimeToUtc } from "./tz.js";
import { isoDate } from "./db/mappers.js";
// The deposit rates, the balance timing, the type predicate and the
// cancellation bands are ONE policy and live in shared/, where the browser
// bundle and check:duplication can both see them. `isPackage` and
// `balanceDueDate` were declared here AND in src/main.jsx — the second of
// those two returning a different type under the same name.
import {
  isPackage, balanceDueDate, depositPctFor,
  DAY_TOUR_DEPOSIT_PCT, PACKAGE_DEPOSIT_PCT,
} from "../shared/booking-policy.js";

// Re-exported so `import { isPackage } from "./domain.js"` keeps working
// everywhere it is already written — the same courtesy domain.js already does
// for the group-size constants.
export { isPackage, balanceDueDate, depositPctFor } from "../shared/booking-policy.js";

// Kept under their old names: these were the published rates and several
// tests and modules name them. The PACKAGE rate moved 20 -> 25 on 13 Aug 2026.
export const DEFAULT_DAY_TOUR_DEPOSIT = DAY_TOUR_DEPOSIT_PCT;
export const DEFAULT_PACKAGE_DEPOSIT = PACKAGE_DEPOSIT_PCT;

// The booking conditions say "every Sawa departure runs with a minimum of 4 and
// a maximum of 12 travelers", and the how-it-works page says the same. That is
// a term of the contract, not a default, so nothing may publish a date that
// exceeds it — and a listing may require MORE than four (the card shows "2 of 6
// joined", so nothing is hidden) but never fewer.
//
// Both now come from shared/group-size.js and are re-exported here, so every
// existing `import { MAX_GROUP_SIZE } from "./domain.js"` keeps working. They
// moved because the React app could not import this module — domain.js imports
// tz.js, tz.js reads process.env, and the browser has no process — so the SPA
// carried its own copy of the number and the two were free to drift apart.
export { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE } from "../shared/group-size.js";

// NN2.1 — the board rules moved to shared/departure-state.js and are re-exported
// here, so every `import { seatsTotal } from "./domain.js"` keeps working. They
// moved for the same reason the constants did: the React app and the three
// static pages each carried a hand-written copy, the copies had already
// diverged three ways, and nothing compared them.
export {
  goAheadSeatsFor, seatsTotal, statusFor, isFormingDeparture, isGoAheadDeparture,
} from "../shared/departure-state.js";
import { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE, numberWord } from "../shared/group-size.js";
import { goAheadSeatsFor, seatsTotal, statusFor } from "../shared/departure-state.js";
// One pricing implementation, in shared/, because the price shown and the price
// charged were two copies guarded by a comment saying they must agree.
// Re-exported so existing importers of server/domain.js are unaffected.
import { clampPrice, priceFromTiers, livePriceFor } from "../shared/pricing.js";
export { clampPrice, priceFromTiers, livePriceFor };

// MIN_GROUP_SIZE is the floor a listing may not go below, which is the same
// number as the default threshold. Named separately because they mean different
// things: one is what a date confirms at unless told otherwise, the other is
// what no date may confirm below.
export const MIN_GROUP_SIZE = DEFAULT_GO_AHEAD;

// Returns an error string, or null when the capacity is publishable.
export function capacityError(minSeats, maxSeats) {
  const min = Number(minSeats);
  const max = Number(maxSeats);
  if (!Number.isInteger(min)) return "Minimum group size must be a whole number.";
  if (min < MIN_GROUP_SIZE) {
    return `Minimum group size is ${MIN_GROUP_SIZE} travellers — that is what the booking conditions promise a departure confirms at. Set ${min} higher, or change the terms first.`;
  }
  if (!Number.isInteger(max) || max < 1) return "Maximum group size must be a whole number of at least 1.";
  if (max > MAX_GROUP_SIZE) {
    return `Maximum group size is ${MAX_GROUP_SIZE} travellers — that is the limit stated in the booking conditions. Set ${max} lower, or change the terms first.`;
  }
  if (max < min) return `Maximum group size (${max}) cannot be below the minimum (${min}).`;
  return null;
}

// How long before departure a date must have reached its minimum, or it is
// cancelled. Packages get 30 days because travellers book flights around them
// and operators hold hotels and boats; day tours get 7 because the travellers
// are usually already in Egypt and a longer window would kill dates that would
// have filled. Overridable per listing via tour_products.confirm_deadline_days.
export const DEFAULT_PACKAGE_CONFIRM_DEADLINE_DAYS = 30;
export const DEFAULT_DAY_TOUR_CONFIRM_DEADLINE_DAYS = 7;

export function defaultDepositFor(item) {
  return depositPctFor(item);
}




// Validates an operator-supplied table. Returns { tiers } or { error }.
//
// The rules exist because a bad table is a mispriced booking, and the server
// charges what this returns.
export function validatePriceTiers(raw, { minSeats, maxSeats } = {}) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return { tiers: null };
  if (!Array.isArray(raw)) return { error: "Price table must be a list of { seats, price } rows." };

  const min = Math.max(1, Number(minSeats) || DEFAULT_GO_AHEAD);
  const max = Math.max(min, Number(maxSeats) || min);
  const rows = [];
  for (const t of raw) {
    const seats = Number(t?.seats);
    const price = Number(t?.price);
    if (!Number.isInteger(seats)) return { error: `Group size "${t?.seats}" must be a whole number.` };
    if (seats < min || seats > max) return { error: `Group size ${seats} is outside this tour's ${min}–${max} range.` };
    if (!Number.isFinite(price) || price <= 0) return { error: `Price for ${seats} travellers must be greater than zero.` };
    if (rows.some((r) => r.seats === seats)) return { error: `Group size ${seats} appears twice.` };
    rows.push({ seats, price: Math.round(price) });
  }
  rows.sort((a, b) => a.seats - b.seats);

  // The whole promise is that the price falls as the group grows. A table that
  // rose would contradict every page on the site and surprise travellers who
  // recruited someone else specifically to bring the price down.
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].price > rows[i - 1].price) {
      return { error: `Price rises from ${rows[i - 1].seats} to ${rows[i].seats} travellers. It must never go up as the group grows.` };
    }
  }
  // Without a row at the minimum there is no defined GoAhead price, and the
  // first booking would silently pay a larger group's rate.
  if (rows[0].seats !== min) {
    return { error: `The table must start at ${min} travellers — that is the group size a date confirms at.` };
  }
  return { tiers: rows };
}

// A departure carries its own copy of the rates, but the price table lives on
// the listing. Merges it in so pricing reads one object.
export function withPriceTiers(departure, product) {
  return product?.priceTiers ? { ...departure, priceTiers: product.priceTiers } : departure;
}

export function findTier(product, tierId) {
  const tiers = product?.accommodationTiers || [];
  return tiers.find((t) => t.id === tierId) || tiers[0] || null;
}

// Package price = seat-based shared rate + per-person tier supplement
// + single supplement (only when rooming is "single").
export function packagePriceFor(product, departure, seats, { roomingType = "double", tierId } = {}) {
  const base = livePriceFor(withPriceTiers(departure || product, product), seats);
  const tier = findTier(product, tierId);
  const tierSupplement = Number(tier?.perPersonSupplement || 0);
  const singleSupplement = roomingType === "single" ? Number(tier?.singleSupplement || 0) : 0;
  return Math.round(base + tierSupplement + singleSupplement);
}


// Adds the computed livePrice + normalised fields to a departure for responses.
export function enrichDeparture(departure, product = null) {
  const seats = seatsTotal(departure.pledges);
  // The date this must confirm by, as a plain calendar day. A promise the
  // traveller cannot see before reserving is not much of a promise, so it goes
  // out with every departure rather than living only in the cancellation job.
  const deadlineMs = confirmDeadlineAt(departure, product);
  return {
    ...departure,
    type: departure.type || "day_tour",
    breakPrice: clampPrice(departure.breakPrice, Math.round(clampPrice(departure.publishedRate, 80) * 0.8)),
    depositPercent: Number(departure.depositPercent || defaultDepositFor(departure)),
    livePrice: livePriceFor(withPriceTiers(departure, product), seats),
    status: statusFor(departure, departure.pledges),
    confirmDeadline: Number.isNaN(deadlineMs) ? null : new Date(deadlineMs).toISOString().slice(0, 10),
    // F05 — pages offered "Reserve a seat" on dates this server would refuse.
    bookingClosesAt: Number.isNaN(bookingClosesAtMs(departure, product)) ? null : new Date(bookingClosesAtMs(departure, product)).toISOString(),
    confirmDeadlineDays: confirmDeadlineDaysFor(product, departure),
  };
}

// Has this departure's start already come and gone? Nothing expired departures
// off the public catalogue before, so a date that had already left showed up as
// a live card with a seat counter and a "Reserve a seat" button — the cutoff in
// bookingClosed() rejected the booking only after the visitor had filled the
// form in. Egyptian local time, like every other date on a departure (tz.js).
export function departureStarted(departure, nowMs = Date.now()) {
  const startStr = departure.startDate || departure.date;
  if (!startStr) return false;
  const start = zonedDateTimeToUtc(startStr, departure.time);
  // An unparseable date is left visible rather than silently disappearing —
  // a bad row is an ops problem, not a reason to hide inventory.
  if (Number.isNaN(start)) return false;
  return nowMs >= start;
}

// The SQL half of the two rules the bootstrap payload applies to departures:
// pending_review is hidden from everyone but platform staff, and an anonymous
// visitor is not shown a departure that has already started.
//
// It lives next to departureStarted() on purpose. Both describe the same
// boundary and they have to be read together — one narrows the query, the other
// decides the result — and a copy of this parked in app.js next to the SQL
// would drift from the rule it exists to approximate without anyone noticing.
//
// It is deliberately the looser of the two. departureStarted() resolves the
// stored date and wall-clock time in Africa/Cairo (tz.js); Postgres has no
// reason to agree about that instant, least of all across a DST boundary. Two
// days of slack is far wider than any offset, so this can only ever pass
// through rows departureStarted() then judges — it can never cut one that
// would have been kept. Rows with no date survive for the same reason
// departureStarted() keeps them: a bad row is an ops problem, not a reason to
// hide inventory.
//
// Returns a WHERE fragment built only from these two booleans — no caller data
// reaches it, so there is nothing here to parameterise.
export function departureScopeSql({ canSeeAll = false, signedIn = false } = {}) {
  const conditions = [
    canSeeAll ? null : "status <> 'pending_review'",
    signedIn ? null : "(COALESCE(start_date, date) IS NULL OR COALESCE(start_date, date) >= CURRENT_DATE - INTERVAL '2 days')",
  ].filter(Boolean);
  // No conditions means platform staff, who see everything. "TRUE" keeps the
  // callers' `WHERE ${scope}` from having to special-case an empty string.
  return conditions.join(" AND ") || "TRUE";
}

// How many days before departure this date must reach its minimum. A per-listing
// value wins; otherwise the type default.
export function confirmDeadlineDaysFor(product, departure) {
  const raw = product?.confirmDeadlineDays;
  // Not `Number(raw)`: the column is nullable and NULL is the normal case
  // meaning "use the type default", but Number(null) is 0 — which would have
  // silently given every listing a zero-day deadline and stopped the defaults
  // below from ever applying. Empty strings coerce to 0 the same way.
  const n =
    typeof raw === "number" ? raw
      : typeof raw === "string" && raw.trim() !== "" ? Number(raw)
        : NaN;
  if (Number.isFinite(n) && n >= 0) return n;
  return isPackage(departure || product)
    ? DEFAULT_PACKAGE_CONFIRM_DEADLINE_DAYS
    : DEFAULT_DAY_TOUR_CONFIRM_DEADLINE_DAYS;
}

// The instant a date must be confirmed by, as UTC epoch ms. Anchored to the
// departure's own start time in Egyptian local time (see tz.js) rather than to
// midnight, so a deadline never drifts by the host's timezone.
export function confirmDeadlineAt(departure, product) {
  const startStr = departure?.startDate || departure?.date;
  if (!startStr) return NaN;
  const start = zonedDateTimeToUtc(startStr, departure.time);
  if (Number.isNaN(start)) return NaN;
  return start - confirmDeadlineDaysFor(product, departure) * 86400000;
}

// Should this date be cancelled for never reaching its minimum?
//
// Deliberately narrow. Only a date that is still `open` qualifies: anything at
// or above its minimum has already advanced to minimum_reached, and
// pending_review is waiting on a human, not on travellers. Terminal states are
// left alone so a re-run can never resurrect or re-cancel a date.
export function missedConfirmDeadline(departure, product, nowMs = Date.now()) {
  if (departure?.status !== "open") return false;
  if (seatsTotal(departure.pledges) >= goAheadSeatsFor(departure)) return false;
  const deadline = confirmDeadlineAt(departure, product);
  // An unparseable date is an ops problem; cancelling on it would destroy real
  // inventory over a data error.
  if (Number.isNaN(deadline)) return false;
  return nowMs > deadline;
}

// A traveller-requested date that reached its day with nobody approving or
// declining it. Left alone, it sits in `pending_review` forever and the
// traveller is never told.
//
// Only requests whose booking is still `pending` — requests made before
// bookings carried that status keep the answer they were given. Waits for the
// date itself to start rather than guessing a deadline: until then a person may
// still decide, and this must never pre-empt them.
export function lapsedRequest(departure, nowMs = Date.now()) {
  if (departure?.status !== "pending_review") return false;
  if (!(departure.pledges || []).some((p) => p?.status === "pending")) return false;
  return departureStarted(departure, nowMs);
}

// Booking cutoff: returns true if bookings are CLOSED for this departure now.
// cutoffHours comes from the tour product (default 24). nowMs lets tests inject time.
// The instant bookings close, in epoch ms (NaN when the date can't be read).
// One computation for the write path (bookingClosed) and for what the pages are
// told (enrichDeparture's bookingClosesAt), so they close at the same moment.
export function bookingClosesAtMs(departure, product) {
  const startStr = departure.startDate || departure.date;
  if (!startStr) return NaN;
  const cutoffHours = Number(product?.bookingCutoffHours ?? 24);
  // A departure's date+time is Egyptian local time, NOT the server's — resolving
  // it with `new Date(...)` made the cutoff depend on the host's timezone and
  // fire hours late in production. See server/tz.js.
  const start = zonedDateTimeToUtc(startStr, departure.time);
  if (Number.isNaN(start)) return NaN;
  return start - cutoffHours * 3600 * 1000;
}

export function bookingClosed(departure, product, nowMs = Date.now()) {
  const deadline = bookingClosesAtMs(departure, product);
  if (Number.isNaN(deadline)) return false;
  return nowMs > deadline;
}

// Compute the pricing block for a new pledge.
export function computePledgePricing(departure, product, { seats, roomingType, accommodationTier }) {
  const projectedSeats = seatsTotal(departure.pledges) + Number(seats || 1);
  const depositPercent = Number(departure.depositPercent || defaultDepositFor(departure));
  let pricePerPerson;
  let extra = {};
  if (isPackage(departure)) {
    const rooming = ["single", "double", "triple"].includes(roomingType) ? roomingType : "double";
    const tier = findTier(product, accommodationTier);
    pricePerPerson = packagePriceFor(product, departure, projectedSeats, { roomingType: rooming, tierId: tier?.id });
    extra = { roomingType: rooming, accommodationTier: tier?.id || null, accommodationTierName: tier?.name || null };
  } else {
    pricePerPerson = livePriceFor(withPriceTiers(departure, product), projectedSeats);
  }
  const bookingTotal = pricePerPerson * Number(seats);
  const depositDue = Math.ceil(bookingTotal * (depositPercent / 100));
  return {
    pricePerPerson,
    bookingTotal,
    depositPercent,
    depositDue,
    balanceDue: bookingTotal - depositDue,
    // Type-aware since 13 Aug 2026: 48 hours before a day tour, 14 days before a
    // package. It was one universal "day before departure" for both. Captured on
    // the pledge at write time, so an existing booking keeps the date it was
    // quoted rather than silently moving.
    balanceDueDate: balanceDueDate(departure.startDate || departure.date, departure),
    ...extra,
  };
}

// ---- LL3 — what /booking tells a traveller -----------------------------------
//
// Extracted from the route so it can be tested without a database, because the
// answer it produces is read by one named person who then acts on it.
//
// The defect: this asked only whether the PLEDGE was cancelled, then whether
// enough seats were counted. On a departure the auto-cancel job had cancelled,
// the pledge was still `confirmed` and the seats were still counted, so it
// answered "Confirmed — GoAhead… the guide and transport are booked. See your
// confirmation email for the meeting point and time." — to someone who had
// just been emailed that their trip was cancelled.
//
// The date's own status is now the first thing asked. It is asked here, at the
// read, and not only at the write (KK1): if the write path regresses, or a row
// is corrected by hand, or some future path cancels a date another way, the
// person reading this page is the one who pays for it.
export function bookingLookupState({ departureStatus, pledgeStatus, seatsBooked = 0, goAhead = DEFAULT_GO_AHEAD }) {
  if (departureStatus === "cancelled") return "date_cancelled";
  if (pledgeStatus === "cancelled") return "booking_cancelled";
  // A traveller-requested date nobody has approved yet. Keyed on the PLEDGE
  // being `pending`, which only requests made after the change carry — the
  // requests already answered under the old copy keep reading as they did.
  if (departureStatus === "pending_review" && pledgeStatus === "pending") return "under_review";
  // And whatever the pledge says, a date still in review is not running: four
  // seats on an unapproved request used to read "Confirmed — GoAhead".
  if (departureStatus === "pending_review") return "forming";
  // F04 — a date that reached GoAhead STAYS confirmed. The stored
  // `minimum_reached` is authoritative (see statusFor in shared/): a traveller
  // leaving a four-seat date at three used to turn it back into "Forming" here,
  // and with it free self-cancellation for everyone else on it.
  if (["supplier_confirmed", "minimum_reached"].includes(departureStatus)
    || Number(seatsBooked) >= Number(goAhead)) return "confirmed";
  return "forming";
}

const BOOKING_STATE_LABEL = {
  date_cancelled: "Date cancelled",
  booking_cancelled: "Booking cancelled",
  confirmed: "Confirmed — GoAhead",
  under_review: "Under review",
  forming: "Forming",
};

// KK2.1's wording, adapted. The old copy read as a service failure at the exact
// moment the promise was being KEPT — a date that does not fill is cancelled and
// nobody is charged, which is the whole proposition.
function bookingStateNote(state, goAhead) {
  switch (state) {
    case "date_cancelled":
      return `This date didn't reach the ${numberWord(goAhead)} travelers it needed, so it isn't running. `
        + "That's the GoAhead promise doing its job — you were never charged, so there's nothing to refund.";
    case "booking_cancelled":
      return "This booking was cancelled. Nothing was charged for it.";
    case "confirmed":
      return "Your date is confirmed — the guide and transport are booked. See your confirmation email for the meeting point and time.";
    case "under_review":
      return "You asked us to open this date, and our team is reviewing it. We'll email you as soon as it's approved — nothing is charged.";
    default:
      return "Your seat is held. We'll let you know the moment this date reaches GoAhead.";
  }
}

export function bookingLookupView(input) {
  const state = bookingLookupState(input);
  const goAhead = Number(input.goAhead) || DEFAULT_GO_AHEAD;
  return {
    state,
    confirmed: state === "confirmed",
    // The seat count is a LIVE figure. On a date that is not running it is not
    // information, it is an invitation to keep waiting.
    showProgress: state === "confirmed" || state === "forming",
    statusLabel: BOOKING_STATE_LABEL[state],
    statusTone: state === "confirmed" ? "go" : (state === "forming" || state === "under_review") ? "pending" : "cancelled",
    note: bookingStateNote(state, goAhead),
    // Whether the traveller may release this seat themselves, decided HERE and
    // not in the page — the same argument as `showProgress` and `note`, both of
    // which moved here after the page chose them from `confirmed` alone and told
    // a traveller on a cancelled date that the guide was booked.
    //
    // `forming` only, and the authority is the TERMS rather than the marketing
    // copy this was first written from:
    //
    //   §6   "Before GoAhead … you may cancel your reservation at any time
    //         without a Sawa cancellation charge"
    //   §13.1 "Before GoAhead — You may cancel at any time without a Sawa
    //         cancellation charge. No Tour Price is captured."
    //   §13.2 "After GoAhead — The cancellation schedule … applies"
    //
    // So GoAhead is the boundary, and §13.2's schedule is SAWA'S: deposit at 46+
    // days, the greater of the deposit or 50% at 30–45, 100% under 30. An
    // Operating Partner's own schedule applies "only if it was clearly disclosed
    // before reservation". The first version of this comment called it "the
    // operator's policy", which is the common misreading and was live in four
    // places — it hands off a term Sawa sets.
    //
    // Before GoAhead there is nothing to weigh: no money has moved.
    //
    // Deliberately NOT the rule the older DELETE-by-pledge-id route uses, which
    // stops only at `supplier_confirmed` and would let a traveller walk out of a
    // confirmed date for free. That route is unadvertised and stays as it is;
    // this is the one a link in an email will reach.
    //
    // `under_review` too: withdrawing a request nobody has approved moves even
    // less than leaving a forming date.
    canCancel: state === "forming" || state === "under_review",
  };
}

// ---- PP3 — the admin overview's "departures needing action" panel -----------
//
// Extracted from the route so it can be tested. It had no status guard at all:
// a cancelled or closed date counted as `open`, or as `readyToConfirm` if it
// still held seats, and `atRisk` flagged any cancelled date starting within a
// fortnight. That is not a wrong number on a dashboard — it sends ops to chase
// a departure that does not exist.
//
// Deliberately not a census. Cancelled, closed and pending_review dates are
// dropped rather than given buckets of their own, because none of them is
// waiting on anything this panel can prompt: pending_review is waiting on a
// human's decision, not on travellers.
//
// `seatsFor` is a lookup rather than a pledge list because the caller
// aggregates seats in SQL. The threshold comes from statusFor, so this is not a
// third hand-written reading of "seats >= min" (NN2.1).
export const AT_RISK_DAYS = 14;

//
// A date whose start has passed is not waiting on travellers either, but it is
// not dropped silently: a past date still `open` or `minimum_reached` was never
// closed out, and that IS ops' to act on. It gets its own `departed` bucket and
// nothing else — counting it as open made the panel read "8 open & forming"
// while the public board, which hides departed dates, showed four.
//
// `open` is split the same way the public board splits it: `forming` is a date
// a real traveller holds a seat on (isFormingDeparture — exactly what
// /departures lists), `awaiting` is inventory nobody has booked yet.
export function departureActionBuckets(rows = [], seatsFor = () => 0, nowMs = Date.now()) {
  const buckets = { forming: 0, awaiting: 0, readyToConfirm: 0, confirmed: 0, atRisk: 0, departed: 0, excluded: 0 };
  for (const row of rows) {
    if (["cancelled", "closed", "pending_review"].includes(row?.status)) {
      buckets.excluded += 1;
      continue;
    }
    const seats = Number(seatsFor(row.id)) || 0;
    const start = row.start_date || row.startDate || row.date;
    if (departureStarted({ startDate: isoDate(start), time: row.time }, nowMs)) {
      // A confirmed date that has run is history, not a loose end.
      if (row.status === "supplier_confirmed") buckets.excluded += 1;
      else buckets.departed += 1;
      continue;
    }
    if (row.status === "supplier_confirmed") { buckets.confirmed += 1; continue; }
    if (statusFor(row, [{ seats, status: "confirmed" }]) === "minimum_reached") {
      buckets.readyToConfirm += 1;
      continue;
    }
    if (seats >= 1) buckets.forming += 1;
    else buckets.awaiting += 1;
    const daysOut = (new Date(start) - nowMs) / 86400000;
    if (daysOut <= AT_RISK_DAYS) buckets.atRisk += 1;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// What a TRAVELLER may see about an operator.
//
// A whitelist, never a redaction list. `agencies` carries a tourism licence
// number, an ETAA registration, an insurer, a policy number and free-text
// verification evidence, and the difference between "remove these six" and
// "emit these three" is that the first silently leaks the seventh column
// somebody adds next year.
//
// THE LICENCE NUMBER IS NOT PUBLISHABLE, and that is a promise rather than a
// preference. /verify tells every operator, in these words:
//
//   "We use your license number only to confirm your registration with the
//    Ministry of Tourism & Antiquities, and we don't share it outside Sawa."
//
// Publishing it on a product page or an operator directory would break that
// sentence for every operator who signed up on the strength of it. The ETAA
// registration and the insurer are held back on the same reasoning — they were
// given to Sawa to be checked, not to be displayed — and can be released later
// if the client decides to say so on /verify first.
//
// `verified` is deliberately NOT `Boolean(row)`. An operator record and a
// verified operator are two different claims (029's point, which survives that
// migration's premise being wrong): a row exists the moment somebody is added,
// and `verification_state` says whether anyone has actually checked. A card
// reading "Verified operator" above a row nobody assessed is the defect the
// product page's old operator card was deleted for.
// ---- U01 — which company runs a date -------------------------------------
//
// The rule the client set on 25 Sep 2026:
//
//   - The company whose customers fill the most seats runs the date. It only
//     changes hands when another company has strictly MORE — a tie stays with
//     whoever booked first.
//   - Travellers who book directly count as the direct-bookings operator's
//     customers (DIRECT_BOOKINGS_OPERATOR in brand.js).
//   - It is fixed once the date reaches GoAhead: the leader at the booking that
//     took the date to its minimum is the operator from then on, whatever is
//     booked afterwards.
//   - A date nobody has booked yet is named after the agency that listed the
//     tour, or the direct-bookings operator for tours Sawa listed.
//
// The lock is worked out by replaying the live bookings in the order they were
// made, not stored: that needs no schema change, and every page computes the
// same answer from the same rows. Its limit, stated plainly: if a booking made
// BEFORE GoAhead is later cancelled (after GoAhead that goes through Sawa, per
// the Terms), the replay no longer sees it and can name a different leader.
// What a direct booking stores as its agency (app.js, the public and admin
// booking routes): not an agency record, so it counts as the direct-bookings
// operator's, exactly as a missing one does.
export const DIRECT_CUSTOMER = "direct_customer";

export function operatorForDeparture(departure, { listingAgencyId = null, directAgencyId = null } = {}) {
  const fallback = listingAgencyId || directAgencyId || null;
  const live = (departure?.pledges || [])
    .filter((p) => p && p.status !== "cancelled" && Number(p.seats) > 0)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => String(a.p.createdAt || "").localeCompare(String(b.p.createdAt || "")) || a.i - b.i)
    .map(({ p }) => p);
  if (!live.length) return fallback;

  const goAhead = goAheadSeatsFor(departure);
  const seatsBy = new Map();
  let total = 0;
  let leader = null;
  for (const p of live) {
    const owner = p.agencyId && p.agencyId !== DIRECT_CUSTOMER ? p.agencyId : directAgencyId;
    const seats = Number(p.seats) || 0;
    total += seats;
    if (owner) {
      seatsBy.set(owner, (seatsBy.get(owner) || 0) + seats);
      if (leader === null || (owner !== leader && seatsBy.get(owner) > seatsBy.get(leader))) leader = owner;
    }
    // GoAhead reached on this booking: the operator is fixed here.
    if (total >= goAhead) return leader || fallback;
  }
  return leader || fallback;
}

// The agency id of the direct-bookings operator, by exact (case-insensitive)
// name. Null when no such record exists — the page then names nobody rather
// than guessing.
export function directOperatorId(agencies = [], name = "") {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  const hit = agencies.find((a) => String(a?.name || "").trim().toLowerCase() === want);
  return hit ? hit.id : null;
}

export function publicOperator(agency) {
  if (!agency || !agency.name) return null;
  const verified = agency.verificationState === "verified";
  return {
    name: agency.name,
    // Registration YEAR, not an expiry — an Egyptian tourism licence does not
    // expire (035). Emitted because it is a fact about the company's standing
    // that carries no identifying number.
    licensedSince: agency.tourismLicenseYear ?? null,
    verified,
    // Only ever alongside verified: a date without the state reads as a
    // verification, and a state without the date is unfalsifiable.
    verifiedAt: verified ? (agency.verifiedAt || null) : null,
    // The partner's public entry in the ETAA registry. This is the FIFTH field
    // and the first that carries an identifying number: ETAA keys its registry
    // by tourism licence, so the URL discloses it. The client directed this
    // disclosure on 15 August 2026 ("use 'a member of the Egyptian Travel
    // Agents Association' as the anchor text, then add the link") — it turns
    // the membership claim into one a traveller can check on the register
    // itself, the DIR-17.2 move. /verify's handling promise was amended the
    // same day to carry the exception.
    etaaUrl: agency.etaaRegistrationNo
      ? `https://www.etaa-egypt.org/SitePages/CompanyDetails.aspx?licc=${encodeURIComponent(agency.etaaRegistrationNo)}`
      : null,
  };
}
