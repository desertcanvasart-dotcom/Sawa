// /confirm-email/:token (catalogue_v2): the link in the booking's
// confirmation email. The page makes the POST, so a mail client that
// prefetches the link doesn't confirm on the traveler's behalf.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";

export function EmailConfirmPage({ token }) {
  const [state, setState] = useState({ status: "working", code: "", error: "" });
  useEffect(() => {
    fetch(`${API_BASE}/public/email-confirmations/${encodeURIComponent(token)}`, { method: "POST" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "This link isn't valid.");
        setState({ status: j.state, code: j.code || "", error: "" });
      })
      .catch((e) => setState({ status: "error", code: "", error: e.message }));
  }, [token]);
  const booking = state.code ? <a href={`/booking/${encodeURIComponent(state.code)}`}>See your booking</a> : null;
  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <h1>Confirm your email</h1>
      {state.status === "working" && <p>Confirming…</p>}
      {(state.status === "confirmed" || state.status === "already") && (
        <p>Thank you, your email is confirmed. Your seats now count towards this date's GoAhead minimum. {booking}</p>
      )}
      {state.status === "cancelled" && <p>This booking was canceled, so there is nothing to confirm. {booking}</p>}
      {state.status === "error" && <div className="auth-error" role="alert">{state.error}</div>}
    </main>
  );
}

// What the browser reports about itself, for the reservation-integrity check.
// The server hashes it with the user agent; it is never stored as sent.
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
