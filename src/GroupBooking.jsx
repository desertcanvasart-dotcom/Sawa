// Group bookings (catalogue_v2): the "Join my group" link a traveler shares
// after booking, and the page behind it. Everyone who books through the link
// books the same date and travels as one group; each still books and pays for
// their own seats.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";

const seatsLine = (n) => (n > 0 ? `${n} seat${n === 1 ? "" : "s"} left on this date` : "No seats left on this date");

// On the booking page and after booking. `group` is what the booking page
// already knows ({ url, seatsLeft } or { url: null }); without it the link is
// fetched on request.
export function JoinGroupLink({ code, group = null }) {
  const [link, setLink] = useState(group?.url ? group : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  async function make() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(code)}/party`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "We couldn't make a group link. Please try again.");
      setLink(j.group);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch (e) { setErr(`Copy the link: ${link.url}`); }
  }
  return (
    <div className="booking-group">
      <p><b>Traveling with others?</b> Share your group link. Everyone who books through it joins this date and travels with you; each person books and pays for their own seats.</p>
      {link ? (
        <>
          <div className="booking-group-link">
            <input readOnly value={link.url} aria-label="Your group link" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-pill" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
          </div>
          <small>{seatsLine(Number(link.seatsLeft) || 0)}.{link.seats ? ` Your group holds ${link.seats} so far.` : ""}</small>
        </>
      ) : (
        <button type="button" className="btn-pill" disabled={busy} onClick={make}>{busy ? "Making your link…" : "Get my group link"}</button>
      )}
      {err && <div className="form-error" role="alert">{err}</div>}
    </div>
  );
}

// /join/:token: whose group, which date, how many seats are left, and the way
// into the ordinary booking form for that date with the link attached.
export function JoinGroupPage({ token }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`${API_BASE}/public/parties/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "This group link isn't valid.");
        setInfo(j);
      })
      .catch((e) => setErr(e.message));
  }, [token]);
  const d = info?.departure;
  const when = d?.date ? new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${String(d.date).slice(0, 10)}T12:00:00Z`)) : "";
  const to = d?.path ? `${d.path}?date=${encodeURIComponent(d.id)}&party=${encodeURIComponent(token)}` : null;
  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <h1>{info?.group?.leadFirstName ? `Join ${info.group.leadFirstName}'s group` : "Join the group"}</h1>
      {!info && !err && <p>Loading…</p>}
      {err && <div className="auth-error" role="alert">{err}</div>}
      {info && d && (
        <>
          <p><strong>{d.title}</strong>{d.city ? `, ${d.city}` : ""} · {when}</p>
          <p>{seatsLine(info.seatsLeft)}.{info.group.seats ? ` The group holds ${info.group.seats} so far.` : ""}</p>
          {info.bookable && to ? (
            <>
              <p>Book your own seats on this date and you'll travel together. Nothing is charged until the date reaches GoAhead; then each person pays for their own seats.</p>
              <a className="btn gold" href={to}>Book your seats</a>
            </>
          ) : (
            <p>This date isn't taking more bookings. Ask whoever sent you the link about another date.</p>
          )}
        </>
      )}
    </main>
  );
}

// The link a booking on the tour page came through, if any.
export function partyTokenFromUrl() {
  try { return String(new URLSearchParams(window.location.search).get("party") || "").slice(0, 80); } catch (e) { return ""; }
}
