// Numbered departures (29 Sep 2026, catalogue_v2): a product can run more than
// one departure on the same date, numbered 1, 2, … Each one is independent: its
// own GoAhead at 4, cut-off, operator, payments, manifest and settlement.
//
// The rules, as pure functions so the server, the tests and the admin screens
// read one thing:
//   - full = the maximum group is reserved;
//   - a booking goes to the LOWEST-numbered departure with room for the WHOLE
//     party. A party is never split;
//   - if none has room, the next number is opened (only the system or an admin
//     opens one).
//
// A sibling is { id, no, free, joinable }: `free` is the maximum less the seats
// held (booked, and reserved for a waitlist offer).

export const isFull = (s) => !(s.free > 0);

// The lowest-numbered joinable sibling with room for the whole party, or null.
export function pickDeparture(siblings, seats) {
  const n = Math.max(1, Number(seats) || 1);
  return [...(siblings || [])]
    .filter((s) => s.joinable && s.free >= n)
    .sort((a, b) => a.no - b.no)[0] || null;
}

// Every departure of the date is full: the system opens the next one.
export const allFull = (siblings) => (siblings || []).length > 0 && siblings.filter((s) => s.joinable).every(isFull);

// The number the next departure takes.
export const nextNumber = (siblings) => Math.max(0, ...(siblings || []).map((s) => Number(s.no) || 0)) + 1;

// Which departure a NEW booking would join, for the public date list: the
// lowest-numbered one with any room. A date whose departures are all full shows
// nothing bookable (the system opens the next one as the last fills).
export function shownDeparture(siblings) {
  return [...(siblings || [])].filter((s) => s.joinable && s.free > 0).sort((a, b) => a.no - b.no)[0] || null;
}

// A party placed whole. The party sits on `partyOn` with `partySeats` live
// seats, and `n` more are joining. It stays where it is if the joiners fit
// there; otherwise the lowest-numbered departure with room for everyone.
// `movable` says whether its members may be moved (no payment request yet).
// Returns { id } | { move: true, id } | null (nothing fits: open the next).
export function placeParty(siblings, { partyOn, partySeats, n, movable }) {
  const here = (siblings || []).find((s) => s.id === partyOn);
  if (here?.joinable && here.free >= n) return { id: here.id };
  if (!movable) return null;
  const to = [...(siblings || [])]
    .filter((s) => s.joinable && s.id !== partyOn && s.free >= partySeats + n)
    .sort((a, b) => a.no - b.no)[0];
  return to ? { id: to.id, move: true } : null;
}
