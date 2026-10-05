// A tour's published traveler reviews (069), on its page. Nothing renders
// until there is at least one: the count and average are computed by the
// server from published reviews, each tied to a booking on a date that ran.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";

const PAGE = 6;
const mediaSrc = (url) => `${API_BASE}${String(url).replace(/^\/api/, "")}`;
const monthLabel = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

function Stars({ value, label }) {
  return (
    <span className="tr-stars" role="img" aria-label={label || `${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= Math.round(value) ? "on" : ""} aria-hidden="true">★</span>)}
    </span>
  );
}

export function TourReviews({ productId }) {
  const [data, setData] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState(null); // { kind, url }

  useEffect(() => {
    let live = true;
    setData(null);
    setShown(PAGE);
    fetch(`${API_BASE}/public/tours/${encodeURIComponent(productId)}/reviews`)
      .then((r) => (r.ok ? r.json() : { count: 0, reviews: [] }))
      .then((j) => { if (live) setData(j); })
      .catch(() => { if (live) setData({ count: 0, reviews: [] }); });
    return () => { live = false; };
  }, [productId]);

  if (!data || !data.count) return null;
  const word = data.count === 1 ? "review" : "reviews";

  return (
    <section className="sec rv in tour-reviews" id="reviews">
      <h2>Traveler reviews</h2>
      <div className="tr-summary">
        <b className="tnum">{data.average.toFixed(1)}</b>
        <Stars value={data.average} label={`Average ${data.average.toFixed(1)} of 5`} />
        <span>{data.count} {word}</span>
      </div>
      <p className="tr-source">Every review here is from a traveler who booked this tour with Sawa, sent through a private link after their date ran. We check reviews before publishing them and don't edit what travelers write.</p>
      <div className="tr-list">
        {data.reviews.slice(0, shown).map((r) => (
          <article className="tr-item" key={r.id}>
            <header>
              <Stars value={r.rating} />
              {r.title && <h3>{r.title}</h3>}
            </header>
            <p className="tr-body">{r.body}</p>
            {r.media.length > 0 && (
              <div className="tr-media">
                {r.media.map((m, i) => (
                  <button type="button" key={i} className="tr-thumb" onClick={() => setOpen({ ...m, url: mediaSrc(m.url) })} aria-label={m.kind === "video" ? "Play video" : "Open photo"}>
                    {m.kind === "video"
                      ? <><video src={mediaSrc(m.url)} muted playsInline preload="metadata" /><span className="tr-play" aria-hidden="true">▶</span></>
                      : <img src={mediaSrc(m.url)} alt={`Photo from ${r.displayName}`} loading="lazy" />}
                  </button>
                ))}
              </div>
            )}
            <footer>{r.displayName}{r.country ? `, ${r.country}` : ""}{r.traveledOn ? ` · traveled ${monthLabel(r.traveledOn)}` : ""}</footer>
          </article>
        ))}
      </div>
      {data.reviews.length > shown && (
        <button type="button" className="btn plain" onClick={() => setShown((n) => n + PAGE)}>Show more reviews</button>
      )}
      {open && (
        <div className="tr-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <button type="button" className="tr-close" aria-label="Close" onClick={() => setOpen(null)}>×</button>
          <div onClick={(e) => e.stopPropagation()}>
            {open.kind === "video" ? <video src={open.url} controls autoPlay playsInline /> : <img src={open.url} alt="" />}
          </div>
        </div>
      )}
    </section>
  );
}
