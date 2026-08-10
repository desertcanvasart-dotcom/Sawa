// The referral code, sanitised the same way on both sides.
//
// Existed twice, byte-identical, under two names: `cleanRefCode` in
// `server/app.js` and `cleanRef` in `src/main.jsx`.
//
// The client reads `?ref=` from the URL and the server stores what it is sent.
// If the two ever normalise differently, a referral is captured under one string
// and recorded under another — and attribution breaks SILENTLY. There is no
// error, no failed request; the number is simply wrong, and the only way to
// notice is to go looking.
//
// Two names for one function also meant `grep cleanRef` found one of them.
export function cleanRefCode(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
