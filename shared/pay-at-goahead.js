// Pay at GoAhead ("mode C", model phase 4): the timing rules, with no
// database and no clock of their own. docs/phase4/payments-readiness.md
// section 9 is the design.
//
//   The traveler books with no payment. At GoAhead each booking is asked for
//   the full published price, with a deadline: the window (48 hours by
//   default) from when the link is sent, capped at the departure's cut-off,
//   never less than 24 hours unless the cut-off is sooner. A reminder at the
//   halfway point, a warning to ops 2 hours before a release, and at the
//   deadline an unpaid seat is released (Operator Supply Agreement 10.1).
export const DEFAULT_WINDOW_HOURS = 48;
export const WINDOW_HOURS_CHOICES = [24, 48];
export const PAY_FLOOR_HOURS = 24;
export const RELEASE_WARNING_HOURS = 2;
export const DEFAULT_OFFER_HOURS = 12;

const HOUR_MS = 3600000;

// When a link sent at `sentAtMs` falls due, and which rule decided it:
//   window   the full window
//   minimum  the window was shorter than the 24-hour floor (a setting below it)
//   cutoff   the cut-off came first. The cap wins over the floor: a manifest
//            never freezes with a seat still waiting for payment. A window
//            under 24 hours is a "short window" admin sees.
export function payDeadline({ sentAtMs, windowHours = DEFAULT_WINDOW_HOURS, cutoffAtMs }) {
  const sent = Number(sentAtMs);
  let dueAt = sent + Math.max(Number(windowHours) || DEFAULT_WINDOW_HOURS, PAY_FLOOR_HOURS) * HOUR_MS;
  let boundBy = Number(windowHours) < PAY_FLOOR_HOURS ? "minimum" : "window";
  const cutoff = Number(cutoffAtMs);
  if (Number.isFinite(cutoff) && cutoff < dueAt) {
    dueAt = Math.max(sent, cutoff);
    boundBy = "cutoff";
  }
  return { dueAt, boundBy, shortWindow: dueAt - sent < PAY_FLOOR_HOURS * HOUR_MS };
}

// Halfway between the link and the deadline, once.
export const reminderAt = (sentAtMs, dueAtMs) => Number(sentAtMs) + (Number(dueAtMs) - Number(sentAtMs)) / 2;
export const releaseWarningAt = (dueAtMs) => Number(dueAtMs) - RELEASE_WARNING_HOURS * HOUR_MS;

export function reminderDue(req, now) {
  if (req.state !== "sent" || req.reminderSentAt) return false;
  const due = Date.parse(req.dueAt);
  const sent = Date.parse(req.linkSentAt);
  return now >= reminderAt(sent, due) && now < due;
}

export function releaseWarningDue(req, now) {
  if (req.state !== "sent" || req.releaseWarnedAt) return false;
  const due = Date.parse(req.dueAt);
  return now >= releaseWarningAt(due) && now < due;
}

export const releaseDue = (req, now) => req.state === "sent" && now >= Date.parse(req.dueAt);

// An extension: later than the deadline it replaces, not after the cut-off,
// and with a reason.
export function extensionError({ currentDueAtMs, newDueAtMs, cutoffAtMs, reason, now }) {
  if (!String(reason || "").trim()) return "Say why the deadline is being extended.";
  const next = Number(newDueAtMs);
  if (!Number.isFinite(next)) return "Choose the new deadline.";
  if (next <= Number(currentDueAtMs)) return "The new deadline must be later than the current one.";
  if (next <= now) return "The new deadline must be in the future.";
  if (Number.isFinite(Number(cutoffAtMs)) && next > Number(cutoffAtMs)) {
    return "The deadline can't be after the cut-off: the manifest freezes then, with paid seats only.";
  }
  return null;
}

// What admin sees for each seat on a departure.
export const SEAT_STANDING = {
  awaiting_link: "Link to make",
  sent: "Awaiting payment",
  paid: "Paid",
  released: "Released (unpaid)",
  cancelled: "Canceled",
};

// Where one booking stands before the cut-off, for the manifest and admin.
export function paymentStanding(req, { agencyBilled = false } = {}) {
  if (!req) return { standing: "not_requested", label: "Payment not requested yet" };
  if (req.state === "paid") return { standing: "paid", label: agencyBilled ? "Paid (agency invoice)" : "Paid" };
  if (req.state === "sent") return { standing: "due", label: "Payment due", dueAt: req.dueAt };
  if (req.state === "awaiting_link") return { standing: "due", label: "Payment link on its way" };
  return { standing: req.state, label: SEAT_STANDING[req.state] || req.state };
}

// ---------------------------------------------------------------- waitlist
// When a seat frees up, the first waiting traveler whose party fits is
// offered it; an offer held by someone else keeps its seats.
export function nextOffer(entries, freeSeats) {
  const queue = (entries || [])
    .filter((e) => e.state === "waiting")
    .sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || (a.id - b.id));
  return queue.find((e) => Number(e.seats) <= freeSeats) || null;
}

// How long an offer is held: the setting (12 hours), never past the cut-off.
export function offerExpiresAt({ now, offerHours = DEFAULT_OFFER_HOURS, cutoffAtMs }) {
  const end = now + Math.max(1, Number(offerHours) || DEFAULT_OFFER_HOURS) * HOUR_MS;
  return Number.isFinite(Number(cutoffAtMs)) ? Math.min(end, Number(cutoffAtMs)) : end;
}
