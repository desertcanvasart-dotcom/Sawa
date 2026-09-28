// What the browser reports about itself, for the reservation-integrity check
// (catalogue_v2). The server hashes it with the user agent; it is never stored
// as sent.
export function deviceHint() {
  try {
    const s = window.screen || {};
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return [s.width, s.height, s.colorDepth, window.devicePixelRatio, tz, navigator.platform, navigator.hardwareConcurrency, (navigator.languages || []).join(",")]
      .map((v) => String(v ?? "")).join("|").slice(0, 400);
  } catch (e) {
    return "";
  }
}
