// Date parsing for display. The one rule here exists because getting it wrong
// is invisible from Egypt.
//
// Departure dates are stored date-only ("2026-07-10"). `new Date("2026-07-10")`
// is specified to parse as UTC midnight, so in any timezone west of UTC it
// formats as the PREVIOUS day: a traveller in New York or California saw every
// departure a day early, and would book — and turn up — on the wrong date.
// Cairo is UTC+2/+3, so staff and the dev machine never reproduce it.
//
// A "YYYY-MM-DDT12:00:00" string with no zone suffix is parsed as LOCAL time,
// so the value means noon in the viewer's own timezone and is then formatted in
// that same timezone — the calendar day can't shift. This mirrors what
// server/domain.js and the static pages in /site already do; the React app was
// the odd one out.
//
// Full timestamps (createdAt, submittedAt, publishedAt) already carry their own
// zone information, so they pass through untouched.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && DATE_ONLY.test(value)) return new Date(`${value}T12:00:00`);
  return new Date(value);
}

// Shared "12 Jul 2026" formatter used by both dashboards.
export function fmtDate(value) {
  if (!value) return "—";
  const d = toDate(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(d);
}
