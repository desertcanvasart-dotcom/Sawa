// The two numbers in the booking conditions, and nothing else.
//
// "Every Sawa departure runs with a minimum of 4 and a maximum of 12 travelers"
// is a term of the contract. It is stated on the homepage, the how-it-works
// page, the GoAhead promise, in the terms, in the React app, and in twenty
// static HTML files. It is enforced by validation in server/domain.js and by
// CHECK constraints in the database.
//
// This module exists so all of that reads ONE declaration. It cannot live in
// server/domain.js, which is where the rules live: domain.js imports tz.js,
// tz.js reads process.env, and the browser has no process — so the React app
// kept its own `const DEFAULT_GO_AHEAD = 4` and the two were free to drift.
//
// Deliberately dependency-free. Anything imported here would be imported into
// the browser bundle and into every server module that touches a price.
//
// server/domain.js re-exports these, so `import { MAX_GROUP_SIZE } from
// "./domain.js"` keeps working everywhere it is already written.

// The default number of travellers a date confirms at, and the floor beneath
// which no listing may be published. A listing may require MORE — a nine-day
// cruise is not viable at four — so this is a default and a minimum, never a
// fixed value. The real threshold for a date is on the date.
export const DEFAULT_GO_AHEAD = 4;

// The hard ceiling. Universal, unlike the threshold: it applies to every
// itinerary, and it is the promise the site markets. Raising it means changing
// what the booking conditions say, so it is deliberately a literal here rather
// than anything configurable.
export const MAX_GROUP_SIZE = 12;

// Prose says "four travellers", a stat display says "4". Both come from the
// constant, so raising either number updates the sentence and the figure
// together — see scripts/sync-constants.js, which writes them into the static
// pages, and server/constants.test.js, which fails the build if they drift.
const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

export function numberWord(n) {
  return WORDS[n] ?? String(n);
}

export const GO_AHEAD_WORD = numberWord(DEFAULT_GO_AHEAD);
export const GROUP_MAX_WORD = numberWord(MAX_GROUP_SIZE);
