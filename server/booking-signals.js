// The reservation signals (migration 057, catalogue_v2), reduced before they
// are stored: a salted hash of the device fingerprint, the IP address cut to
// its /24 (IPv6: /48) and the phone number's country calling code. Pure, so
// they are tested without a database (booking-signals.test.js).
import { createHash } from "node:crypto";

// A salted hash of what the browser reports about itself: the user agent,
// language and the client's own fingerprint string. Never stored raw.
export function deviceHash({ userAgent = "", language = "", hint = "" } = {}, salt = process.env.BOOKING_SIGNAL_SALT || "sawa-booking-signals") {
  const parts = [userAgent, language, hint].map((v) => String(v || "").slice(0, 400));
  if (!parts.some(Boolean)) return null;
  return createHash("sha256").update(`${salt}|${parts.join("|")}`).digest("hex").slice(0, 32);
}

// 41.33.12.7 → 41.33.12.0/24; 2001:db8:1:2::5 → 2001:db8:1::/48.
export function ipPrefix(ip) {
  let s = String(ip || "").trim();
  if (!s) return null;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) s = mapped[1];
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!s.includes(":")) return null;
  const [head] = s.split("::");
  const groups = head.split(":").filter(Boolean);
  const full = s.includes("::") ? groups : s.split(":");
  const first = [...full, "0", "0", "0"].slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
  return `${first.join(":")}::/48`;
}

// The country calling code of an international number (+20 1XX… → "+20").
// Null when the number isn't written with its country code.
const CC2 = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98"]);
export function phoneCountryCode(phone) {
  const s = String(phone || "").trim().replace(/[\s().-]/g, "");
  const m = s.match(/^(?:\+|00)(\d{6,15})$/);
  if (!m) return null;
  const d = m[1];
  if (d[0] === "1" || d[0] === "7") return `+${d[0]}`;
  if (CC2.has(d.slice(0, 2))) return `+${d.slice(0, 2)}`;
  return `+${d.slice(0, 3)}`;
}

