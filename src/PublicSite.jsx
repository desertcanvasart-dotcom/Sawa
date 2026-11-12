// The catalogue home: the editorial front page wired to live tours and departures
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { useState, useEffect } from "react";
import { Search, ShieldCheck, Car, BadgeCheck, CalendarDays, Package } from "lucide-react";
import { isPackage } from "../shared/booking-policy.js";
import { seatsTotal, isGoAheadDeparture } from "../shared/departure-state.js";
import { observeReveal, SxChrome, SectionHeading } from "./SiteChrome.jsx";
import { pageFromPath } from "./page-paths.js";
import { TourDetailV2 } from "./TourDetail.jsx";
import { PublicRoute } from "./PublicPages.jsx";
import { routeStopsFor, destinationCopy, formingLabel } from "./tour-helpers.jsx";
import { PackageCard, TourCard } from "./TourCards.jsx";

function PublicSite({
  path,
  phoneVerification = false,
  cityStats,
  customerCalendars,
  customerSummary,
  isSaving,
  navigate,
  notice,
  onBookPublicDeparture,
  onCancelPublicBooking,
  publicBooking,
  routeTour,
  routePackage,
  operatorsByProduct,
  selectedCity,
  setSelectedCity,
  tourId,
  packageId,
}) {
  const [publicView, setPublicView] = useState("day_tours");
  const dayProducts = customerCalendars.filter((p) => !isPackage(p));
  const packageProductsList = customerCalendars.filter((p) => isPackage(p));

  const liveDepartures = dayProducts
    .flatMap((product) => product.dates.map((departure) => ({ ...departure, product })))
    .sort((a, b) => seatsTotal(b.pledges) - seatsTotal(a.pledges))
    .slice(0, 4);

  const orderedCalendars = (publicView === "packages" ? packageProductsList : dayProducts).slice().sort((a, b) => {
    const aLead = a.dates[0];
    const bLead = b.dates[0];
    const aSeats = aLead ? seatsTotal(aLead.pledges) : 0;
    const bSeats = bLead ? seatsTotal(bLead.pledges) : 0;
    const aConfirmed = aLead && isGoAheadDeparture(aLead) ? 1 : 0;
    const bConfirmed = bLead && isGoAheadDeparture(bLead) ? 1 : 0;
    return bConfirmed - aConfirmed || bSeats - aSeats;
  });

  useEffect(() => {
    return observeReveal(document, ".reveal", { threshold: 0.1, rootMargin: "0px 0px -50px 0px" });
  }, [publicView, tourId, packageId]);

  if ((tourId && !routeTour) || (packageId && !routePackage)) {
    return (
      <SxChrome navigate={navigate}>
        <section className="loading-screen">
          <strong>Not found.</strong>
          <button className="primary" onClick={() => navigate("/")}>Back to tours</button>
        </section>
      </SxChrome>
    );
  }

  const showDetail = routeTour || routePackage;
  const page = (path === "/" || path === "") ? "home" : (showDetail ? "detail" : pageFromPath(path));

  // The home page is the single static editorial page served at "/". If the SPA
  // ever lands on "home" (e.g. a client-side link), hard-redirect to it so there
  // is only ever ONE home design.
  if (page === "home") {
    if (typeof window !== "undefined") window.location.replace("/");
    return null;
  }

  // Editorial detail page — day tours AND packages use the same design/booking.
  if (routeTour || routePackage) {
    return (
      <TourDetailV2
        isSaving={isSaving}
        navigate={navigate}
        phoneVerification={phoneVerification}
        onBookPublicDeparture={onBookPublicDeparture}
        onCancelPublicBooking={onCancelPublicBooking}
        publicBooking={publicBooking}
        tour={routeTour || routePackage}
        allProducts={customerCalendars}
        operatorsByProduct={operatorsByProduct}
      />
    );
  }

  // Standalone marketing/legal pages share the nav + footer shell.
  if (page !== "home" && page !== "detail") {
    return (
      <SxChrome navigate={navigate}>
        <PublicRoute
          page={page}
          path={path}
          navigate={navigate}
          customerCalendars={customerCalendars}
          customerSummary={customerSummary}
          cityStats={cityStats}
          selectedCity={selectedCity}
          setSelectedCity={setSelectedCity}
          operatorsByProduct={operatorsByProduct}
        />
      </SxChrome>
    );
  }

  return (
    <SxChrome navigate={navigate}>
      {!showDetail && (
      <section className="public-hero hero-soft">
        {!showDetail ? (
          <div className="hero-soft-grid">
            <div className="hero-soft-copy">
              <p className="hero-eyebrow">Shared departures, confirmed together</p>
              <h1>Egypt tours that actually run.</h1>
              <span>Shared day tours and multi-day packages across Cairo, Luxor, and Aswan — with live seat counts, so you know your date is going before you pay.</span>

              <form
                className="hero-search-bar"
                onSubmit={(event) => {
                  event.preventDefault();
                  navigate("/itineraries");
                }}
              >
                <div className="hsb-field">
                  <label htmlFor="hsb-city">Destination</label>
                  <select id="hsb-city" value={selectedCity} onChange={(event) => setSelectedCity(event.target.value)}>
                    <option value="All cities">All Egypt</option>
                    {cityStats.map((city) => <option key={city.name} value={city.name}>{city.name}</option>)}
                  </select>
                </div>
                <span className="hsb-divider" aria-hidden="true" />
                <div className="hsb-field">
                  <label htmlFor="hsb-type">Trip type</label>
                  <select id="hsb-type" value={publicView} onChange={(event) => setPublicView(event.target.value)}>
                    <option value="day_tours">Day tours</option>
                    <option value="packages">Multi-day packages</option>
                  </select>
                </div>
                <button className="hsb-go" type="submit">
                  <Search size={18} />
                  <span>Search</span>
                </button>
              </form>

              <div className="hero-stats">
                <span><b>{customerSummary.goAheadDates}</b> confirmed running</span>
                <span className="hero-stats-sep" aria-hidden="true" />
                <span><b>{customerSummary.pendingDates}</b> forming now</span>
                <span className="hero-stats-sep" aria-hidden="true" />
                <span><b>{customerSummary.tours}</b> tours &amp; packages</span>
              </div>
            </div>

            <div className="hero-soft-media">
              <img
                src="/images/hero.jpg"
                alt="Pyramid of Giza at golden hour"
                loading="eager"
              />
              <div className="hero-media-chip">
                <span className="hero-chip-dot" aria-hidden="true" />
                <div>
                  <strong>
                    {customerSummary.goAheadDates} {customerSummary.goAheadDates === 1 ? "group" : "groups"} going ahead
                  </strong>
                  <span>Confirmed — guide &amp; transport booked</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="hero-copy">
              <p>Live shared departures</p>
              <h1>{routeTour?.title || routePackage?.title}</h1>
              <span>Live date status, clear inclusions, and a visible path to confirmation.</span>
            </div>
            {routeTour && (
              <div className="hero-route-card">
                {(routeStopsFor(routeTour) || [routeTour.city]).map((stop) => <span key={stop}>{stop}</span>)}
              </div>
            )}
            {routePackage && (
              <div className="hero-route-card">
                {(routePackage.cities || [routePackage.city]).map((stop) => <span key={stop}>{stop}</span>)}
              </div>
            )}
          </>
        )}
      </section>
      )}

      <section className="public-content">
        {notice && <div className="notice" role="status">{notice}</div>}
        {!showDetail && (
          <>
            <section className="how reveal" id="how-it-works">
              <div className="how-head">
                <SectionHeading kicker="How Sawa works" title="Your date is confirmed before you pay a cent." />
                <p className="how-lead">Sawa pools small bookings into one shared group. You hold a seat for free; once enough travelers join the same date, it is confirmed to run.</p>
              </div>
              <div className="how-grid">
                <article className="how-step">
                  <span className="how-num">01</span>
                  <h3>Hold a seat, free</h3>
                  <p>Pick a date and reserve your spot. No card, no deposit — you simply join the forming group.</p>
                </article>
                <article className="how-step">
                  <span className="how-num">02</span>
                  <h3>The group fills</h3>
                  <p>As more travelers book the same date, the shared price drops and the trip moves toward GoAhead.</p>
                </article>
                <article className="how-step is-go">
                  <span className="how-num">03</span>
                  <h3>It runs — confirmed.</h3>
                  <p>At minimum seats we confirm the guide and vehicle and send you a secure payment link for your deposit. If it never fills, you pay nothing.</p>
                </article>
              </div>
              <div className="trust-band">
                <span><ShieldCheck size={16} />Licensed guides</span>
                <span><Car size={16} />Vehicle &amp; pickup checks</span>
                <span><BadgeCheck size={16} />No payment until confirmed</span>
              </div>
            </section>

            <section className="departure-board reveal" id="live-departures">
              <div className="board-header">
                <SectionHeading kicker="Live departures" title={publicView === "packages" ? "Packages forming now" : "Groups forming now"} />
                <div className="view-toggle" role="tablist">
                  <button role="tab" aria-selected={publicView === "day_tours"} className={publicView === "day_tours" ? "active" : ""} onClick={() => setPublicView("day_tours")}>
                    <CalendarDays size={16} />Day tours ({dayProducts.length})
                  </button>
                  <button role="tab" aria-selected={publicView === "packages"} className={publicView === "packages" ? "active" : ""} onClick={() => setPublicView("packages")}>
                    <Package size={16} />Packages ({packageProductsList.length})
                  </button>
                </div>
              </div>
              <div className="departure-modules">
                {orderedCalendars.length === 0 && <p className="empty-day">No {publicView === "packages" ? "packages" : "day tours"} available in this city yet.</p>}
                {orderedCalendars.map((product) => (
                  isPackage(product)
                    ? <PackageCard key={product.id} navigate={navigate} product={product} />
                    : <TourCard key={product.id} navigate={navigate} product={product} />
                ))}
              </div>
            </section>

            <section className="destinations reveal" id="destinations">
              <SectionHeading kicker="Where to go" title="Three cities, one shared standard." />
              <div className="destination-strip">
                {cityStats.map((city) => (
                  <button
                    type="button"
                    aria-pressed={selectedCity === city.name}
                    className={selectedCity === city.name ? "destination-chip active" : "destination-chip"}
                    key={city.name}
                    onClick={() => { setSelectedCity(city.name); document.getElementById("live-departures")?.scrollIntoView({ behavior: "smooth" }); }}
                    style={{ backgroundImage: `linear-gradient(180deg, rgba(20,17,12,.10), rgba(20,17,12,.82)), url(${destinationCopy[city.name]?.image})` }}
                  >
                    <strong>{city.name}</strong>
                    <span>{destinationCopy[city.name]?.tags}</span>
                    <b>{formingLabel(city)}</b>
                  </button>
                ))}
              </div>
            </section>

            {/* A review wall stood here: "4.9 ★★★★★ from 312 confirmed travelers",
                headed "Travelers who actually went", above named five-star quotes.
                The pledges table has never held a row, so no traveler has been on a
                Sawa departure and none of it could be evidenced.
                It was already unreachable — this branch does not render — but it
                shipped in the bundle and was one conditional away from being live
                again, so it goes rather than staying as something to rediscover. */}
          </>
        )}
      </section>
    </SxChrome>
  );
}

export {
  PublicSite,
};
