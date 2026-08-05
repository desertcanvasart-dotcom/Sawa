// Egyptian local time, independent of where the server happens to run.
//
// Departures store a date ("2026-07-10") and a wall-clock time ("08:00") that
// mean Egyptian local time — that is when the guide meets the group in Cairo.
// `new Date("2026-07-10T08:00")` instead resolves in the SERVER's timezone, so
// the same row produced a different instant on a Cairo dev machine than on a
// UTC production host. The booking cutoff was computed from that instant, so on
// Railway (UTC by default) it fired 2-3 hours late: a "24 hours before" rule
// actually closed 21 hours before, inside the window operators keep to confirm
// the guide and the vehicle.
//
// Egypt reinstated DST in 2023 — EET (UTC+2) in winter, EEST (UTC+3) in summer —
// so a hardcoded offset is wrong for half the year. These helpers ask Intl for
// the zone's real offset at the relevant instant.

export const TOUR_TIMEZONE = process.env.TOUR_TIMEZONE || "Africa/Cairo";

// The zone's UTC offset, in ms, at a given instant.
function offsetAt(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const f = {};
  for (const p of parts) f[p.type] = p.value;
  // hour can come back as "24" at midnight in some ICU versions; % 24 normalises.
  const asIfUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour % 24, +f.minute, +f.second);
  return asIfUtc - utcMs;
}

// Normalise a stored time to "HH:MM". The departures.time column is free text
// and nothing validates it on write, so "08:00:00" or junk can land there; an
// unparseable time previously produced an invalid Date and the cutoff silently
// failed open (bookings never closed at all).
export function normalizeTime(value, fallback = "08:00") {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return fallback;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!(hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59)) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

// "2026-07-10" + "08:00" in `timeZone` -> the true UTC epoch ms.
// Two passes: the offset is first looked up at the naive instant, then again at
// the corrected one, which puts DST transitions on the right side of the change.
export function zonedDateTimeToUtc(dateStr, timeStr, timeZone = TOUR_TIMEZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return NaN;
  const naive = Date.parse(`${dateStr}T${normalizeTime(timeStr)}:00Z`);
  if (Number.isNaN(naive)) return NaN;
  const firstPass = offsetAt(naive, timeZone);
  const secondPass = offsetAt(naive - firstPass, timeZone);
  return naive - secondPass;
}
