// GA4 events follow the cookie banner, and never carry more than tour facts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { track, trackPageView, cleanParams, tourParams, sourceParams, __resetAnalytics } from "./analytics.js";
import { __resetWarnOnce } from "./warn-once.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// A browser window with the consent module in a given state: null is an
// unanswered banner, { analytics: true|false } an answered one.
function fakeWindow(state) {
  const sent = [];
  const listeners = [];
  const win = {
    sent,
    gtag: (...args) => sent.push(args),
    location: { href: "https://sawa.tours/tour/fayoum?date=7" },
    document: { title: "Fayoum | Sawa Tours" },
    sawaConsent: {
      get: () => state,
      has: (c) => !!(state && state[c]),
      onChange: (fn) => { listeners.push(fn); if (state) fn(state); },
    },
    answer(choice) { state = choice; for (const fn of listeners) fn(choice); },
  };
  return win;
}

beforeEach(() => { __resetAnalytics(); __resetWarnOnce(); });

test("with analytics accepted, the event is sent straight away", () => {
  const win = fakeWindow({ analytics: true });
  assert.equal(track("view_item", { tour_slug: "fayoum" }, win), "sent");
  assert.deepEqual(win.sent, [["event", "view_item", { tour_slug: "fayoum" }]]);
});

test("with the banner unanswered, the event waits and is sent in order on acceptance", () => {
  const win = fakeWindow(null);
  assert.equal(track("view_item", { tour_slug: "fayoum" }, win), "held");
  assert.equal(track("select_date", { tour_slug: "fayoum" }, win), "held");
  assert.deepEqual(win.sent, [], "nothing leaves the page before the visitor answers");
  win.answer({ analytics: true });
  assert.deepEqual(win.sent.map((e) => e[1]), ["view_item", "select_date"]);
  win.answer({ analytics: true });
  assert.equal(win.sent.length, 2, "a held event is sent once, not on every later change");
});

test("a refusal drops what was held, and later events too", () => {
  const win = fakeWindow(null);
  track("view_item", { tour_slug: "fayoum" }, win);
  win.answer({ analytics: false });
  assert.equal(track("generate_lead", { tour_slug: "fayoum" }, win), "dropped");
  win.answer({ analytics: true });
  assert.deepEqual(win.sent, [], "events from before a refusal do not come back");
  assert.equal(track("generate_lead", { tour_slug: "fayoum" }, win), "sent");
});

test("without the consent module (the partner widget) nothing is sent", () => {
  const win = fakeWindow({ analytics: true });
  delete win.sawaConsent;
  assert.equal(track("view_item", {}, win), "dropped");
  assert.deepEqual(win.sent, []);
});

test("a failing tag never throws into the booking flow", () => {
  const win = fakeWindow({ analytics: true });
  win.gtag = () => { throw new Error("blocked"); };
  const real = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(" "));
  try { assert.equal(track("generate_lead", {}, win), "dropped"); } finally { console.warn = real; }
  assert.equal(said.length, 1, "and it says so once");
});

test("an unanswered banner cannot grow the held list without limit", () => {
  const win = fakeWindow(null);
  for (let i = 0; i < 80; i++) track("select_date", { n: i }, win);
  win.answer({ analytics: true });
  assert.equal(win.sent.length, 50);
});

test("parameters GA cannot store are dropped, and long strings are cut", () => {
  assert.deepEqual(
    cleanParams({ a: "x", b: undefined, c: null, d: "", e: NaN, f: 0, g: false, h: { nested: 1 }, i: "y".repeat(150) }),
    { a: "x", f: 0, g: false, i: "y".repeat(100) },
  );
});

test("a page view carries the path, address and title of the page it is on", () => {
  const win = fakeWindow({ analytics: true });
  trackPageView("/tour/fayoum", win);
  assert.deepEqual(win.sent[0], ["event", "page_view", {
    page_path: "/tour/fayoum",
    page_location: "https://sawa.tours/tour/fayoum?date=7",
    page_title: "Fayoum | Sawa Tours",
  }]);
});

test("a tour is described by its slug, city and GA item, and by nothing personal", () => {
  const day = tourParams({ id: 7, title: "Fayoum Oasis", city: "Cairo", type: "day_tour" });
  assert.equal(day.city, "Cairo");
  assert.equal(day.items.length, 1);
  assert.equal(day.items[0].item_id, day.tour_slug);
  assert.equal(day.items[0].item_name, "Fayoum Oasis");
  assert.ok(day.tour_slug.length > 0);
  assert.deepEqual(tourParams(null), {});
});

test("a booking is direct unless a partner code sent the visitor", () => {
  assert.deepEqual(sourceParams(""), { booking_source: "direct" });
  assert.deepEqual(sourceParams("NILE01"), { booking_source: "referral", agency_ref: "NILE01" });
});

// The call sites. These read the source, because the alternative is a browser.
test("navigate() no longer sends its own page_view; the route effect does, once the title is known", () => {
  const main = read("src/main.jsx");
  const nav = main.slice(main.indexOf("function navigate(to)"), main.indexOf("const dayTourProducts"));
  assert.ok(!/gtag\(/.test(nav), "navigate() must not call gtag directly");
  assert.ok(/trackPageView\(path\)/.test(main), "the route effect reports the page view");
  assert.equal((main.match(/window\.gtag\(/g) || []).length, 0, "all GA calls go through src/analytics.js");
});

test("no event call site passes a name, an email or a phone number", () => {
  let calls = 0;
  for (const file of ["src/main.jsx", "src/TourDetail.jsx", "src/BookingConfirmation.jsx", "src/PublicPages.jsx"]) {
    const src = read(file);
    for (const call of src.match(/track\("[a-z_]+",[\s\S]*?\);/g) || []) {
      calls += 1;
      assert.ok(!/customer|email|phone|\bname\b/i.test(call.replace(/item_name/g, "")), `${file}: ${call.slice(0, 80)}`);
    }
  }
  // view_item, select_date, begin_checkout, generate_lead, request_date,
  // confirm_reservation, contact_submit. A scan that found none checked nothing.
  assert.equal(calls, 7);
});

test("a signed-in browser is marked internal before the tag is configured", () => {
  const src = read("site/assets/analytics.js");
  assert.ok(/traffic_type:\s*"internal"/.test(src));
  assert.ok(src.indexOf("signedIn()") < src.indexOf("googletagmanager.com/gtag/js"), "decided before gtag.js loads");
});
