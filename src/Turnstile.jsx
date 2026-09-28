// Cloudflare Turnstile on the public booking forms. The token goes with the
// booking and the server checks it. No site key (not configured yet): nothing
// is shown and the booking goes without a token, which the server accepts
// while its secret key is also unset.
import React, { useEffect, useRef } from "react";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { loading = null; reject(new Error("Turnstile didn't load")); };
    document.head.appendChild(s);
  });
  return loading;
}

// `resetKey`: change it after a submission (a token is good for one use) to
// get a fresh one.
export function TurnstileBox({ siteKey, onToken, resetKey = 0 }) {
  const box = useRef(null);
  useEffect(() => {
    if (!siteKey || !box.current) return undefined;
    let id = null;
    let gone = false;
    onToken("");
    loadTurnstile().then((t) => {
      if (gone || !t || !box.current) return;
      id = t.render(box.current, {
        sitekey: siteKey,
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    }).catch((e) => console.warn(e.message));
    return () => {
      gone = true;
      if (id != null && window.turnstile) window.turnstile.remove(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, resetKey]);
  if (!siteKey) return null;
  return <div ref={box} className="turnstile-box" style={{ margin: "10px 0" }} />;
}
