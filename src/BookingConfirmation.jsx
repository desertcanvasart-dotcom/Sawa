// A direct booking is made when the traveler confirms their email (live).
// /confirm-booking/:token makes the POST (a mail client that prefetches the
// link doesn't confirm anyone), and the booking page can send the link again.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";

// `embed`: the same confirmation inside the partner widget, when the email's
// link returned to the partner's page. `onSeeBooking` opens the booking in the
// frame instead of linking to sawa.tours.
export function ConfirmBookingPage({ token, embed = false, onSeeBooking = null }) {
  const [state, setState] = useState({ status: "working", code: "", error: "" });
  useEffect(() => {
    fetch(`${API_BASE}/public/booking-confirmations/${encodeURIComponent(token)}`, { method: "POST" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok && j.state !== "refused") throw new Error(j.error || "This link isn't valid.");
        setState({ status: j.state, code: j.code || "", error: j.error || "" });
      })
      .catch((e) => setState({ status: "error", code: "", error: e.message }));
  }, [token]);
  const booking = !state.code ? null : embed && onSeeBooking
    ? <button type="button" className="eb-link eb-linkbtn" onClick={() => onSeeBooking(state.code)}>See your booking</button>
    : <a href={`/booking/${encodeURIComponent(state.code)}`}>See your booking</a>;
  const text = {
    working: "Confirming your booking…",
    confirmed: "Thank you, your booking is confirmed. We've emailed the details.",
    already: "This booking is already confirmed.",
    expired: "This booking wasn't confirmed within 24 hours, so it lapsed. Nothing was charged. You can book again while places remain.",
    cancelled: "This booking was canceled before it was confirmed. Nothing was charged.",
  }[state.status];
  const body = (
    <>
      {text && <p>{text} {state.status !== "working" && booking}</p>}
      {(state.status === "refused" || state.status === "error") && <div className="auth-error" role="alert">{state.error}</div>}
    </>
  );
  if (embed) {
    return <div className="eb-panel eb-booking eb-confirm" role="status"><div className="eb-head"><strong className="eb-title">Confirm my booking</strong></div><div className="eb-confirm-body">{body}</div></div>;
  }
  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <h1>Confirm my booking</h1>
      {body}
    </main>
  );
}

// On the booking page while the booking waits for confirmation.
export function ResendConfirmation({ code, resendsLeft }) {
  const [left, setLeft] = useState(resendsLeft);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function resend() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(code)}/resend-confirmation`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "We couldn't send it. Please try again.");
      setLeft(j.resendsLeft);
      setMsg("Sent. Use the link in the newest email; the earlier link no longer works.");
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="booking-pay" role="status">
      <p><b>Check your email to confirm your booking.</b> Didn't get it? Check your spam folder, or send it again.</p>
      {left > 0
        ? <button type="button" className="btn-pill" disabled={busy} onClick={resend}>{busy ? "Sending…" : `Send the email again (${left} left)`}</button>
        : <small>The email has been sent again as many times as it can be. Email hello@sawa.tours and we'll confirm it for you.</small>}
      {msg && <small>{msg}</small>}
    </div>
  );
}
