import React from "react";

/* A month calendar for requesting a date.
   ------------------------------------------------------------------------
   Replaces two different pickers that disagreed about what was reachable:

     restricted tours   twelve chips, generated inside a 90-day loop that also
                        stopped at twelve — so a Mon/Sat cruise showed six weeks
                        and nothing beyond, and October was simply not offered
     unrestricted tours a native <input type="date">, which does show a calendar
                        but cannot grey out the days a tour does not run

   One grid now serves both. A tour with no operating days has every weekday
   open; a cruise on Mondays and Saturdays has the rest of the week visibly
   disabled rather than absent — the difference between "not offered" and "not
   possible", which is the thing a chip list cannot express.

   Every disabled reason is one the SERVER also enforces: lead time, horizon,
   operating day, operator blackout. The calendar is a convenience, never the
   authority — a date that slips through still gets refused with a sentence. */
export function RequestCalendar({ value, onPick, operatingDays = [], blockedDates, minIso, maxIso, monthCursor, onCursorChange }) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();

  // Bounds compared as YYYY-MM-DD strings. Date arithmetic across a DST change
  // is how an off-by-one day gets into a picker, and these are already dates.
  const withinMonth = (delta) => {
    const c = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + delta, 1);
    const lastOfMonth = iso(new Date(c.getFullYear(), c.getMonth() + 1, 0));
    const firstOfMonth = iso(c);
    return lastOfMonth >= minIso && firstOfMonth <= maxIso;
  };

  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), d);
    const key = iso(date);
    const reason =
      key < minIso ? "too soon"
      : key > maxIso ? "too far ahead"
      : operatingDays.length && !operatingDays.includes(date.getDay()) ? "doesn't run this day"
      : blockedDates && blockedDates.has(key) ? "unavailable"
      : null;
    cells.push({ key, d, disabled: !!reason, reason });
  }

  return (
    <div className="req-cal">
      <div className="req-cal-head">
        <button type="button" onClick={() => onCursorChange(-1)} disabled={!withinMonth(-1)} aria-label="Previous month">‹</button>
        <strong>{monthCursor.toLocaleDateString("en", { month: "long", year: "numeric" })}</strong>
        <button type="button" onClick={() => onCursorChange(1)} disabled={!withinMonth(1)} aria-label="Next month">›</button>
      </div>
      <div className="req-cal-grid" role="grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} className="req-cal-dow" aria-hidden="true">{d}</span>
        ))}
        {cells.map((c, i) => c === null
          ? <span key={`pad${i}`} />
          : (
            <button
              key={c.key} type="button"
              className={`req-cal-day${value === c.key ? " on" : ""}`}
              disabled={c.disabled}
              aria-pressed={value === c.key}
              /* The reason is on the element, not only in a colour: a greyed
                 square tells a visitor nothing about WHY the day is closed. */
              title={c.disabled ? c.reason : undefined}
              onClick={() => onPick(c.key)}
            >{c.d}</button>
          ))}
      </div>
    </div>
  );
}
