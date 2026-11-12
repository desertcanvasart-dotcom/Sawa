// Returning a traveler to the partner's own page from Sawa's emails (070).
//
// The page address comes from a browser, so the rule that decides whether an
// email may link to it is the whole safety of the feature: only pages on the
// website the partner registered, over https.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWebsite, partnerPageUrl, withWidgetParam } from "../shared/partner-page.js";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
const { partnerOf, partnerPageFor, throughPartner, linkBookingToPartnerPage, confirmLink, rememberPartnerPage, forget070 } = await import("./partner.js");
const { bookingConfirmationEmail, paymentLinkEmail } = await import("./email.js");

test("a website is stored as its https origin, and only a public https site is one", () => {
  assert.equal(normalizeWebsite("nilegate.com"), "https://nilegate.com");
  assert.equal(normalizeWebsite(" https://WWW.NileGate.com/tours?x=1 "), "https://www.nilegate.com");
  for (const bad of ["", "http://nilegate.com", "https://127.0.0.1", "https://localhost", "https://nilegate.com:8443", "https://user:pw@nilegate.com",
    "javascript:alert(1)", "nile gate.com", "ftp://nilegate.com", "https://intranet"]) {
    assert.equal(normalizeWebsite(bad), null, `${JSON.stringify(bad)} must not be accepted`);
  }
});

test("a page is linked to only on the partner's registered site", () => {
  const site = "https://www.nilegate.com";
  assert.equal(partnerPageUrl("https://nilegate.com/tours?lang=en#book", site), "https://nilegate.com/tours?lang=en", "www or not, same site; the fragment goes");
  assert.equal(partnerPageUrl("https://www.nilegate.com/tours?sawa-booking=OLD&a=1", site), "https://www.nilegate.com/tours?a=1", "the widget's own parameters are not carried forward");
  for (const [page, why] of [
    ["https://evil.example/tours", "another site"],
    ["https://nilegate.com.evil.example/", "the site's name as a prefix"],
    ["https://evil.example/nilegate.com", "the site's name in the path"],
    ["https://shop.nilegate.com/", "a subdomain the partner did not register"],
    ["http://nilegate.com/tours", "not https"],
    ["https://nilegate.com:8443/", "a port"],
    ["javascript:alert(1)", "not a web address"],
    ["", "nothing"],
    [`https://nilegate.com/${"x".repeat(700)}`, "too long"],
  ]) assert.equal(partnerPageUrl(page, site), null, why);
  assert.equal(partnerPageUrl("https://nilegate.com/tours", null), null, "no registered website, no link back");
  assert.equal(partnerPageUrl("https://nilegate.com/tours", "http://nilegate.com"), null, "a stored website that is not https counts as none");
});

test("the page carries exactly one instruction for the widget", () => {
  assert.equal(withWidgetParam("https://nilegate.com/tours?lang=en", "sawa-booking", "SAWA-ABCD2345"), "https://nilegate.com/tours?lang=en&sawa-booking=SAWA-ABCD2345");
  assert.equal(withWidgetParam("https://nilegate.com/?sawa-booking=X", "sawa-confirm", "t ok"), "https://nilegate.com/?sawa-confirm=t+ok");
  assert.throws(() => withWidgetParam("https://nilegate.com/", "redirect", "x"), /unknown widget parameter/);
  assert.equal(confirmLink("https://sawa.tours/confirm-booking/t", "t", null), "https://sawa.tours/confirm-booking/t");
  assert.equal(confirmLink("https://sawa.tours/confirm-booking/t", "t", "https://nilegate.com/tours"), "https://nilegate.com/tours?sawa-confirm=t");
});

const db = (row, { missing070 = false } = {}) => {
  const seen = [];
  return { seen, query: async (sql, args) => {
    seen.push([sql.replace(/\s+/g, " "), args]);
    if (missing070 && /website|partner_page_url/.test(sql)) throw Object.assign(new Error('column "website" does not exist'), { code: "42703" });
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  } };
};

test("a new booking keeps the reported page only when it is on the partner's site", async () => {
  forget070();
  const partner = { name: "Nile Gate Travel", website: "https://nilegate.com" };
  assert.equal(await partnerPageFor(db(partner), "nile-gate", "https://www.nilegate.com/tours"), "https://www.nilegate.com/tours");
  assert.equal(await partnerPageFor(db(partner), "nile-gate", "https://evil.example/phish"), null);
  assert.equal(await partnerPageFor(db({ name: "Nile Gate Travel", website: null }), "nile-gate", "https://nilegate.com/tours"), null, "the partner registered no website");
  assert.equal(await partnerPageFor(db(null), "unknown-code", "https://nilegate.com/tours"), null, "no such partner");
  const untouched = db(partner);
  assert.equal(await partnerPageFor(untouched, "nile-gate", ""), null);
  assert.equal(untouched.seen.length, 0, "no page reported, nothing looked up");
});

