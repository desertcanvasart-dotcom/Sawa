// The tour itself, inside the partner widget (/embed/book/…).
//
// The widget used to show one cropped photo and three clamped lines, then send
// the visitor to sawa.tours for "Full itinerary & what's included" — off the
// partner's site, which is the one thing the widget exists to avoid. These are
// the tour page's own facts (photos, overview, itinerary, inclusions, meeting
// point), drawn with the widget's theme variables so they take the host site's
// colours, and with no link out.
//
// Presentational only: everything comes from the product record the widget
// already holds. What needs the app's own rules (reviews, catalogue facts) is
// passed in as children by main.jsx, so no rule is restated here.
import React, { useState } from "react";
import { sizedImage, imageSrcSet } from "../shared/image-size.js";

const text = (s) => String(s || "").replace(/<[^>]*>/g, "").trim();
const hasHtml = (s) => /<\w/.test(String(s || "")) && text(s).length > 0;

// The photos: one large, the rest as thumbnails that swap into it.
export function EmbedGallery({ images = [], fallback, title }) {
  const list = images.filter((i) => i?.url);
  const shown = list.length ? list : fallback ? [{ url: fallback }] : [];
  const [at, setAt] = useState(0);
  if (!shown.length) return null;
  const current = shown[Math.min(at, shown.length - 1)];
  return (
    <div className="eb-gallery">
      <img className="eb-gallery-main" src={current.url} srcSet={imageSrcSet(current.url)} sizes="(max-width: 760px) 100vw, 760px" alt={current.alt || title} />
      {current.caption && <span className="eb-gallery-cap">{current.caption}</span>}
      {shown.length > 1 && (
        <div className="eb-thumbs" role="group" aria-label="Photos">
          {shown.slice(0, 8).map((img, i) => (
            <button type="button" key={img.url} className={i === at ? "eb-thumb on" : "eb-thumb"} aria-pressed={i === at}
              aria-label={`Photo ${i + 1} of ${Math.min(shown.length, 8)}`} onClick={() => setAt(i)}>
              <img src={sizedImage(img.url, 480)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmbedOverview({ product }) {
  if (hasHtml(product.overviewHtml)) return <div className="rich eb-overview" dangerouslySetInnerHTML={{ __html: product.overviewHtml }} />;
  return product.description ? <p className="eb-overview">{product.description}</p> : null;
}

function Section({ title, children }) {
  return <section className="eb-sec"><h3>{title}</h3>{children}</section>;
}

export function EmbedTourDetails({ product, isPackage = false, children }) {
  const itin = (product.itinerary || []).filter((d) => d && (d.title || d.description));
  const included = (product.included || []).filter(Boolean);
  const notIncluded = (product.notIncluded || []).filter(Boolean);
  const bring = (product.whatToBring || []).filter(Boolean);
  const points = (product.meetingPoints || []).map((m) => (typeof m === "string" ? m : m?.name || m?.label || m?.title || "")).filter(Boolean);
  const facts = [
    product.duration ? ["Duration", product.duration] : null,
    product.guide ? ["Guide", product.guide] : null,
    product.vehicle ? ["Transport", product.vehicle] : null,
    product.meetingPoint ? ["Meeting point", product.meetingPoint] : null,
    !product.meetingPoint && points.length ? ["Meeting points", points.join(" · ")] : null,
    product.pickupNote ? ["Pickup", product.pickupNote] : null,
  ].filter(Boolean);

  return (
    <div className="eb-info">
      {itin.length > 0 && (
        <Section title={isPackage ? "Day by day" : "The shape of the day"}>
          <ol className="eb-itin">
            {itin.map((d, i) => (
              <li key={d.day || i}>
                <span className="eb-itin-n" aria-hidden="true">{isPackage ? `D${d.day || i + 1}` : i + 1}</span>
                <div>
                  {(d.city || d.time) && <span className="eb-itin-when">{d.city || d.time}</span>}
                  <b>{d.title || `Stop ${i + 1}`}</b>
                  {d.description && (hasHtml(d.description)
                    ? <div className="rich" dangerouslySetInnerHTML={{ __html: d.description }} />
                    : <p>{text(d.description)}</p>)}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {(included.length > 0 || notIncluded.length > 0) && (
        <Section title="What's included">
          <div className="eb-inc">
            {included.length > 0 && <ul className="yes" aria-label="Included">{included.map((x) => <li key={x}>{x}</li>)}</ul>}
            {notIncluded.length > 0 && <ul className="no" aria-label="Not included">{notIncluded.map((x) => <li key={x}>{x}</li>)}</ul>}
          </div>
        </Section>
      )}

      {facts.length > 0 && (
        <Section title="Good to know">
          <dl className="eb-facts-list">
            {facts.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
          </dl>
        </Section>
      )}

      {bring.length > 0 && (
        <Section title="What to bring">
          <ul className="eb-bring">{bring.map((x) => <li key={x}>{x}</li>)}</ul>
        </Section>
      )}

      {children}
    </div>
  );
}
