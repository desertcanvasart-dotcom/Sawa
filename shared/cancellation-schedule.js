// What a traveller is charged if they cancel, and when. One declaration.
//
// ============================================================================
// WHY THIS IS AN AUTHORITY AND NOT THREE PARAGRAPHS
// ============================================================================
//
// These bands are a fee schedule. Terms §13.2 makes them binding only if they
// were disclosed — "The cancellation schedule displayed before you reserve, and
// repeated in the booking confirmation, applies" — so the same numbers now have
// to appear in three places that cannot import from each other:
//
//   site/terms.html            a hand-written static document, served off disk
//   the booking rail           React, before the traveller commits
//   the confirmation email     a server-rendered template
//
// That is precisely the shape that produced "24/7" in six locations saying four
// different things, and the group-size numbers in twenty files. A fee schedule
// drifting the same way is not a copy defect: whichever version is lowest is the
// one a traveller will hold Sawa to, and whichever is highest is the one that
// looks like a bait-and-switch.
//
// So the numbers live here. The two importable surfaces read them, and
// `server/cancellation-schedule.test.js` parses the table out of terms.html and
// fails the build if it disagrees.
//
// ============================================================================
// WHY THE TERMS ARE CHECKED, NOT REWRITTEN
// ============================================================================
//
// scripts/sync-constants.js writes the group-size numbers INTO the static pages,
// and its own header records why that is only safe where "the surrounding words
// fix the meaning". A cancellation table is legal text: a regex that rewrote the
// wrong cell would change what Sawa may charge, silently, in the document that
// governs the transaction. So this one is REPORTED and a human edits it — the
// same call the script makes for prose, for the same reason.
//
// Confirmed correct by the client, 13 August 2026.

// Ordered as the Terms order them: furthest from departure first.
//
// `fromDays` / `toDays` are inclusive day counts before departure, and exist so
// a future feature can compute what a given cancellation would cost. Nothing
// computes with them yet, and that is deliberate — no code should quietly start
// charging from a table whose only current job is disclosure.
export const CANCELLATION_BANDS = [
  { fromDays: 46, toDays: null, when: "46 days or more before departure", charge: "Deposit paid" },
  { fromDays: 30, toDays: 45, when: "30–45 days before departure", charge: "Greater of the deposit or 50% of the Tour Price" },
  { fromDays: null, toDays: 29, when: "Fewer than 30 days before departure, or no-show", charge: "100% of the Tour Price" },
];

// The column headings, so the three surfaces label the same numbers the same
// way. "Written cancellation received" is doing real work: the charge depends on
// when NOTICE arrives, not on when the traveller decided.
export const CANCELLATION_COLUMNS = {
  when: "Written cancellation received",
  charge: "Cancellation charge",
};

// The half of the schedule that applies to most people who ever cancel, and the
// half worth stating first: before GoAhead there is no schedule, because there
// is no money. Terms §13.1.
export const CANCELLATION_BEFORE_GOAHEAD =
  "Before GoAhead you can cancel free, at any time — no Tour Price is captured, so there is no charge and nothing to refund.";

// Stated wherever the bands are, because the bands are the DEFAULT and not
// necessarily the schedule that binds. Terms §13.2 again: an Operating Partner's
// own schedule applies "only if it was clearly disclosed before reservation".
export const CANCELLATION_QUALIFIER =
  "This is our default schedule. An operator's own schedule applies only where it was disclosed before you reserved.";
