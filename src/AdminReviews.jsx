// Admin: customer reviews (069). A review link is made from a booking whose
// tour has run (ReviewLinkBox, in the booking drawer); the reviews travelers
// send wait here until an admin publishes them on the tour page.
import { useEffect, useState } from "react";
import { apiFetch } from "./supabaseClient";
import { fmtDate, fmtReceived } from "./dates.js";

async function call(path, method = "GET", body) {
  const r = await apiFetch(path, body === undefined ? { method } : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

const STATUS = {
  invited: { label: "Link sent, no review yet", tag: "tag-off" },
  submitted: { label: "Waiting for approval", tag: "tag-warn" },
  published: { label: "Published", tag: "tag-ready" },
  hidden: { label: "Hidden", tag: "tag-off" },
};
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

export function ReviewsSection({ flash }) {
  const [rows, setRows] = useState(null);
  const [invited, setInvited] = useState(0);
  const [filter, setFilter] = useState("submitted");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(null);

  async function load() {
    try {
      setErr("");
      const j = await call("/admin/reviews");
      setRows(j.reviews);
      setInvited(j.invited || 0);
    } catch (e) { setErr(e.message); setRows([]); }
  }
  useEffect(() => { load(); }, []);

  async function decide(id, status) {
    setBusy(id);
    try {
      await call(`/admin/reviews/${id}`, "PATCH", { status });
      flash?.(status === "published" ? "Published on the tour page." : "Hidden from the tour page.");
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  }

  const all = rows || [];
  const count = (s) => all.filter((r) => r.status === s).length;
  const shown = filter === "all" ? all : all.filter((r) => r.status === filter);

  return (
    <>
      <div className="dash-head"><div><h1>Reviews</h1>
        <p>Reviews from travelers whose tour has run. To ask for one, open the booking under <strong>Departures &amp; bookings → Travelers</strong> and make a review link. Nothing is shown on the site until you publish it.</p></div></div>
      {err && <div className="auth-error">{err}</div>}
      <p className="field-hint">Hide a review only if it breaks the rules: offensive, someone's personal details, or not about the tour. Don't hide an honest review because it's negative. Under UK and EU consumer law, reviews must not be shown selectively.</p>
      <div className="seg sm" style={{ margin: "12px 0" }}>
        {[["submitted", `Waiting (${count("submitted")})`], ["published", `Published (${count("published")})`], ["hidden", `Hidden (${count("hidden")})`], ["all", "All"]].map(([id, label]) => (
          <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {invited > 0 && <p className="field-hint">{invited} review link{invited === 1 ? "" : "s"} sent with no review back yet.</p>}
      {rows == null ? <p className="field-hint">Loading…</p> : shown.length === 0 ? <div className="dash-card"><p className="field-hint">No reviews here.</p></div> : (
        <div className="review-admin-list">
          {shown.map((r) => (
            <div className="dash-card review-admin" key={r.id}>
              <div className="review-admin-head">
                <div>
                  <span className="review-admin-stars" aria-label={`${r.rating} of 5`}>{stars(r.rating)}</span>
                  {r.title && <strong> {r.title}</strong>}
                  <div className="field-hint">{r.route} · traveled {fmtDate(r.tourDate)} · sent {fmtReceived(r.submittedAt)}</div>
                </div>
                <span className={`tag ${STATUS[r.status]?.tag || ""}`}>{STATUS[r.status]?.label || r.status}</span>
              </div>
              <p className="review-admin-body">{r.body}</p>
              {r.media.length > 0 && (
                <div className="review-admin-media">
                  {r.media.map((m, i) => m.url ? (
                    <a key={i} href={m.url} target="_blank" rel="noreferrer">
                      {m.kind === "video" ? <video src={m.url} muted playsInline preload="metadata" /> : <img src={m.url} alt="" />}
                    </a>
                  ) : <span key={i} className="field-hint">File unavailable</span>)}
                </div>
              )}
              <div className="field-hint">
                Shown as <strong>{r.displayName}{r.country ? `, ${r.country}` : ""}</strong> · booking {r.bookingCode || r.pledgeId} ({r.customers || "—"}{r.email ? `, ${r.email}` : ""})
                {r.moderatedBy && <> · {r.status} by {r.moderatedBy} {fmtReceived(r.moderatedAt)}</>}
              </div>
              <div className="review-admin-actions">
                {r.status !== "published" && <button className="btn-mini" disabled={busy === r.id} onClick={() => decide(r.id, "published")}>Publish</button>}
                {r.status !== "hidden" && <button className="btn-mini" disabled={busy === r.id} onClick={() => decide(r.id, "hidden")}>Hide</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// In a booking's drawer: make the traveler's review link, copy it or email it.
export function ReviewLinkBox({ bookingId }) {
  const [state, setState] = useState(null);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setState(null); setUrl(""); setMsg("");
    call(`/admin/bookings/${encodeURIComponent(bookingId)}/review`)
      .then(setState)
      .catch((e) => setState({ error: e.message }));
  }, [bookingId]);

  async function make(send) {
    setBusy(true); setMsg("");
    try {
      const j = await call(`/admin/bookings/${encodeURIComponent(bookingId)}/review-link`, "POST", { send });
      setUrl(j.url);
      setState((s) => ({ ...s, review: j.review }));
      if (send) setMsg(j.emailed ? `Emailed to ${state.email}.` : "The email didn't go out. Copy the link and send it yourself.");
      else {
        try { await navigator.clipboard.writeText(j.url); setMsg("Link copied. Any earlier link for this booking no longer works."); }
        catch { setMsg("Copy the link below. Any earlier link for this booking no longer works."); }
      }
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  if (!state) return null;
  const review = state.review;
  return (
    <div className="review-link-box">
      <span className="dl">Review</span>
      {state.error ? <p className="field-hint">{state.error}</p>
        : state.blocker ? <p className="field-hint">{state.blocker}</p>
        : review && review.status !== "invited" ? (
          <p className="field-hint">{review.rating}★ review sent {fmtReceived(review.submittedAt)}: <strong>{STATUS[review.status]?.label}</strong>. See <strong>Reviews</strong>.</p>
        ) : (
          <>
            <p className="field-hint">
              {review ? `Review link made ${fmtReceived(review.invitedAt)}${review.emailedAt ? " and emailed" : ""}; no review yet. A new link replaces it.` : "Ask this traveler to review their tour. They can add photos and videos."}
            </p>
            <div className="review-link-actions">
              <button className="btn-mini" disabled={busy} onClick={() => make(false)}>Copy review link</button>
              {state.email && <button className="btn-mini" disabled={busy} onClick={() => make(true)}>Email it to {state.email}</button>}
            </div>
            {url && <input className="review-link-url" readOnly value={url} onFocus={(e) => e.target.select()} />}
          </>
        )}
      {msg && <p className="field-hint" role="status">{msg}</p>}
    </div>
  );
}
