// The catalogue's calendar and status rules, with no database and no clock of
// their own: every function takes "now" or a date range as an argument, so the
// jobs, the admin screens and the tests all run the same arithmetic.
//
// Dates here are calendar days in the tour timezone, as "YYYY-MM-DD" strings.
// They never go through a local Date, which is how a departure used to render
// a day early west of UTC (see src/dates.js).

export const PRODUCT_TYPES = ["day_tour", "one_way_road_tour", "cruise", "multi_day"];
export const PRODUCT_STATUSES = ["active", "held", "retired"];
export const DEPARTURE_STATUSES = ["open", "go_ahead", "cancelled_below_minimum", "completed"];

export const TYPE_LABELS = {
  day_tour: "Day tour",
  one_way_road_tour: "One-way road tour",
  cruise: "Cruise",
  multi_day: "Multi-day",
};

// Cruises and multi-day tours run on a GoAhead deadline set weeks ahead
// (hotels and ships charge cancellation fees early); day and one-way tours
// decide at the cut-off.
export const usesDeadline = (type) => type === "cruise" || type === "multi_day";

// How far ahead the generator creates departures.
export const windowDaysFor = (type) => (usesDeadline(type) ? 365 : 90);

// The existing booking engine only knows day tours and packages. A catalogue
// product is sold through a listing of the matching legacy type, and its URL
// prefix follows that type (/tour or /package).
export const legacyTypeFor = (type) => (usesDeadline(type) ? "package" : "day_tour");

// ---------------------------------------------------------------- dates
const DAY_MS = 86400000;
const toUtcMs = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const fromUtcMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDays(ymd, n) {
  return fromUtcMs(toUtcMs(ymd) + n * DAY_MS);
}

// 0 = Sunday … 6 = Saturday, the same numbering as tour_products.operating_days.
export function weekdayOf(ymd) {
  return new Date(toUtcMs(ymd)).getUTCDay();
}

const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Every date a rule produces between `from` and `to`, inclusive, clipped to the
// rule's own active window. Sorted, no duplicates.
export function datesForRule(rule, from, to) {
  const start = [from, rule.activeFrom].filter(isYmd).sort().pop();
  const end = [to, rule.activeTo].filter(isYmd).sort()[0];
  if (!start || !end || start > end) return [];

  if (rule.kind === "dates") {
    return [...new Set((rule.dates || []).filter(isYmd))].filter((d) => d >= start && d <= end).sort();
  }

  const weekdays = new Set((rule.weekdays || []).map(Number));
  if (!weekdays.size) return [];
  const every = Math.max(1, Number(rule.intervalWeeks) || 1);
  // Every Nth week counted from the anchor's week (weeks start on Sunday, as
  // the weekday numbering does). Without an anchor, every week.
  const anchorWeek = every > 1 && isYmd(rule.anchorDate)
    ? Math.floor((toUtcMs(rule.anchorDate) - weekdayOf(rule.anchorDate) * DAY_MS) / (7 * DAY_MS))
    : null;

  const out = [];
  for (let ms = toUtcMs(start); ms <= toUtcMs(end); ms += DAY_MS) {
    const ymd = fromUtcMs(ms);
    const wd = weekdayOf(ymd);
    if (!weekdays.has(wd)) continue;
    if (anchorWeek !== null) {
      const week = Math.floor((ms - wd * DAY_MS) / (7 * DAY_MS));
      if (((week - anchorWeek) % every + every) % every !== 0) continue;
    }
    out.push(ymd);
  }
  return out;
}

// The dates a product should have departures on, from `today` to the end of
// its window. Held and retired products generate nothing.
export function plannedDates(product, rules, today) {
  if (product.status !== "active") return [];
  const to = addDays(today, windowDaysFor(product.type));
  const all = new Set();
  for (const rule of rules) for (const d of datesForRule(rule, today, to)) all.add(d);
  return [...all].sort();
}

