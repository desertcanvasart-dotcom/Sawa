// Pure business rules: pricing, status, deposits. No DB, no HTTP — easy to test.
import { zonedDateTimeToUtc } from "./tz.js";

export const DEFAULT_DAY_TOUR_DEPOSIT = 10;
export const DEFAULT_PACKAGE_DEPOSIT = 20;

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

export function isPackage(item) {
  return item && item.type === "package";
}

export function defaultDepositFor(item) {
  return isPackage(item) ? DEFAULT_PACKAGE_DEPOSIT : DEFAULT_DAY_TOUR_DEPOSIT;
}

function clampPrice(value, fallback) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

// Explicit per-headcount pricing, when an operator wants it.
//
// Stored as breakpoints rather than one row per traveller, because real costs
// step rather than slide: a 7-seater up to six people, a minibus beyond. The
// price for N travellers is the last breakpoint at or below N, so a sparse
// table like 4→$110, 7→$85, 10→$60 prices every group size in between without
// the operator typing each one.
//
// Returns null when there is no usable table, which is the signal to fall back
// to the published/break interpolation.
export function priceFromTiers(tiers, seats) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const sorted = tiers
    .map((t) => ({ seats: Number(t?.seats), price: Number(t?.price) }))
    .filter((t) => Number.isFinite(t.seats) && Number.isFinite(t.price) && t.seats > 0 && t.price > 0)
    .sort((a, b) => a.seats - b.seats);
  if (!sorted.length) return null;
  const n = Number(seats) || 0;
  // Below the first breakpoint, the first breakpoint's price applies — the
  // table is validated to start at the minimum group size, so this only comes
  // up for a legacy row that predates that rule.
  let match = sorted[0];
  for (const t of sorted) if (n >= t.seats) match = t;
  return Math.round(match.price);
}

export function livePriceFor(item, seats) {
  const goAhead = goAheadSeatsFor(item);
  const startPrice = clampPrice(item.publishedRate, 80);
  const breakPrice = Math.min(startPrice, clampPrice(item.breakPrice, Math.round(startPrice * 0.8)));
  const maxSeats = Math.max(Number(item.maxSeats || goAhead), goAhead);
  const effectiveSeats = Math.min(maxSeats, Math.max(goAhead, Number(seats || 0)));
  // Clamped first: a party of 20 on a twelve-seat tour pays the twelve price,
  // under the table exactly as under the curve.
  const fromTable = priceFromTiers(item?.priceTiers, effectiveSeats);
  if (fromTable != null) return fromTable;
  const steps = Math.max(1, maxSeats - goAhead);
  const progress = Math.min(1, Math.max(0, effectiveSeats - goAhead) / steps);
  return Math.round(startPrice - (startPrice - breakPrice) * progress);
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

// The day before departure. This is pure calendar arithmetic — no instant, no
// zone — so it is done wholly in UTC. The previous version built a LOCAL noon
// Date, stepped back a local day, then read it back with toISOString(), which
// is UTC: at offsets beyond +12 local noon is already the previous day in UTC,
// so the balance fell due a day early.
export function balanceDueDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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

// Booking cutoff: returns true if bookings are CLOSED for this departure now.
// cutoffHours comes from the tour product (default 24). nowMs lets tests inject time.
export function bookingClosed(departure, product, nowMs = Date.now()) {
  const startStr = departure.startDate || departure.date;
  if (!startStr) return false;
  const cutoffHours = Number(product?.bookingCutoffHours ?? 24);
  // A departure's date+time is Egyptian local time, NOT the server's — resolving
  // it with `new Date(...)` made the cutoff depend on the host's timezone and
  // fire hours late in production. See server/tz.js.
  const start = zonedDateTimeToUtc(startStr, departure.time);
  if (Number.isNaN(start)) return false;
  const deadline = start - cutoffHours * 3600 * 1000;
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
    balanceDueDate: balanceDueDate(departure.startDate || departure.date),
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
  if (departureStatus === "supplier_confirmed" || Number(seatsBooked) >= Number(goAhead)) return "confirmed";
  return "forming";
}

const BOOKING_STATE_LABEL = {
  date_cancelled: "Date cancelled",
  booking_cancelled: "Booking cancelled",
  confirmed: "Confirmed — GoAhead",
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
    statusTone: state === "confirmed" ? "go" : state === "forming" ? "pending" : "cancelled",
    note: bookingStateNote(state, goAhead),
  };
}
