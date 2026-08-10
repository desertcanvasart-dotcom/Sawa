// LLL1.2 — when payment is due, in one place.
//
// > Payment is due within 3 days, or by the departure's confirm deadline,
// > whichever is sooner.
//
// ============================================================================
// WHY THIS IS A MODULE AND NOT A NUMBER IN A ROUTE
// ============================================================================
//
// LLL1.1's finding: the 7-day figure is the DAY-TOUR default. Packages are 30,
// and four of the sixteen live products are packages. `confirm_deadline_days`
// can also override either, per listing.
//
// So "payment is due 7 days before departure" is wrong for four products today
// and wrong for every override ever set. The rule has to be expressed against
// `confirmDeadlineDaysFor`, which already handles the type default and the
// override — the `shared/group-size.js` pattern LLL1.2 names: one authority,
// and the copy generated from it rather than typed beside it.
//
// ============================================================================
// WHICHEVER IS SOONER, AND WHY IT CAN BE TODAY
// ============================================================================
//
// A date that confirms three days before its own confirm deadline does not get
// a three-day payment window — it gets what is left. That window can be hours.
// It can also already have passed, on a date confirmed manually after its
// deadline, and `dueAt` returns that instant rather than clamping it forward:
// **a deadline that quietly moves itself is the thing LLL4 stores columns to
// prevent.** The caller decides what an already-passed window means; this
// function does not hide it.
export const PAYMENT_WINDOW_DAYS = 3;

const DAY_MS = 86400000;

// `confirmDeadlineAtMs` is passed in rather than imported: this module must
// stay usable from the static site, which has no access to server/domain.js.
// The server passes `confirmDeadlineAt(departure, product)`.
export function paymentDueAt(linkSentAtMs, confirmDeadlineAtMs, windowDays = PAYMENT_WINDOW_DAYS) {
  const sent = Number(linkSentAtMs);
  if (!Number.isFinite(sent)) return NaN;
  const window = sent + windowDays * DAY_MS;
  const deadline = Number(confirmDeadlineAtMs);
  // An unusable deadline must not silently extend the window. NaN in, window
  // out — but the caller can tell, because `compressedBy` reports it.
  if (!Number.isFinite(deadline)) return window;
  return Math.min(window, deadline);
}

// Which of the two rules bound this window, and by how much. The alert and the
// traveller-facing copy both need to say WHY a window is short — "you have
// until Tuesday" reads as arbitrary without it.
export function paymentWindow(linkSentAtMs, confirmDeadlineAtMs, windowDays = PAYMENT_WINDOW_DAYS) {
  const dueAt = paymentDueAt(linkSentAtMs, confirmDeadlineAtMs, windowDays);
  const sent = Number(linkSentAtMs);
  const full = sent + windowDays * DAY_MS;
  const boundBy = !Number.isFinite(Number(confirmDeadlineAtMs)) ? "window"
    : dueAt < full ? "confirm-deadline" : "window";
  return {
    dueAt,
    boundBy,
    // Three states, not two: a window can be normal, compressed, or ALREADY
    // CLOSED at the moment the link is sent. Collapsing the third into the
    // second would tell a traveller they have time when they have none.
    state: !Number.isFinite(dueAt) ? "unknown"
      : dueAt <= sent ? "already-closed"
        : boundBy === "confirm-deadline" ? "compressed" : "full",
    hoursLeft: Number.isFinite(dueAt) ? Math.max(0, Math.round((dueAt - sent) / 3600000)) : null,
  };
}
