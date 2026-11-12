// Tour and package cards, and the rich-text blocks a tour page shows under its itinerary
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React from "react";
import { MapPin, Check, ShieldCheck, Package, Hotel } from "lucide-react";
import { goAheadSeatsFor, isGoAheadDeparture, seatsTotal } from "../shared/departure-state.js";
import { livePriceFor, clampPrice } from "../shared/pricing.js";
import { tourSlug } from "../server/slug.js";
import { CURRENCY_SYMBOL, CURRENCY } from "../shared/currency.js";
import {
  openDates,
  confidenceFor,
  routeStopsFor,
  productFullyBooked,
  coverImage,
  pluralize,
} from "./tour-helpers.jsx";
import { CardLink } from "./SiteChrome.jsx";

function RichBlock({ html, fallback }) {
  if (html && html.replace(/<[^>]*>/g, "").trim()) {
    return <div className="rich" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (fallback) return <p>{fallback}</p>;
  return null;
}

// Meeting point, what-to-bring, and policies (only renders what's present).
function TourExtras({ product }) {
  const bring = (product.whatToBring || []).filter(Boolean);
  const hasPolicy = product.policiesHtml && product.policiesHtml.replace(/<[^>]*>/g, "").trim();
  const points = (product.meetingPoints || []).filter((m) => m && m.point);
  const hasMeeting = points.length > 0 || product.meetingPoint || product.pickupNote;
  if (!hasMeeting && !bring.length && !hasPolicy) return null;
  return (
    <div className="tour-extras">
      {hasMeeting && (
        <div className="extra-block">
          <h3><MapPin size={16} />Meeting &amp; pickup</h3>
          {points.length > 0 ? (
            <ul className="meet-points">
              {points.map((m, i) => (
                <li key={i}>
                  <strong>{m.point}</strong>
                  {m.note && <span>{m.note}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <>
              {product.meetingPoint && <p>{product.meetingPoint}</p>}
              {product.pickupNote && <p className="muted-line">{product.pickupNote}</p>}
            </>
          )}
        </div>
      )}
      {bring.length > 0 && (
        <div className="extra-block">
          <h3><Check size={16} />What to bring</h3>
          <div className="chip-row">{bring.map((b) => <span key={b}>{b}</span>)}</div>
        </div>
      )}
      {hasPolicy && (
        <div className="extra-block">
          <h3><ShieldCheck size={16} />Cancellation & policies</h3>
          <RichBlock html={product.policiesHtml} />
        </div>
      )}
    </div>
  );
}

function TourCard({ navigate, product }) {
  const goAhead = goAheadSeatsFor(product);
  const goAheadDates = product.dates.filter((departure) => isGoAheadDeparture(departure)).length;
  const leadDate = openDates(product)[0] || product.dates[0];
  const seats = leadDate ? seatsTotal(leadDate.pledges) : 0;
  const confidence = confidenceFor(seats, goAhead, !!leadDate && isGoAheadDeparture(leadDate));
  const stops = routeStopsFor(product);
  const livePrice = leadDate ? livePriceFor({ ...product, ...leadDate }, seats) : livePriceFor(product, goAhead);
  const breakPrice = clampPrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
  const full = productFullyBooked(product);

  return (
    <article className={`tour-card ${full ? "is-full" : ""}`}>
      <div className="tour-card-media" style={{ backgroundImage: `url(${coverImage(product)})` }}>
        <span className="tour-card-city">{product.city}</span>
        {full
          ? <span className="tour-card-flag full">Fully booked</span>
          : leadDate && isGoAheadDeparture(leadDate) && <span className="tour-card-flag go">GoAhead</span>}
      </div>
      <div className="tour-card-body">
        <div className="tour-card-top">
          <strong>
            <CardLink
              navigate={navigate}
              to={`/tour/${tourSlug(product)}`}
              label={full ? `${product.title} — fully booked, view dates` : `View ${product.title} tour`}
            >
              {product.title}
            </CardLink>
          </strong>
          <span className="tour-card-price">{CURRENCY_SYMBOL}{livePrice} {CURRENCY}</span>
        </div>
        <p className="tour-card-sub">{product.duration || product.vehicle} · {product.guide}</p>
        {stops && (
          <div className="route-line">
            {stops.slice(0, 3).map((stop) => <span key={stop}>{stop}</span>)}
          </div>
        )}
        {!full && (
          <div className="confidence-meter">
            <div>
              <span>{seats}/{goAhead} seats booked</span>
              <b className={confidence.tone}>{confidence.label}</b>
            </div>
            <i><em style={{ width: `${Math.min(100, (seats / goAhead) * 100)}%` }} /></i>
          </div>
        )}
        <div className="tour-card-foot">
          {/* "0 open dates" on a bookable product is a bare zero (JJ3's class).
              Zero here means nobody has started a date yet, and the model's
              answer to that state is Be the Spark — say that instead. */}
          <span>{full ? "All dates full — check back soon"
            : openDates(product).length ? `${pluralize(openDates(product).length, "open date")} · from ${CURRENCY_SYMBOL}${breakPrice} ${CURRENCY} at full group`
            : `Start your own date · from ${CURRENCY_SYMBOL}${breakPrice} ${CURRENCY} at full group`}</span>
        </div>
        {/* Decorative: the whole card is already the link above, so exposing
            this as a second control would just duplicate it in the tab order. */}
        <span className="departure-link" aria-hidden="true">
          {full ? "Fully booked — view dates" : "View tour"}
        </span>
      </div>
    </article>
  );
}

function PackageCard({ navigate, product }) {
  const goAhead = goAheadSeatsFor(product);
  const leadDate = openDates(product)[0] || product.dates[0];
  const seats = leadDate ? seatsTotal(leadDate.pledges) : 0;
  const confidence = confidenceFor(seats, goAhead, !!leadDate && isGoAheadDeparture(leadDate));
  const cities = product.cities || [product.city];
  const livePrice = leadDate ? livePriceFor({ ...product, ...leadDate }, seats) : livePriceFor(product, goAhead);
  const breakPrice = clampPrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
  const full = productFullyBooked(product);

  return (
    <article className={`tour-card package-card ${full ? "is-full" : ""}`}>
      <div className="tour-card-media" style={{ backgroundImage: `url(${coverImage(product)})` }}>
        <span className="tour-card-city"><Package size={12} />{product.nights}-night package</span>
        {full
          ? <span className="tour-card-flag full">Fully booked</span>
          : leadDate && isGoAheadDeparture(leadDate) && <span className="tour-card-flag go">GoAhead</span>}
      </div>
      <div className="tour-card-body">
        <div className="tour-card-top">
          <strong>
            <CardLink
              navigate={navigate}
              to={`/package/${tourSlug(product)}`}
              label={full ? `${product.title} — fully booked, view dates` : `View ${product.title} package`}
            >
              {product.title}
            </CardLink>
          </strong>
          <span className="tour-card-price">from {CURRENCY_SYMBOL}{livePrice} {CURRENCY}</span>
        </div>
        <p className="tour-card-sub">{cities.join(" → ")}</p>
        {!full && (
          <div className="confidence-meter">
            <div>
              <span>{seats}/{goAhead} seats booked</span>
              <b className={confidence.tone}>{confidence.label}</b>
            </div>
            <i><em style={{ width: `${Math.min(100, (seats / goAhead) * 100)}%` }} /></i>
          </div>
        )}
        <div className="tour-card-foot">
          <span><Hotel size={13} />{(product.accommodationTiers || []).length || 1} hotel tier{((product.accommodationTiers || []).length || 1) > 1 ? "s" : ""} · from {CURRENCY_SYMBOL}{breakPrice} {CURRENCY}/pp</span>
        </div>
        <span className="departure-link" aria-hidden="true">
          {full ? "Fully booked — view dates" : "View package"}
        </span>
      </div>
    </article>
  );
}

export {
  RichBlock, TourExtras, TourCard, PackageCard,
};
