// How far ahead, and how soon, a traveller may request a date. Per product.
//
// Both ends were constants in server/app.js, applied to every product alike. The
// addendum specified otherwise from the start — "per tour product, default 3"
// and "default 90" — but only the defaults were built, so a Nile cruise could
// not be requested for January and a Cairo day tour carried a 90-day window it
// had no use for.
//
// The defaults live here rather than in the route, because THREE places need the
// same pair: the server that refuses a bad date, the calendar that greys the
// days out of range, and the admin form that shows an operator what a blank
// field will fall back to. Two of those are in the browser bundle.

// The fallbacks. A product with NULL for either end gets these — not because
// they are right for every trip, but because they are what the site did before
// anyone could choose, and changing a default must not silently re-window every
// product that never expressed an opinion.
export const DEFAULT_MIN_LEAD_DAYS = 3;
export const DEFAULT_MAX_HORIZON_DAYS = 90;

// Bounds an operator may type. Wide enough not to argue with a real itinerary,
// narrow enough that a slipped digit is refused while they are still looking at
// the field: 900 instead of 90 would otherwise offer dates two and a half years
// out, and nothing downstream would question it.
export const MAX_LEAD_DAYS_ALLOWED = 365;
export const MAX_HORIZON_DAYS_ALLOWED = 1460;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// snake_case is accepted because raw database rows reach this on the server,
// the same courtesy operatingDaysOf() extends.
function readWindow(product) {
  const lead = num(product?.requestMinLeadDays ?? product?.request_min_lead_days);
  const horizon = num(product?.requestMaxHorizonDays ?? product?.request_max_horizon_days);
  return { lead, horizon };
}

export function minLeadDaysFor(product) {
  const { lead } = readWindow(product);
  return lead == null ? DEFAULT_MIN_LEAD_DAYS : lead;
}

export function maxHorizonDaysFor(product) {
  const { horizon } = readWindow(product);
  return horizon == null ? DEFAULT_MAX_HORIZON_DAYS : horizon;
}

// Returns an error string, or null when the window is savable. Same shape as
// capacityError() and durationShapeError(): a sentence an operator can act on,
// returned rather than thrown, so the rule is testable without a request.
//
// Deliberately mirrors the CHECK constraint in 037. The constraint is the thing
// that cannot be bypassed; this exists so the operator is told what is wrong in
// words instead of meeting a constraint violation.
export function requestWindowError(minLeadDays, maxHorizonDays) {
  const lead = minLeadDays === "" || minLeadDays == null ? null : num(minLeadDays);
  const horizon = maxHorizonDays === "" || maxHorizonDays == null ? null : num(maxHorizonDays);

  if (minLeadDays != null && minLeadDays !== "" && lead == null) return "Minimum notice must be a whole number of days.";
  if (maxHorizonDays != null && maxHorizonDays !== "" && horizon == null) return "The booking window must be a whole number of days.";
  if (lead != null && (lead < 0 || lead > MAX_LEAD_DAYS_ALLOWED)) {
    return `Minimum notice must be between 0 and ${MAX_LEAD_DAYS_ALLOWED} days.`;
  }
  if (horizon != null && (horizon < 1 || horizon > MAX_HORIZON_DAYS_ALLOWED)) {
    return `The booking window must be between 1 and ${MAX_HORIZON_DAYS_ALLOWED} days ahead.`;
  }
  // Only when both are set, matching the constraint: one end configured and the
  // other on its default is a normal state, and the fallback pair is known-good.
  if (lead != null && horizon != null && horizon <= lead) {
    return `The booking window (${horizon} days) must be further out than the minimum notice (${lead} days), or no date is ever bookable.`;
  }
  return null;
}
