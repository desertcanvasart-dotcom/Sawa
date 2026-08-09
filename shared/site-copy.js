// Interim copy: strings that are true of the CURRENT build and are expected to
// change on a known event.
//
// Both entries below are waiting on a client decision. They live here, together,
// so that when the decision lands the swap is one edit in one file rather than a
// hunt across twenty static pages, the React app, llms.txt and the email
// templates — which is how "24/7" came to be live in six places saying four
// different things.
//
// The static pages cannot import this at render time (they are hand-written
// files served off disk), so scripts/sync-constants.js writes these values into
// any element marked `data-copy="<key>"` at build time, the same way it writes
// the group-size numbers. The page keeps working as a plain document because the
// text is present in the file; the marker only says who owns it.
//
// A null value means "not yet decided". Nothing may render a null: the sync
// script refuses to write one and the audit reports it, so a placeholder cannot
// quietly become the published claim.

export const INTERIM_COPY = {
  // V1.3 — replaces "everyone's deposit is charged", which stated in the present
  // tense that money moves at GoAhead. No payment gateway exists, no card is
  // collected and nothing charges. This wording is accurate whether payment ends
  // up being taken on-site or arranged offline, so it holds under either answer.
  //
  // Swap when: the post-GoAhead payment model is decided.
  "payment-arrangement": "the date locks, the tour is confirmed, and we'll be in touch to arrange payment",

  // U4.1 — the support-availability string. Currently live in six places saying
  // four different things: "24/7", "monitored 24 hours a day", "9am–9pm Cairo
  // time" and "within two hours". Deliberately NOT populated: the true answer is
  // the client's to give, and guessing it is how the four got there.
  //
  // Swap when: the client states what is actually staffed this week.
  "support-availability": null,
};

// Keys whose value is still undecided. Anything referencing one of these must
// not be published.
export const UNDECIDED = Object.entries(INTERIM_COPY)
  .filter(([, v]) => v == null)
  .map(([k]) => k);
