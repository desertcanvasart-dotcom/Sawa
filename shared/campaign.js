// Campaign attribution: which link brought the traveller who booked.
//
// Marketing links carry three parameters, in one convention:
//
//   utm_source    the channel         instagram, facebook, blog, email, whatsapp
//   utm_medium    the kind of link    social, organic, email, referral, paid
//   utm_campaign  the tour and date   fayoum-2026-12-04
//
// The north star is departures reaching GoAhead, so the question each week is
// which link filled which date. Google Analytics cannot answer it alone: it
// only sees visitors who accepted analytics, and never sees the partner widget.
// So the three values are kept with the booking itself (pledges.utm_*, 071).
//
// One module for the browser and the server, so the two cannot disagree about
// what a clean value is. A value is a short lower-case label and nothing else:
// whatever arrives in a URL is reduced to [a-z0-9_.-], which is also why a
// stray email address or name pasted into a link cannot be stored.
const KEYS = [["utmSource", "utm_source"], ["utmMedium", "utm_medium"], ["utmCampaign", "utm_campaign"]];
const MAX = 100;

export function cleanCampaignValue(v) {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.-]/g, "").slice(0, MAX);
}

// { utmSource, utmMedium, utmCampaign } with only the values that survive
// cleaning, or null when none does.
export function cleanCampaign(input) {
  const out = {};
  for (const [key] of KEYS) {
    const v = cleanCampaignValue(input ? input[key] : "");
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// The same, read from a page address (a landing URL, or the page a partner's
// widget sits on). null for anything that is not a URL with these parameters.
export function campaignFromUrl(url) {
  if (typeof url !== "string" || !url) return null;
  let q;
  try { q = new URL(url, "https://sawa.tours").searchParams; } catch { return null; }
  const raw = {};
  for (const [key, param] of KEYS) raw[key] = q.get(param) || "";
  return cleanCampaign(raw);
}

export const CAMPAIGN_KEYS = KEYS.map(([key]) => key);
