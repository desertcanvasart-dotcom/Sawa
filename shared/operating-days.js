// Which weekdays a listing may depart on. One rule, three callers.
//
// ============================================================================
// WHY THIS IS A FILE
// ============================================================================
//
// The rule existed twice, and the two copies did different halves of the job:
//
//   server/app.js  the traveller-request route — the full check, plus its own
//                  ["Sundays", "Mondays", …] table and its own comma-and-"and"
//                  joiner for the message.
//   src/main.jsx   the date picker — a second copy of the SAME table and the
//                  SAME joiner, to label the chips.
//
// And the path that mattered most had neither: the ADMIN route that publishes a
// departure never checked at all. So a traveller was refused a Tuesday on a
// Mon/Sat cruise while ops could publish one, and the site would then advertise
// a date it refuses to let anyone request.
//
// That gap has not bitten yet — no restricted product has a departure today —
// which is exactly when it is cheapest to close. All three Nile cruises run on
// fixed weekdays, so the first cruise date published is the first chance to get
// it wrong.
//
// Deliberately dependency-free: imported into the browser bundle and into server
// routes, the same constraint as group-size.js and booking-policy.js.

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// 0 = Sunday … 6 = Saturday, matching JS getUTCDay() and the values the admin's
// weekday toggles write.
export function operatingDaysOf(product) {
  const days = product?.operatingDays ?? product?.operating_days;
  return Array.isArray(days) ? days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
}

// "Saturdays", or "Saturdays and Mondays", or "Mondays, Wednesdays and Fridays".
// Serial comma deliberately absent — the site's copy does not use one.
export function operatingDaysLabel(days) {
  const list = (days || []).map((d) => DAYS[d]).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// The day a YYYY-MM-DD string falls on, read at NOON UTC.
//
// Not midnight: `new Date("2026-09-14")` is midnight UTC, and a server or a
// browser west of Greenwich renders that as the previous day. Noon is far enough
// from both boundaries that no offset in use can move it — the same reason
// src/dates.js anchors date-only values at local noon.
export function weekdayOf(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

// Returns an error string, or null when the date is publishable.
//
// Shaped like capacityError() and durationShapeError(): a sentence an operator
// can act on, returned rather than thrown, so each caller decides its own status
// code and the rule itself stays testable without a request.
//
// An unrestricted product returns null for every date — "no operating days" means
// "any day", which is what the admin's all-seven-ticked case normalises to.
export function operatingDayError(product, isoDate) {
  const days = operatingDaysOf(product);
  if (!days.length) return null;
  const dow = weekdayOf(isoDate);
  if (dow === null) return "That date could not be read.";
  if (days.includes(dow)) return null;
  const title = product?.title ? `${product.title} departs` : "This tour departs";
  return `${title} only on ${operatingDaysLabel(days)} — pick one of those days.`;
}
