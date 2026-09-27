// The traveler's side of pay at GoAhead (model phase 4, catalogue_v2): the
// booking page's payment and cancellation terms (an agency's traveler accepts
// the version the agency booked under), the waitlist for a full date, and the
// page behind a waitlist offer.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";
import { TravelerDetailsFields, emptyTravelerDetails, travelerDetailsBody, travelerDetailsError } from "./TravelerDetails.jsx";

const eur = (n) => `€${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const due = (iso) => new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo", timeZoneName: "short",
}).format(new Date(iso));

async function post(path, body) {
  const r = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

// On /booking/:code, for a pay-at-GoAhead booking.
export function BookingPayAtGoAhead({ code, view, onChanged }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const r = view.request;
  const t = view.terms;
  const needsAccept = t && t.fixedBy === "agency" && !t.travellerAcceptedAt;
  async function accept() {
    setBusy(true); setErr("");
    try { await post(`/public/bookings/${encodeURIComponent(code)}/accept-terms`, { versionId: t.versionId }); onChanged?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="booking-pay">
      {!r && <p>Nothing to pay yet. When this date reaches GoAhead we'll email you a link for the full price, with a deadline.</p>}
      {r?.state === "awaiting_link" && <p>Your date is going ahead. Your payment link for <b>{eur(r.amountEur)}</b> is on its way by email.</p>}
      {r?.state === "sent" && r.payer === "traveller" && (
        <>
          <p>Please pay <b>{eur(r.amountEur)}</b> by <b>{due(r.dueAt)}</b>. If it isn't paid by then, the seat is released.</p>
          <a className="btn gold booking-pay-btn" href={r.linkUrl} target="_blank" rel="noopener noreferrer">Pay {eur(r.amountEur)} securely</a>
          <small>Card payment through Tab, our payment provider. Your booking code is the payment's reference.</small>
        </>
      )}
      {r?.state === "sent" && r.payer === "agency" && <p>Your agency pays for this booking. It is due by {due(r.dueAt)}.</p>}
      {r?.state === "paid" && <p><b>Paid.</b> Thank you — see you on the day.</p>}
      {r?.state === "released" && <p>This seat was released because payment wasn't received by the deadline.</p>}
      {/* Seller disclosure: the operator assigned at GoAhead sells; Sawa's
          operating company collects the payment as its agent. */}
      <p className="booking-seller"><small>{view.sellerLine}. Payee: {view.payee}.</small></p>
      {view.voucher && <BookingVoucher voucher={view.voucher} />}
      {t && (
        <div className="booking-terms">
          <p><b>Cancellation after GoAhead</b> (terms v{t.version}{t.fixedBy === "agency" ? ", as your agency booked" : ""})</p>
          <ul>{t.tiers.map((x, i) => <li key={i}>{x.window}: {x.retainedPct ? `${x.retainedPct}% of the price kept` : "no charge"}</li>)}</ul>
          {needsAccept && (
            <>
              <p>Your agency booked you under these terms. Please confirm you accept them.</p>
              <button type="button" className="btn-pill primary" disabled={busy} onClick={accept}>{busy ? "Saving…" : "I accept these terms"}</button>
            </>
          )}
          {t.fixedBy === "agency" && t.travellerAcceptedAt && <small>Accepted.</small>}
          {err && <div className="form-error" role="alert">{err}</div>}
        </div>
      )}
    </div>
  );
}

// The voucher for a paid booking: what the traveler shows on the day. Printable.
function BookingVoucher({ voucher: v }) {
  return (
    <div className="booking-voucher" style={{ border: "1px solid currentColor", borderRadius: 8, padding: 12, margin: "12px 0" }}>
      <p><b>Voucher</b> · booking {v.bookingCode}{v.receiptNo ? ` · receipt ${v.receiptNo}` : ""}</p>
      <p>{v.title}, {v.date} · {v.seats} traveler{v.seats === 1 ? "" : "s"}</p>
      {v.travellers?.length > 0 && <p>{v.travellers.join(", ")}</p>}
      {v.pickupPoint && <p>Pickup: {v.pickupPoint}</p>}
      <p><small>{v.seller}. Payee: {v.payee}.</small></p>
      <button type="button" className="btn-pill" onClick={() => window.print()}>Print the voucher</button>
    </div>
  );
}

// Under a tour's dates, when a date is full.
export function WaitlistJoin({ dates }) {
  const full = dates.filter((d) => d.full);
  const [f, setF] = useState({ depId: "", name: "", email: "", seats: 1 });
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");
  if (!full.length) return null;
  if (done) return <div className="bk-ok" style={{ marginTop: 8 }}>You're on the waitlist (number {done.position}). If seats open up we'll email you an offer, held for you for a few hours.</div>;
  async function join(e) {
    e.preventDefault();
    setErr("");
    try {
      const j = await post(`/public/departures/${f.depId || full[0].id}/waitlist`, { name: f.name, email: f.email, seats: Number(f.seats) });
      setDone(j.waitlist);
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <details className="note" style={{ marginTop: 8 }}>
      <summary>A date you want is full? Join its waitlist</summary>
      <form onSubmit={join} style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <select aria-label="Full date" value={f.depId} onChange={(e) => setF({ ...f, depId: e.target.value })}>
          {full.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <input aria-label="Your name" required placeholder="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input aria-label="Email" required type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input aria-label="Seats" type="number" min={1} max={12} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} />
        <button className="btn-pill">Join the waitlist</button>
        {err && <div className="form-error" role="alert">{err}</div>}
      </form>
    </details>
  );
}

// /waitlist/:token — book the seats held for you.
export function WaitlistOfferPage({ token }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const [phone, setPhone] = useState("");
  const [details, setDetails] = useState(emptyTravelerDetails);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    fetch(`${API_BASE}/public/waitlist/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "This offer isn't valid.");
        setInfo(j);
        setPhone(j.offer.phone || "");
        setDetails({ ...emptyTravelerDetails(), names: Array.from({ length: j.offer.seats }, (_, i) => (i === 0 ? j.offer.name : "")) });
      })
      .catch((e) => setErr(e.message));
  }, [token]);
  async function book(e) {
    e.preventDefault();
    const missing = travelerDetailsError(details, info.offer.seats, { phone });
    if (missing) return setErr(missing);
    setBusy(true); setErr("");
    try { setDone((await post(`/public/waitlist/${encodeURIComponent(token)}/book`, { ...travelerDetailsBody(details), customerPhone: phone.trim() })).booking); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <main style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <h1>A seat opened up</h1>
      {!info && !err && <p>Loading…</p>}
      {err && <div className="auth-error" role="alert">{err}</div>}
      {done ? (
        <p>Booked: your code is <b>{done.code}</b>. This date is going ahead, so we'll email your payment link for the full price shortly, with a deadline. <a href={`/booking/${encodeURIComponent(done.code)}`}>See your booking</a>.</p>
      ) : info && (
        <form onSubmit={book}>
          <p><strong>{info.departure.title}</strong>, {info.departure.dateLabel} · {info.offer.seats} seat{info.offer.seats === 1 ? "" : "s"} held for you until {due(info.offer.expiresAt)}.</p>
          <label className="bk-field"><span>Phone number</span>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required autoComplete="tel" placeholder="+20 1XX XXX XXXX" />
          </label>
          <TravelerDetailsFields value={details} onChange={setDetails} seats={info.offer.seats} />
          <button className="btn-primary" disabled={busy} style={{ marginTop: 16 }}>{busy ? "Booking…" : "Book the seats"}</button>
        </form>
      )}
    </main>
  );
}