// ---------------------------------------------------------------- status
//
// The status rules, all in one place. `now` and the two instants are epoch ms;
// the caller works them out in the tour timezone.
//
//   open → go_ahead                 seats sold reach the minimum (or an admin
//                                   chose to run it below the minimum)
//   open → cancelled_below_minimum  day / one-way: still below at the cut-off
//                                   cruise / multi-day: still below at the
//                                   GoAhead deadline
//   go_ahead → completed            the departure has ended
//
// go_ahead is sticky: after the GoAhead the departure is guaranteed and runs
// even if cancellations take it below the minimum. Adopted departures (dates
// that already had bookings under the old rules) are never cancelled here;
// the old rules still govern them.
export function nextStatus(d, now) {
  const { status, seatsSold = 0, goaheadMin = 4, type, runBelowMinimum = false } = d;
  if (status === "cancelled_below_minimum" || status === "completed") return { status, reason: null };

  if (status === "go_ahead") {
    return Number.isFinite(d.endsAt) && now >= d.endsAt
      ? { status: "completed", reason: "ended" }
      : { status, reason: null };
  }

  // status === "open"
  if (seatsSold >= goaheadMin) return { status: "go_ahead", reason: "minimum_reached" };
  if (runBelowMinimum) return { status: "go_ahead", reason: "admin_override" };
  if (d.origin === "adopted") return { status, reason: null };

  const decideAt = usesDeadline(type) ? d.deadlineAt : d.cutoffAt;
  if (Number.isFinite(decideAt) && now >= decideAt) {
    return { status: "cancelled_below_minimum", reason: usesDeadline(type) ? "deadline" : "cutoff" };
  }
  return { status, reason: null };
}

// When the override may be used: before the departure has started, while it is
// open or already cancelled for being below the minimum. Not on a departure
// that is going ahead anyway, and not once it is over.
export function canRunBelowMinimum(d, now) {
  if (!["open", "cancelled_below_minimum"].includes(d.status)) return false;
  return !(Number.isFinite(d.startsAt) && now >= d.startsAt);
}

// ---------------------------------------------------------------- public
// What the date picker says. "Going ahead" once the GoAhead is reached,
// otherwise how many more travellers the date needs.
export function publicDateLabel({ status, seatsSold = 0, goaheadMin = 4 }) {
  if (status === "go_ahead") return "Going ahead";
  const need = Math.max(0, goaheadMin - seatsSold);
  return `${need} of ${goaheadMin} needed`;
}

// Departures a traveller may see: open or going ahead, and not yet past the
// cut-off (the picker is where a seat is chosen).
export const publiclyListed = (d, now) =>
  (d.status === "open" || d.status === "go_ahead") && !(Number.isFinite(d.cutoffAt) && now >= d.cutoffAt);

// ---------------------------------------------------------------- specs
// The fields a specification has, in the order the editor shows them.
// roomCategories applies to cruises and multi-day only.
export const SPEC_FIELDS = [
  ["itinerary", "Itinerary"],
  ["startTime", "Start time"],
  ["duration", "Duration"],
  ["inclusions", "Inclusions"],
  ["exclusions", "Exclusions"],
  ["vehicleByBand", "Vehicle class by group size"],
  ["guideLanguages", "Guide languages"],
  ["meals", "Meals"],
  ["pickupArea", "Pickup area"],
  ["pickupWindow", "Pickup window"],
  ["addons", "Listed paid add-ons"],
  ["roomCategories", "Room or cabin categories"],
];

const empty = (v) => v == null || (typeof v === "string" && !v.trim())
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === "object" && !Array.isArray(v) && Object.values(v).every(empty));

// The fields still "to complete". An empty add-on list counts: the product may
// simply have none, but somebody has to say so.
export function specGaps(content = {}, type) {
  return SPEC_FIELDS
    .filter(([key]) => key !== "roomCategories" || usesDeadline(type))
    .filter(([key]) => {
      if (key === "addons") return !Array.isArray(content.addons) || (content.addons.length === 0 && content.noAddons !== true);
      return empty(content[key]);
    })
    .map(([key]) => key);
}

// A spec can't be published without what the public page prints: every
// published inclusion and exclusion comes from the spec.
export function publishBlockers(content = {}) {
  const out = [];
  if (!Array.isArray(content.inclusions) || !content.inclusions.some((x) => String(x || "").trim())) out.push("inclusions");
  if (!Array.isArray(content.exclusions) || !content.exclusions.some((x) => String(x || "").trim())) out.push("exclusions");
  return out;
}

// The active version: published, with the latest effective date on or before
// `today`. Versions are compared by effective date, then by version number.
export function activeSpec(versions, today) {
  return versions
    .filter((v) => v.state === "published" && isYmd(v.effectiveFrom) && v.effectiveFrom <= today)
    .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.version - b.version : a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .pop() || null;
}
