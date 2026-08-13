// What a traveller pays, when the balance falls due, and what cancelling costs.
// One declaration for all three, because they are one policy.
//
// ============================================================================
// WHY THESE LIVE TOGETHER
// ============================================================================
//
// The cancellation charge is a fraction of the DEPOSIT, and the deposit rate
// depends on whether the product is a package. So a cancellation band cannot be
// stated without the deposit rate, and neither can be stated without the type.
// Splitting them across three files would mean three files that must agree.
//
// This replaces shared/cancellation-schedule.js, which held only the bands, and
// absorbs three things that were duplicated or unreachable:
//
//   isPackage        declared in server/domain.js AND src/main.jsx, identically.
//                    check:duplication could not see it: its authority list is
//                    derived from shared/, and this lived in server/.
//
//   balanceDueDate   declared in both too — and NOT identically. The server
//                    returns an ISO date; the client returned a FORMATTED
//                    string. Same name, different return type, which is the
//                    `statusFor` collision again. The arithmetic is here and
//                    returns ISO; formatting belongs to whoever renders it.
//
//   deposit rates    10 / 20 lived in server/domain.js, so the browser bundle
//                    and the static pages could not read them — and the rate
//                    was consequently typed by hand into six copy locations.
//
// Deliberately dependency-free: imported into the browser bundle and into server
// modules that price a booking. Same constraint as group-size.js.
//
// ============================================================================
// THE POLICY, CONFIRMED BY THE CLIENT 13 AUGUST 2026
// ============================================================================
//
// A deposit falls due at GoAhead. Full payment follows before departure. If a
// traveller cancels, THE MOST THEY CAN LOSE IS THE DEPOSIT — any balance already
// paid is refunded in full, on both product types.
//
// That cap is the client's explicit instruction ("cap it at what we hold —
// deposit only, both types") and it is why every charge below is expressed as a
// fraction OF THE DEPOSIT rather than of the Tour Price. An earlier draft of the
// schedule quoted "50% of total tour price" and "full amount" for the late
// package bands; under the cap those are the deposit, and writing them as
// price-fractions would have overstated the charge by up to four times.

export function isPackage(item) {
  return item && item.type === "package";
}

// Percentage of the Tour Price taken at GoAhead.
export const DAY_TOUR_DEPOSIT_PCT = 10;
export const PACKAGE_DEPOSIT_PCT = 25;

export function depositPctFor(item) {
  return isPackage(item) ? PACKAGE_DEPOSIT_PCT : DAY_TOUR_DEPOSIT_PCT;
}

// How many days before departure the remaining balance is due.
//
// This was a single universal rule — departure minus one day, for everything —
// and it is now per type. A package needs the money before the operator commits
// to hotels and boats; a day tour does not.
export const DAY_TOUR_BALANCE_DUE_DAYS = 2;    // "48 hours prior to departure"
export const PACKAGE_BALANCE_DUE_DAYS = 14;    // "2 weeks before departure"

export function balanceDueDays(item) {
  return isPackage(item) ? PACKAGE_BALANCE_DUE_DAYS : DAY_TOUR_BALANCE_DUE_DAYS;
}

// Pure calendar arithmetic, wholly in UTC, returning YYYY-MM-DD.
//
// The client's copy of this stepped back a LOCAL day and read the result with
// toISOString(), so a viewer past +12 — New Zealand, Fiji, Samoa — was shown the
// balance falling due a day early. Doing it all in UTC is the fix, and having
// one copy is what stops it coming back.
//
// Returns a DATE, never a formatted string: the two old copies disagreed on
// exactly that, and a caller that wants words can format what it gets.
export function balanceDueDate(departureDate, item) {
  const d = new Date(`${departureDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - balanceDueDays(item));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cancellation.
//
// `ofDeposit` is the fraction of the DEPOSIT charged, never of the Tour Price.
// Expressing it as a fraction is what keeps the percentages honest: half a 25%
// deposit is 12.5% of the price, and nobody has to remember to update that
// number when a deposit rate moves.
//
// `days` is the inclusive lower bound in days before departure, so a band runs
// from its own `days` up to the next band's. null means "right up to departure,
// and no-show". Nothing computes with these yet — they exist so a future refund
// calculation reads the schedule rather than a second copy of it.
export const CANCELLATION_SCHEDULE = {
  day_tour: [
    { days: 2, when: "48 hours or more before departure", ofDeposit: 0 },
    { days: null, when: "Less than 48 hours before departure, or no-show", ofDeposit: 1 },
  ],
  package: [
    { days: 30, when: "30 days or more before departure", ofDeposit: 0 },
    { days: 15, when: "29–15 days before departure", ofDeposit: 0.5 },
    // The client's schedule split this in two — "14–7 days: 50% of total tour
    // price" and "6–0 days: full amount". Under the deposit cap both are the
    // deposit, so the split charged the same money twice and a fee table with
    // two adjacent identical rows reads as an error. Merged on the client's
    // instruction, 13 August 2026. Splitting it again is one entry here.
    { days: null, when: "14 days or fewer before departure, or no-show", ofDeposit: 1 },
  ],
};

export function cancellationBandsFor(item) {
  return isPackage(item) ? CANCELLATION_SCHEDULE.package : CANCELLATION_SCHEDULE.day_tour;
}

// 12.5 stays 12.5; 25.0 becomes 25. A trailing ".0" on a fee reads as a typo.
const pct = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

// What a band costs, in words, for a given deposit rate. Generated rather than
// written out so the three surfaces cannot phrase the same charge differently.
export function chargeText(band, depositPct) {
  if (!band.ofDeposit) return "No charge — your deposit is refunded in full";
  const share = depositPct * band.ofDeposit;
  return band.ofDeposit === 1
    ? `Deposit retained (${pct(share)}% of the Tour Price)`
    : `Half the deposit (${pct(share)}% of the Tour Price)`;
}

export const CANCELLATION_COLUMNS = {
  when: "Written cancellation received",
  charge: "Cancellation charge",
};

// The headline, and it is genuinely the good news: the exposure is capped.
// Stated first everywhere, because "the most you can lose is the deposit" is
// what a reader actually needs before a table of dates.
export const CANCELLATION_CAP =
  "The most you can lose is your deposit. Any balance you have already paid is refunded in full.";

export const CANCELLATION_BEFORE_GOAHEAD =
  "Before GoAhead you can cancel free, at any time — no Tour Price is captured, so there is no charge and nothing to refund.";

// Stated wherever the bands are, because they are the DEFAULT and not
// necessarily the schedule that binds. Terms §13.2: an Operating Partner's own
// schedule applies "only if it was clearly disclosed before reservation".
export const CANCELLATION_QUALIFIER =
  "This is our default schedule. An operator's own schedule applies only where it was disclosed before you reserved.";
