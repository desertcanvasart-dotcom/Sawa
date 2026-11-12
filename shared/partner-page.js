// The partner's own page, for the links Sawa emails about a widget booking.
//
// A traveler who booked in an agency's widget should come back to the agency's
// page when they click "Confirm my booking" or "Check your booking", not land
// on sawa.tours. The widget's snippet tells the frame which page it is on, and
// that address travels with the booking.
//
// It is an address a browser sent, so it is not trusted. Unchecked, anyone
// could book with someone else's email and a page address of their choosing,
// and Sawa would email that person a real Sawa letter whose button opens the
// attacker's site. So a page is accepted ONLY on the website the agency itself
// registered (Settings → Agency details), over https. Anything else is dropped
// and the links go to sawa.tours as before.
//
// Shared: the portal validates the website field with the same rule the server
// stores it by.

const bareHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");

// What an agency types ("nilegate.com", "https://www.nilegate.com/tours") ->
// the site's origin, or null if it is not a public https website.
export function normalizeWebsite(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 200 || /\s/.test(s)) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  // A real, public name: at least one dot, no IP addresses, no localhost.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  return `https://${host}`;
}

// The page a booking was made on, if it is on the agency's registered site.
// Returns the address to link back to (no fragment, none of the widget's own
// parameters), or null.
export function partnerPageUrl(rawPage, website) {
  const site = normalizeWebsite(website);
  const s = String(rawPage || "").trim();
  if (!site || !s || s.length > 600) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (bareHost(u.hostname) !== bareHost(new URL(site).hostname)) return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("sawa-")) u.searchParams.delete(k);
  return u.toString();
}

// The page with one widget instruction on it: ?sawa-booking=CODE opens that
// booking in the widget, ?sawa-confirm=TOKEN confirms a held one, and
// ?sawa-join=TOKEN opens a "Join my group" link's date.
export const WIDGET_PARAMS = ["sawa-booking", "sawa-confirm", "sawa-join"];
export function withWidgetParam(pageUrl, key, value) {
  if (!WIDGET_PARAMS.includes(key)) throw new Error(`unknown widget parameter: ${key}`);
  const u = new URL(pageUrl);
  for (const k of WIDGET_PARAMS) u.searchParams.delete(k);
  u.searchParams.set(key, String(value));
  return u.toString();
}
