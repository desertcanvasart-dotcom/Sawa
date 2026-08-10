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
  // ANSWERED 10 Aug 2026 (DIR-18): a secure payment link is sent after GoAhead,
  // into Sawa's own merchant account. Sent manually for now, which is a fact
  // about operations rather than about what the traveller is told.
  //
  // "we'll be in touch to arrange payment" was written when no payment model
  // existed and had to hold under either answer. It no longer has to.
  "payment-arrangement": "the date locks, the tour is confirmed, and we send you a secure payment link",

  // U4.1 — the support-availability string. Currently live in six places saying
  // four different things: "24/7", "monitored 24 hours a day", "9am–9pm Cairo
  // time" and "within two hours". Deliberately NOT populated: the true answer is
  // the client's to give, and guessing it is how the four got there.
  //
  // ANSWERED 10 Aug 2026 (DIR-17): support is genuinely staffed 24/7, via
  // WhatsApp.
  //
  // DIR-17.2 — the channel is NAMED, deliberately. "24/7 support" is a claim a
  // reader cannot check; "WhatsApp, answered 24/7" is one they verify with their
  // first message. The four strings this replaces were all unverifiable in that
  // sense, which is part of how they drifted apart without anyone noticing.
  //
  // Written as a noun phrase so it drops into every sentence as a unit. The
  // surrounding prose bends to the config value, not the other way round —
  // otherwise there are four grammars again and the drift restarts.
  "support-availability": "WhatsApp, answered 24/7",
};

// Keys whose value is still undecided. Anything referencing one of these must
// not be published.
export const UNDECIDED = Object.entries(INTERIM_COPY)
  .filter(([, v]) => v == null)
  .map(([k]) => k);
