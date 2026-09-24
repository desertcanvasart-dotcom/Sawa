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

// When something ARRIVED — a request, a booking. A full timestamp, shown in
// Cairo time and labelled as such (ops reads it in Egypt; a laptop set to
// another zone must not quietly shift it), plus how long ago, because "is
// this one waiting on me for days?" is the question it answers.
const RECEIVED_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo", day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function timeAgo(value, nowMs = Date.now()) {
  const d = toDate(value);
  if (!value || Number.isNaN(d.getTime())) return "";
  const mins = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function fmtReceived(value, nowMs = Date.now()) {
  if (!value) return "—";
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${RECEIVED_FMT.format(d)} Cairo · ${timeAgo(d, nowMs)}`;
}
