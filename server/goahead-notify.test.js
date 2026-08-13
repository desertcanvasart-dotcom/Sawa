// The traveller half of GoAhead — the email the booking confirmation promises.
//
// Pure: no database. The queue's SQL is proved by inspection (as its sibling's
// is), and the parts a traveller actually sees are proved by execution.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportNotices, GOAHEAD, GOAHEAD_ALERT, GOAHEAD_NOTIFIED } from "./goahead-alert.js";
import { dateLabelFor } from "./jobs/notify-goahead.js";
import { goAheadNotifyDryRun } from "./jobs/scheduler.js";
import { bookingConfirmationEmail } from "./email.js";
import { bookingLookupView } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---- the promise this exists to keep ---------------------------------------

test("the booking confirmation still promises this email", () => {
  // If this sentence is ever removed, the job below is no longer keeping a
  // promise and this test should be reconsidered rather than deleted. It is
  // asserted here, next to the machinery, because that is the link a reader
  // needs and the two files are otherwise unconnected.
  const mail = bookingConfirmationEmail({
    to: "a@b.c", route: "Giza", dateLabel: "2026-09-12", seats: 1,
    depositDue: 7, balanceDue: 56, balanceDueDate: "2026-09-01", bookingCode: "SAWA-ABCD2345",
  });
  assert.match(mail.text, /we'll email you when that happens/i);
});

test("the queue's marker is distinct from the ops alert's", () => {
  // One marker for both sends would mean either one suppressing the other:
  // ops gets its prompt, the travellers are recorded as told, and nobody is.
  assert.notEqual(GOAHEAD_NOTIFIED, GOAHEAD_ALERT);
  assert.notEqual(GOAHEAD_NOTIFIED, GOAHEAD);
  assert.equal(GOAHEAD_NOTIFIED, "departure.goahead_notified");
});

test("both queues derive from the same confirmation action", () => {
  // They must agree on what "confirmed" means. They share one query for it.
  const src = read("server/goahead-alert.js");
  assert.match(src, /async function pendingFor\(marker/,
    "the queue query is shared, not copied per marker");
  assert.equal((src.match(/FROM departures d/g) || []).length, 1,
    "a second hand-written copy of the queue query is how the two would drift");
});

// ---- what a traveller is told ----------------------------------------------

test("a cancelled traveller is excluded from the recipients", () => {
  // MM1 — a traveller who cancelled their own booking is not on this date, and
  // telling them it is confirmed is a message to a named person stating
  // something untrue about their booking. It shipped once on the older paths.
  const src = read("server/jobs/notify-goahead.js");
  assert.match(src, /status <> 'cancelled'/, "cancelled pledges must not be emailed");
  assert.match(src, /SELECT DISTINCT customer_email/,
    "one person holding two bookings on a date should be told once");
});

test("dates render as YYYY-MM-DD even though pg returns Date objects", () => {
  // YY3 — the host-timezone rendering that put a full JS Date string in an
  // operations email. This one is customer-facing.
  const label = dateLabelFor({ start_date: new Date(2026, 8, 19), end_date: null });
  assert.equal(label, "2026-09-19");
});

test("a single-day departure does not render as a range", () => {
  // Two Date objects are never !==-equal, so a naive comparison prints "X – X".
  const d = new Date(2026, 8, 19);
  assert.equal(dateLabelFor({ start_date: d, end_date: new Date(2026, 8, 19) }), "2026-09-19");
  assert.equal(dateLabelFor({ start_date: "2026-09-19", end_date: "2026-09-24" }), "2026-09-19 – 2026-09-24");
});

// ---- the switch ------------------------------------------------------------

test("it will not email customers until it is told to", () => {
  // The queue is derived from HISTORY, so the first live tick reaches every
  // traveller on every departure that ever confirmed — including trips that
  // have already happened.
  assert.equal(goAheadNotifyDryRun({}), true, "unset must mean dry");
  assert.equal(goAheadNotifyDryRun({ GOAHEAD_NOTIFY_DRY_RUN: "1" }), true);
  assert.equal(goAheadNotifyDryRun({ GOAHEAD_NOTIFY_DRY_RUN: "0" }), false);
});

test("it has its own switch, separate from the ops alert", () => {
  const src = read("server/jobs/scheduler.js");
  assert.match(src, /GOAHEAD_NOTIFY_DRY_RUN/);
  // Going live with the internal prompt must not silently go live with mail to
  // customers.
  assert.ok(!/GOAHEAD_ALERT_DRY_RUN[\s\S]{0,80}goAheadNotifyDryRun/.test(src),
    "the two dry-run switches must not be the same variable");
});

test("the job documents how to adopt it without emailing the whole backlog", () => {
  const src = read("server/jobs/notify-goahead.js");
  assert.match(src, /goahead_notified/);
  assert.match(src, /INSERT INTO audit_log/, "the backfill is written down, not left as folklore");
});

// ---- the record is the queue -----------------------------------------------

test("the marker is written only after the emails were accepted", () => {
  const src = read("server/jobs/notify-goahead.js");
  const send = src.indexOf("await sendEmail(");
  const mark = src.indexOf("await markNotified(pool, departure.id, { recipients: to.length }");
  assert.ok(send > -1 && mark > send,
    "a notice nobody received must not look like one that was delivered");
});

test("a departure with nobody to email is done, not permanently failed", () => {
  // Otherwise it reports a shortfall forever and trains the reader to ignore
  // the number that means real people were not told.
  const src = read("server/jobs/notify-goahead.js");
  assert.match(src, /no contactable traveller/);
});

test("it fires — a shortfall is an error, not a quiet success", () => {
  const errors = [];
  const ok = reportNotices({ intended: 3, sent: 1, log: () => {}, error: (m) => errors.push(m) });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /NOTICE SHORTFALL/);
  assert.match(errors[0], /we'll email you when that happens/,
    "the message should say what was promised, not just count failures");
});

test("it stops — a full send and an empty queue are both success", () => {
  const errors = [];
  const cap = { log: () => {}, error: (m) => errors.push(m) };
  assert.equal(reportNotices({ intended: 0, sent: 0, ...cap }), true);
  assert.equal(reportNotices({ intended: 2, sent: 2, ...cap }), true);
  assert.equal(errors.length, 0);
});

test("the send is driven by the milestone record, not by a route", () => {
  // DIR-20.1 — refreshStatus has four callers under three transaction
  // boundaries. A trigger in one route fires for that route and no other.
  const job = read("server/jobs/notify-goahead.js");
  assert.match(job, /pendingGoAheadNotices/);
  const app = read("server/app.js");
  assert.ok(!/runGoAheadNotices/.test(app),
    "notices must not be sent from a request handler");
});

// ---- the cancel link (task 2, same email) -----------------------------------

test("the confirmation email carries a link that survives the tab closing", () => {
  const mail = bookingConfirmationEmail({
    to: "a@b.c", route: "Giza", dateLabel: "2026-09-12", seats: 1,
    depositDue: 7, balanceDue: 56, balanceDueDate: "2026-09-01", bookingCode: "SAWA-ABCD2345",
  });
  assert.match(mail.html, /\/booking\/SAWA-ABCD2345/, "no link in the HTML mail");
  assert.match(mail.text, /\/booking\/SAWA-ABCD2345/, "no link in the plain-text mail");
  assert.match(mail.text, /cancel your seat, free, any time before GoAhead/i);
});

test("a booking with no code gets no broken link", () => {
  const mail = bookingConfirmationEmail({
    to: "a@b.c", route: "Giza", dateLabel: "2026-09-12", seats: 1,
    depositDue: 7, balanceDue: 56, balanceDueDate: "2026-09-01", bookingCode: null,
  });
  assert.ok(!/\/booking\//.test(mail.html), "an undefined code must not reach a URL");
  assert.ok(!/\/booking\//.test(mail.text));
});

test("the link points at the code, not at the pledge id", () => {
  // The pledge id is pl_<departureId>_<time36><6 hex> — 24 bits behind a
  // guessable timestamp. The booking code is 8 of 31 characters, ~8.5e11.
  const mail = bookingConfirmationEmail({
    to: "a@b.c", route: "Giza", dateLabel: "2026-09-12", seats: 1,
    depositDue: 7, balanceDue: 56, balanceDueDate: "2026-09-01", bookingCode: "SAWA-ABCD2345",
  });
  assert.ok(!/pl_/.test(mail.html), "the weak handle must not be mailed out");
});

// ---- who may cancel --------------------------------------------------------

const view = (o) => bookingLookupView({ goAhead: 4, seatsBooked: 0, ...o });

test("a forming booking may be released by its holder", () => {
  assert.equal(view({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 2 }).canCancel, true);
});

test("a confirmed date is not a free self-service cancel", () => {
  // Terms §13.1/§13.2: free before GoAhead, and after it "the cancellation
  // schedule … applies" — Sawa's own by default. A one-click release past
  // GoAhead would waive a charge the Terms say is due.
  assert.equal(view({ departureStatus: "open", pledgeStatus: "confirmed", seatsBooked: 4 }).canCancel, false);
  assert.equal(view({ departureStatus: "supplier_confirmed", pledgeStatus: "confirmed" }).canCancel, false);
});

test("nothing already cancelled offers a cancel button", () => {
  assert.equal(view({ departureStatus: "cancelled", pledgeStatus: "confirmed" }).canCancel, false);
  assert.equal(view({ departureStatus: "open", pledgeStatus: "cancelled" }).canCancel, false);
});

test("the page asks the server whether cancelling is allowed", () => {
  // Same argument as showProgress and note, both of which moved into domain.js
  // after the page chose them from `confirmed` alone.
  const src = read("src/main.jsx");
  assert.match(src, /b\.canCancel &&/, "the button must be gated on the server's answer");
});

test("cancelling is a POST, so a link prefetch cannot release a seat", () => {
  const app = read("server/app.js");
  assert.match(app, /app\.post\("\/api\/public\/bookings\/:code\/cancel"/,
    "a GET here would let a mail client cancel a booking by scanning the message");
  const ui = read("src/main.jsx");
  assert.match(ui, /setConfirming\(true\)/, "the destructive action needs a confirm step");
});

test("cancelling marks the pledge rather than deleting it", () => {
  // Deleting makes the code stop resolving, so the lookup answers "no booking
  // found" to someone who just cancelled. `booking_cancelled` is a state
  // domain.js already computes and already has copy for.
  const app = read("server/app.js");
  assert.match(app, /UPDATE pledges SET status='cancelled' WHERE id=\$1/);
  assert.match(app, /await refreshStatus\(c, dep\.id\)/,
    "releasing a seat must recompute the departure's status");
});

test("the cancel route is idempotent", () => {
  // A traveller clicking twice, or a client retrying, must not get a 404 that
  // reads as though something went wrong.
  const app = read("server/app.js");
  assert.match(app, /alreadyDone: true/);
});
