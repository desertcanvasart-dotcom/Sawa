// Parties larger than the online maximum are not bookable: the booking form
// stops and shows this short request, which becomes an admin lead. No booking
// is made and no seat is held.
import { useState } from "react";
import { API_BASE } from "./supabaseClient";
import { MAX_GROUP_SIZE } from "../shared/group-size.js";

export const GROUP_REQUEST_TITLE = `Groups of more than ${MAX_GROUP_SIZE}: request a special arrangement`;
export const tooManyTravelers = (n) => Number(n) > MAX_GROUP_SIZE;

export function GroupRequestForm({ size, product, date, className = "" }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [groupSize, setGroupSize] = useState(String(size || MAX_GROUP_SIZE + 1));
  const [wanted, setWanted] = useState(date || "");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr("");
    if (name.trim().length < 2) return setErr("Enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email.");
    if (!tooManyTravelers(groupSize)) return setErr(`This form is for groups of more than ${MAX_GROUP_SIZE}. Smaller groups can book online.`);
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/public/group-requests`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), email: email.trim(), groupSize: Number(groupSize),
          date: wanted || undefined, productId: product?.id, productTitle: product?.title,
          note: note.trim() || undefined, website,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `The request did not go through (${r.status}).`);
      setSent(true);
    } catch (e2) {
      setErr(e2.message || "The request did not go through. Try again.");
    } finally { setBusy(false); }
  }

  if (sent) {
    return <div className={`group-request ${className}`} role="status"><strong>Thank you.</strong> We have your request and will reply by email to arrange it. No booking has been made.</div>;
  }
  return (
    <form className={`group-request ${className}`} onSubmit={submit} data-testid="group-request">
      <strong>{GROUP_REQUEST_TITLE}</strong>
      <p>Online bookings are for up to {MAX_GROUP_SIZE} travelers. Tell us about your group and we will arrange it with you. No booking is made and no seats are held.</p>
      <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
      <label>Group size<input type="number" min={MAX_GROUP_SIZE + 1} value={groupSize} onChange={(e) => setGroupSize(e.target.value)} /></label>
      <label>Date<input type="date" value={wanted} onChange={(e) => setWanted(e.target.value)} /></label>
      <label>Tour<input value={product?.title || ""} readOnly aria-readonly="true" /></label>
      <label>Anything else (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      {/* Honeypot: hidden from people, filled by bots. */}
      <input value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }} />
      {err && <div className="auth-error" role="alert">{err}</div>}
      <button className="btn-primary" disabled={busy}>{busy ? "Sending…" : "Send request"}</button>
    </form>
  );
}