test("before migration 070 the partner is still named, and nothing links back", async () => {
  forget070();
  const old = db({ name: "Nile Gate Travel", booking_code: "SAWA-ABCD2345" }, { missing070: true });
  assert.deepEqual(await partnerOf(old, { pledgeId: "pl_1" }), { name: "Nile Gate Travel", pageUrl: null, bookingCode: "SAWA-ABCD2345" });
  assert.equal(old.seen.length, 2, "asked with the new columns once, then without");
  await partnerOf(old, { refCode: "nile-gate", pageUrl: "https://nilegate.com/tours" });
  assert.equal(old.seen.length, 3, "and not asked for them again");
  assert.equal(await rememberPartnerPage(old, "SAWA-ABCD2345", "https://nilegate.com/tours"), false);
  assert.equal(old.seen.length, 3, "nothing is written to a column that is not there");
  forget070();
});

test("a later email about the booking links to the partner's page, and only for its own booking code", async () => {
  forget070();
  const row = { name: "Nile Gate Travel", booking_code: "SAWA-ABCD2345", partner_page_url: "https://nilegate.com/tours?lang=en", website: "https://nilegate.com" };
  const mail = paymentLinkEmail({ to: "a@b.c", customerName: "Ana", route: "Giza", dateLabel: "8 Dec", kind: "deposit", amount: 15, dueAt: "2026-12-01T10:00:00Z", url: "https://pay.example/x", bookingCode: "SAWA-ABCD2345" });
  assert.match(mail.text + mail.html, /\/booking\/SAWA-ABCD2345/, "the template links to Sawa's booking page");
  const out = await throughPartner(db(row), { pledgeId: "pl_1" }, mail);
  assert.doesNotMatch(out.text + out.html, /\/booking\/SAWA-ABCD2345/);
  assert.match(out.text, /https:\/\/nilegate\.com\/tours\?lang=en&sawa-booking=SAWA-ABCD2345/);
  assert.match(out.html, /href="https:\/\/nilegate\.com\/tours\?lang=en&amp;sawa-booking=SAWA-ABCD2345"/);
  assert.match(out.text, /https:\/\/pay\.example\/x/, "the payment link is untouched");
  assert.match(out.text, /Booked through Nile Gate Travel\./);

  // The partner changed its website since: the stored page no longer passes.
  const moved = await throughPartner(db({ ...row, website: "https://newsite.example" }), { pledgeId: "pl_1" }, mail);
  assert.match(moved.text + moved.html, /\/booking\/SAWA-ABCD2345/);

  const first = bookingConfirmationEmail({ to: "a@b.c", customerName: "Ana", route: "Giza", dateLabel: "8 Dec", seats: 1, depositDue: 1, balanceDue: 2, balanceDueDate: "x", bookingCode: "SAWA-ABCD2345" });
  assert.deepEqual(linkBookingToPartnerPage(first, { pageUrl: "https://nilegate.com/tours", bookingCode: "SAWA-OTHER999" }), first, "another booking's code rewrites nothing");
  assert.match(linkBookingToPartnerPage(first, { pageUrl: "https://nilegate.com/tours", bookingCode: "SAWA-ABCD2345" }).text, /\/terms/, "the terms link stays Sawa's");
});

// ---- "Join my group" from a partner's page
const { partnerJoinUrl } = await import("./partner.js");

test("a group link made on a partner's page brings friends to that page; otherwise it is Sawa's", async () => {
  forget070();
  const sawa = "https://sawa.tours/join/abcDEF123_-x";
  const onPartner = db({ name: "Nile Gate Travel", booking_code: "SAWA-ABCD2345", partner_page_url: "https://nilegate.com/tours", website: "https://nilegate.com" });
  assert.equal(await partnerJoinUrl(onPartner, "SAWA-ABCD2345", sawa), "https://nilegate.com/tours?sawa-join=abcDEF123_-x");
  assert.equal(await partnerJoinUrl(db({ name: "Nile Gate Travel", booking_code: "SAWA-ABCD2345", partner_page_url: null, website: "https://nilegate.com" }), "SAWA-ABCD2345", sawa), sawa, "booked without a page");
  assert.equal(await partnerJoinUrl(db(null), "SAWA-ABCD2345", sawa), sawa, "not a partner booking");
  const untouched = db(null);
  assert.equal(await partnerJoinUrl(untouched, "SAWA-ABCD2345", null), null);
  assert.equal(untouched.seen.length, 0, "no link yet, nothing looked up");
});

test("a direct booking (no partner code) costs no lookup, even though its key carries the booking code", async () => {
  forget070();
  const asked = db({ name: "Somebody Else", booking_code: "SAWA-ABCD2345" });
  for (const refCode of [undefined, null, "", "   "]) {
    assert.deepEqual(await partnerOf(asked, { refCode, pageUrl: undefined, bookingCode: "SAWA-ABCD2345" }), { name: "", pageUrl: null, bookingCode: null });
  }
  assert.equal(asked.seen.length, 0, "no partner code, nothing to look up");
  // Without the refCode key at all, the booking code IS the question.
  assert.equal((await partnerOf(asked, { bookingCode: "SAWA-ABCD2345" })).name, "Somebody Else");
  assert.equal(asked.seen.length, 1);
});
