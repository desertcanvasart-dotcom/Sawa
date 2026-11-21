// GA4 events: the one place the app talks to Google Analytics.
//
// Until 21 Nov 2026 the property recorded visits and nothing else: page_view
// and Google's automatic events. Nothing said which tour was opened, whether a
// date was picked, or whether a reservation was sent. This module is the
// vocabulary for that, so the event names and parameters live in one file
// instead of being spelled slightly differently at each call site.
//
// Consent. site/assets/analytics.js loads gtag.js only once the visitor has
// accepted analytics, and this module follows the same rule rather than
// leaning on it:
//
//   accepted   the event is sent now
//   undecided  the event is held in memory, and sent if the visitor accepts
//   refused    the event is dropped, and so is anything held
//   no banner  (the partner widget, which loads neither file) dropped
//
// "Held" matters because the banner is usually answered late: a visitor lands,
// opens a tour, and only then accepts. Without it the tour view that led to the
// reservation is the one event missing from the funnel. Nothing is written to
// storage and nothing leaves the page before the visitor says yes.
//
// No personal data. Callers pass tour, date and seat facts only; names, emails
// and phone numbers have no parameter here on purpose.
import { tourSlug } from "../shared/slug.js";
import { isPackage } from "../shared/booking-policy.js";
import { warnOnce } from "./warn-once.js";

// GA4 truncates parameter values at 100 characters; do it here so what is sent
// is what is stored.
const VALUE_LIMIT = 100;
// A visitor who never answers the banner must not grow an unbounded list.
const HELD_LIMIT = 50;

const held = [];
let listening = false;

function cleanValue(v) {
  if (typeof v === "string") return v.slice(0, VALUE_LIMIT);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((item) => cleanParams(item));
  return undefined;
}

// Drops what GA cannot store (undefined, null, "", NaN, nested objects) rather
// than sending "(not set)" look-alikes that pollute the reports.
export function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    const c = cleanValue(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function flush(win, choice) {
  const queued = held.splice(0);
  if (!choice || !choice.analytics) return; // refused: what was held is gone
  for (const [name, params] of queued) win.gtag("event", name, params);
}

// Returns what happened to the event: "sent", "held" or "dropped". The return
// value is for the tests; callers do not branch on it.
export function track(name, params = {}, win = globalThis.window) {
  try {
    const consent = win && win.sawaConsent;
    if (!consent || typeof win.gtag !== "function") return "dropped";
    const clean = cleanParams(params);
    if (consent.has("analytics")) { win.gtag("event", name, clean); return "sent"; }
    // A recorded "no" is a no. Only an unanswered banner holds.
    if (consent.get()) return "dropped";
    if (held.length < HELD_LIMIT) held.push([name, clean]);
    if (!listening) {
      listening = true;
      consent.onChange((choice) => flush(win, choice));
    }
    return "held";
  } catch (e) {
    // Analytics must never break a reservation. Said once, so a broken tag is
    // still visible in the console.
    warnOnce("analytics", "[analytics] event not recorded:", e.message);
    return "dropped";
  }
}

// A client-side navigation. GA counts the first page_view itself when the tag
// loads; every route change after that is reported here, with the title the
// new page actually has. "Page changes based on browser history events" is
// switched OFF in the GA4 stream, so this is the only source: with both on,
// each navigation was counted twice.
export function trackPageView(path, win = globalThis.window) {
  return track("page_view", {
    page_path: path,
    page_location: win && win.location ? win.location.href : undefined,
    page_title: win && win.document ? win.document.title : undefined,
  }, win);
}

// The facts about a tour every tour event carries. tour_slug is the reporting
// key (registered as a custom dimension); items[] is GA4's own shape, which is
// what makes view_item appear in the built-in item reports.
export function tourParams(tour) {
  if (!tour) return {};
  const slug = tourSlug(tour);
  const category = isPackage(tour) ? "package" : "day_tour";
  return {
    tour_slug: slug,
    city: tour.city,
    items: [{ item_id: slug, item_name: tour.title, item_category: category }],
  };
}

// "direct", or "referral" with the partner's code when the visitor arrived on
// a partner link. The code is a short public string, not personal data.
export function sourceParams(refCode) {
  return refCode ? { booking_source: "referral", agency_ref: refCode } : { booking_source: "direct" };
}

// Test seam. Not called by the application.
export function __resetAnalytics() {
  held.length = 0;
  listening = false;
}
