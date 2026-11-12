// Referral attribution and the embedded widget's plumbing: remembering the partner code, theming the frame, sizing it to its content
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import { useEffect } from "react";
import { cleanRefCode } from "../shared/ref-code.js";
import { API_BASE } from "./supabaseClient";
import { warnOnce } from "./warn-once.js";

// ---- Referral attribution (?ref=CODE) ----
const REF_KEY = "sawa_ref";
const REF_TTL = 30 * 24 * 60 * 60 * 1000; // remember the partner for 30 days
function refFromUrl() {
  try { return cleanRefCode(new URLSearchParams(window.location.search).get("ref")); } catch (e) { return ""; }
}
// On a real landing (not the embed itself): remember the partner + count one
// click-through. Stored client-side; sent with the booking later.
//
// The store is a functional cookie under site/cookies.html, so it waits for
// consent. The code is read from the URL and held in memory meanwhile: a
// visitor who lands on ?ref=… and then accepts on the banner is still
// attributed to the partner who sent them, which would not be true if the code
// were only read on the initial call.
function captureReferral() {
  const code = refFromUrl();
  if (!code) return;
  const store = () => {
    try {
      localStorage.setItem(REF_KEY, JSON.stringify({ code, ts: Date.now() }));
      const flag = `sawa_ref_hit_${code}`;
      if (!sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, "1");
        fetch(`${API_BASE}/track/referral`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }), keepalive: true,
        }).catch((e) => warnOnce("referral-beacon", "[referral] click-through not recorded —", e.message));
      }
    } catch (e) {
      // Private mode and blocked storage genuinely throw here and there is
      // nothing to do about it. AAA1.3 — but this is a PARTNER ATTRIBUTION
      // silently not happening, which is somebody's commission, so it says so
      // once rather than never.
      warnOnce("referral-store", "[referral] storage blocked — partner attribution will not persist:", e.message);
    }
  };

  const consent = window.sawaConsent;
  if (!consent) return; // no consent module loaded — treat as no consent
  consent.onChange((choice) => { if (choice.functional) store(); });
}
function getStoredRef() {
  try {
    const raw = localStorage.getItem(REF_KEY);
    if (!raw) return "";
    const { code, ts } = JSON.parse(raw);
    return code && Date.now() - ts <= REF_TTL ? code : "";
  } catch (e) { return ""; }
}
// ?preview=1 — the Promote page showing an agency its own widget. Everything
// renders and reacts as on a partner's site, but nothing is counted, no code
// is texted and nothing is booked.
function embedPreview() {
  return new URLSearchParams(window.location.search).get("preview") === "1";
}
// Carry the embed's own ?ref through to the click-through link.
function withEmbedRef(url) {
  // A preview's clicks are the agency trying its own widget, not a visitor.
  const code = embedPreview() ? "" : refFromUrl();
  return code ? `${url}?ref=${encodeURIComponent(code)}` : url;
}

// Reports the widget's height to the host page so the iframe can auto-size.
// ---- Embed theming: let the widget take on the host site's palette ----
function parseColor(c) {
  if (!c) return null;
  let s = String(c).trim();
  let m = s.match(/^#?([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1]; }
  m = s.match(/^#?([0-9a-f]{6})$/i);
  if (m) { const h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]; }
  m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(/[ ,/]+/).map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
  return null;
}
const rgbaStr = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
const readableOn = (c) => ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6 ? "#16242a" : "#ffffff");
function applyEmbedTheme(o) {
  if (!o) return;
  const s = document.documentElement.style, set = (k, v) => v && s.setProperty(k, v);
  if (o.theme === "dark") { set("--surface", "#16191c"); set("--ink", "#f2f4f5"); set("--ink-soft", "#a9b0b4"); set("--line", "rgba(255,255,255,0.14)"); }
  const bg = parseColor(o.bg); if (bg && bg[3] !== 0) set("--surface", rgbaStr(bg, 1));
  const text = parseColor(o.text); if (text) { set("--ink", rgbaStr(text, 1)); set("--ink-soft", rgbaStr(text, 0.62)); set("--line", rgbaStr(text, 0.14)); }
  const muted = parseColor(o.muted); if (muted) set("--ink-soft", rgbaStr(muted, 1));
  const border = parseColor(o.border); if (border) set("--line", rgbaStr(border, border[3]));
  const accent = parseColor(o.accent); if (accent && accent[3] !== 0) { set("--gold", rgbaStr(accent, 1)); set("--embed-cta-text", readableOn(accent)); }
  if (o.radius) set("--embed-radius", /[a-z%]/i.test(o.radius) ? o.radius : `${o.radius}px`);
  if (o.font) { set("--font-body", o.font); set("--font-display", o.font); }
}
function embedThemeFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    return { theme: q.get("theme"), bg: q.get("bg"), text: q.get("text"), muted: q.get("muted"),
      border: q.get("border"), accent: q.get("accent"), radius: q.get("radius"), font: q.get("font") };
  } catch (e) { return {}; }
}

let EMBED_HOST_PAGE = "";
const embedHostPage = () => (embedPreview() ? "" : EMBED_HOST_PAGE);

function useEmbedAutoResize(dep) {
  useEffect(() => {
    // The page's own background (set on <html>) showed as a grey box around
    // the widget on the partner's site; the frame should be see-through.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    applyEmbedTheme(embedThemeFromUrl());
    const post = () => {
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      // AAA1.3 — warn-once, not silence and not a warning per resize: this runs
      // on every ResizeObserver callback, and if it is failing the embed never
      // resizes, which the host site sees as a widget stuck at the wrong height.
      try { window.parent?.postMessage({ type: "sawa-embed-height", height }, "*"); }
      catch (e) { warnOnce("embed-height", "[embed] height not posted to host —", e.message); }
    };
    // Let the host's optional companion script send its palette to match.
    const onMsg = (e) => {
      if (!e.data || e.data.type !== "sawa-embed-theme") return;
      applyEmbedTheme(e.data);
      // The page the widget sits on, from the snippet's script. Sent with a
      // booking so its emails can link back there; the server keeps it only if
      // it is on the website the partner registered (shared/partner-page.js).
      if (typeof e.data.page === "string" && /^https:\/\//.test(e.data.page)) EMBED_HOST_PAGE = e.data.page.slice(0, 600);
    };
    window.addEventListener("message", onMsg);
    try { window.parent?.postMessage({ type: "sawa-embed-ready" }, "*"); }
    catch (e) { warnOnce("embed-ready", "[embed] ready signal not posted to host —", e.message); }
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    window.addEventListener("load", post);
    return () => { ro.disconnect(); window.removeEventListener("load", post); window.removeEventListener("message", onMsg); };
  }, [dep]);
}

export {
  REF_KEY, REF_TTL, refFromUrl, captureReferral, getStoredRef, embedPreview, withEmbedRef, parseColor,
  rgbaStr, readableOn, applyEmbedTheme, embedThemeFromUrl, EMBED_HOST_PAGE, embedHostPage,
  useEmbedAutoResize,
};
