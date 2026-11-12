// The partner widget (/embed/*) runs inside another company's page.
//
// 12 Nov 2026: with the site's scripts loaded there, Sawa's cookie banner
// opened inside the agency's site, over the booking form, and Sawa's analytics
// ran on a page that is not Sawa's. And the widget sent the visitor to
// sawa.tours to read the tour, which is the thing it exists to avoid.
import { test } from "node:test";
import { appSource, mainSource } from "./app-source.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
const { buildHead } = await import("./seo.js");
const { keepLinksOutOfFrame } = await import("../src/embed-links.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = /assets\/(consent|analytics|gtm)\.js/;

test("the widget's head loads no consent banner and no analytics", async () => {
  for (const path of ["/embed", "/embed/book", "/embed/book/tour/some-tour", "/embed/tour/some-tour"]) {
    const { head } = await buildHead(path);
    assert.doesNotMatch(head, SCRIPTS, `${path} must not load the site's consent or analytics scripts`);
    assert.match(head, /noindex/, `${path} stays out of search`);
  }
});

test("every other page still loads them: the guard is for the frame only", async () => {
  for (const path of ["/", "/itineraries", "/faq"]) {
    const { head } = await buildHead(path);
    for (const name of ["consent", "analytics", "gtm"]) assert.match(head, new RegExp(`assets/${name}\\.js`), `${path} lost ${name}.js`);
  }
});

test("a link clicked inside the widget opens a new tab and never navigates the frame", () => {
  const opened = [];
  globalThis.window = { location: { origin: "https://sawa.tours" }, open: (url, target) => opened.push([url, target]) };
  const click = (href, target = "") => {
    let prevented = false;
    const a = { target, getAttribute: () => href };
    keepLinksOutOfFrame({ target: { closest: () => a }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  try {
    assert.equal(click("/terms"), true);
    assert.deepEqual(opened.pop(), ["https://sawa.tours/terms", "_blank"]);
    assert.equal(click("https://example.com/x"), true);
    assert.equal(click("https://example.com/x", "_blank"), false, "already a new tab: left alone");
    assert.equal(click("#reviews"), false);
    assert.equal(click("mailto:hello@sawa.tours"), false);
    assert.equal(opened.length, 1);
  } finally { delete globalThis.window; }
});

test("the booking view shows the tour and its terms, and no link to sawa.tours for the itinerary", () => {
  const src = mainSource();
  const view = src.slice(src.indexOf("function EmbedBookTour("), src.indexOf("function SectionHeading("));
  assert.ok(view.length > 2000, "EmbedBookTour not found");
  for (const part of ["<EmbedGallery", "<EmbedOverview", "<EmbedTourDetails", "<TourReviews", "<PaymentTimeline", "<CancellationSchedule", "onClickCapture={keepLinksOutOfFrame}"]) {
    assert.ok(view.includes(part), `the widget's booking view lost ${part}`);
  }
  assert.doesNotMatch(view, /Full itinerary/, "the itinerary is in the widget; a link out for it has come back");
});

// ---- After the booking: managed in the frame, and emails that name the partner
const { withPartner, confirmBookingEmail, bookingConfirmationEmail, departureRequestReceivedEmail, payAtGoAheadBookingEmail } = await import("./email.js");

test("a booking made through a partner names the partner, in the text and the HTML of every traveler email", () => {
  const base = { to: "ana@example.test", customerName: "Ana", route: "Giza Pyramids", dateLabel: "2026-12-08", seats: 2, bookingCode: "SAWA-TESTCODE" };
  const emails = [
    confirmBookingEmail({ ...base, url: "https://sawa.tours/confirm-booking/t" }),
    bookingConfirmationEmail({ ...base, depositDue: 15, balanceDue: 135, balanceDueDate: "2026-12-06" }),
    payAtGoAheadBookingEmail({ ...base, total: 150 }),
    departureRequestReceivedEmail(base),
  ];
  for (const plain of emails) {
    const m = withPartner(plain, "Nile Gate Travel");
    assert.match(m.text, /Booked through Nile Gate Travel\./, `${plain.kind}: text part`);
    assert.match(m.html, /Booked through Nile Gate Travel\./, `${plain.kind}: HTML part`);
    assert.equal(m.subject, plain.subject);
    assert.equal(m.kind, plain.kind);
    assert.ok(m.html.length > plain.html.length && m.html.includes(plain.html.slice(-200)), `${plain.kind}: the rest of the email is unchanged`);
  }
});

test("no partner, no line; and a partner's name cannot carry markup into the email", () => {
  const plain = confirmBookingEmail({ to: "a@b.c", customerName: "Ana", route: "Giza", dateLabel: "2026-12-08", seats: 1, bookingCode: "SAWA-X", url: "https://sawa.tours/c/t" });
  assert.deepEqual(withPartner(plain, ""), plain);
  assert.deepEqual(withPartner(plain, null), plain);
  const m = withPartner(plain, '<img src=x onerror="alert(1)"> Tours');
  assert.doesNotMatch(m.html, /<img src=x/);
  assert.match(m.html, /&lt;img src=x/);
});

test("the widget manages a booking in the frame: its own route, the shared lookup, and no link to sawa.tours when it can", () => {
  const src = mainSource();
  assert.match(src, /embedPath\.match\(\/\^\\\/embed\\\/booking/, "the /embed/booking route is gone");
  const book = src.slice(src.indexOf("function EmbedBook("), src.indexOf("function EmbedBookTour("));
  assert.match(book, /<BookingLookupPage key=\{managing\} embed /, "the widget's booking view must be the site's own lookup, not a copy");
  const tour = src.slice(src.indexOf("function EmbedBookTour("), src.indexOf("function SectionHeading("));
  assert.match(tour, /onManage\s*\? </, "the done panel opens the booking in the frame when the widget can show it");
});

// ---- Which partner: server/partner.js
const { partnerName, throughPartner } = await import("./partner.js");
const fakeDb = (name = "Nile Gate Travel") => {
  const seen = [];
  return { seen, query: async (sql, args) => { seen.push([sql.replace(/\s+/g, " "), args]); return { rows: name ? [{ name }] : [] }; } };
};

test("the partner is read from the booking's own code, whichever way the caller names the booking", async () => {
  for (const [key, where, args] of [
    [{ refCode: "Nile-Gate" }, /WHERE r\.code = \$1 AND r\.active/, ["nile-gate"]],
    [{ pledgeId: "pl_1" }, /p\.id = \$1 AND p\.ref_code IS NOT NULL/, ["pl_1"]],
    [{ bookingCode: "sawa-abc" }, /UPPER\(p\.booking_code\) = UPPER\(\$1\)/, ["sawa-abc"]],
    [{ departureId: 7, email: "Ana@Example.test" }, /p\.departure_id = \$1 AND LOWER\(p\.customer_email\) = LOWER\(\$2\)/, [7, "Ana@Example.test"]],
  ]) {
    const db = fakeDb();
    assert.equal(await partnerName(db, key), "Nile Gate Travel");
    assert.match(db.seen[0][0], where);
    assert.deepEqual(db.seen[0][1], args);
    assert.match(db.seen[0][0], /r\.active/, "a switched-off partner code names nobody");
  }
});

test("no booking named, no partner, a failed lookup: the email goes without the line, never fails", async () => {
  const plain = confirmBookingEmail({ to: "a@b.c", customerName: "Ana", route: "Giza", dateLabel: "2026-12-08", seats: 1, bookingCode: "SAWA-X", url: "https://sawa.tours/c/t" });
  const none = fakeDb();
  assert.equal(await partnerName(none, {}), "");
  assert.equal(none.seen.length, 0, "nothing to look up, nothing asked");
  assert.equal(await partnerName(fakeDb(null), { pledgeId: "pl_1" }), "");
  const down = { query: async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }); } };
  assert.deepEqual(await throughPartner(down, { pledgeId: "pl_1" }, plain), plain);
  assert.match((await throughPartner(fakeDb(), { pledgeId: "pl_1" }, Promise.resolve(plain))).text, /Booked through Nile Gate Travel\./, "a promised message is awaited");
  const skipped = fakeDb();
  assert.deepEqual(await throughPartner(skipped, { pledgeId: "pl_1" }, plain, { skip: true }), plain);
  assert.equal(skipped.seen.length, 0, "a copy addressed to the agency itself is not looked up");
});

// The templates a traveler receives about a booking. Each must be sent through
// throughPartner (or forPartner, its shorthand in app.js), or a partner's
// customer gets an email from a company they have not heard of.
test("every traveler email about a booking is sent through the partner lookup", () => {
  const files = ["app.js", "pay-at-goahead.js", "booking-details.js", "catalogue-notices.js", "reviews.js", "jobs/cancel-unconfirmed.js", "jobs/notify-goahead.js"];
  const src = files.map((f) => (f === "app.js" ? appSource() : readFileSync(join(ROOT, "server", f), "utf8"))).join("\n");
  const templates = ["confirmBookingEmail", "payAtGoAheadBookingEmail", "departureRequestReceivedEmail", "departureRequestApprovedEmail",
    "paymentLinkEmail", "paymentReceivedEmail", "belowMinimumCancellationEmail", "reviewRequestEmail", "bookingDetailsRequestEmail",
    "payAtGoAheadLinkEmail", "payAtGoAheadReminderEmail", "payAtGoAheadReleasedEmail", "payAtGoAheadApologyEmail", "payAtGoAheadReceiptEmail",
    "payAtGoAheadSellerChangedEmail"];
  const bare = [];
  for (const t of templates) {
    const calls = [...src.matchAll(new RegExp(`(.{0,90})\\b${t}\\(\\{`, "g"))];
    assert.ok(calls.length > 0, `${t} is not sent from anywhere this test reads`);
    for (const c of calls) if (!/(throughPartner|forPartner)\([^()]*(\{[^{}]*\})?[^()]*,\s*$/.test(c[1]) && !/\.then\(\(view\) => $/.test(c[1])) bare.push(`${t}: …${c[1].trim().slice(-60)}`);
  }
  assert.deepEqual(bare, []);
});

// ---- The new catalogue in the widget, the agency's choice of tours, the font
test("the snippet handles all three return links and sends the page's font", () => {
  const dash = readFileSync(join(ROOT, "src", "AgencyDashboard.jsx"), "utf8");
  const script = /const EMBED_SCRIPT = `([\s\S]*?)`;/.exec(dash)[1];
  for (const part of ["q.get('sawa-booking')", "q.get('sawa-confirm')", "q.get('sawa-join')", "'/embed/booking/'", "'/embed/confirm/'", "'/embed/join/'", "font:c.fontFamily", "page:location.href"]) {
    assert.ok(script.includes(part), `the snippet lost ${part}`);
  }
  const main = mainSource();
  for (const route of ["booking", "confirm", "join"]) assert.match(main, new RegExp(`embedPath\\.match\\(/\\^\\\\/embed\\\\/${route}`), `/embed/${route} has no route in the widget`);
});

test("the widget's booking view: group links, dates by month, and the group's own date", () => {
  const src = mainSource();
  const tour = src.slice(src.indexOf("function EmbedBookTour("), src.indexOf("function SectionHeading("));
  assert.match(tour, /<JoinGroupLink code=\{b\.bookingCode\} \/>/, "the done panel offers the group link");
  // Retired 12 Nov 2026: a full departure is never listed, so the form could
  // not be reached. It must not come back half-wired.
  assert.doesNotMatch(src, /WaitlistJoin/, "the public waitlist form was retired");
  assert.match(tour, /const byMonth = dates\.length > 8 && months\.length > 1;/, "a long calendar is shown a month at a time");
  assert.match(tour, /partyToken: party\.token/, "a booking through a group link carries the link");
  assert.match(tour, /Number\(dep\?\.id\) === Number\(partyDate\.id\) \? \{ partyToken/, "…and only on the group's own date");
  const book = src.slice(src.indexOf("function EmbedBook("), src.indexOf("function EmbedBookTour("));
  assert.match(book, /const chosen = embedToursFromUrl\(\);/, "the partner's choice of tours");
  assert.match(book, /!chosen\.length \|\| chosen\.includes\(String\(p\.id\)\)/, "no choice lists every tour");
});
