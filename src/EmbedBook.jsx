// The partner widget: the brand strip, the tour list and the whole booking, shown inside an agency's own page
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { useState, useEffect } from "react";
import { ArrowRight, Package, Star, ArrowLeft, Check } from "lucide-react";
import { isPackage, depositPctFor } from "../shared/booking-policy.js";
import { seatsTotal, goAheadSeatsFor, isGoAheadDeparture } from "../shared/departure-state.js";
import { livePriceFor, clampPrice } from "../shared/pricing.js";
import { CURRENCY_SYMBOL, CURRENCY } from "../shared/currency.js";
import { monthOf } from "../shared/operators.js";
import { MAX_GROUP_SIZE } from "../shared/group-size.js";
import { minLeadDaysFor, maxHorizonDaysFor } from "../shared/request-window.js";
import { operatingDaysLabel } from "../shared/operating-days.js";
import { useEmbedAutoResize, withEmbedRef, embedPreview, refFromUrl, embedHostPage } from "./referral.js";
import { SITE_URL, SawaMark } from "./SiteChrome.jsx";
import { useReviewSummary, TourReviews } from "./TourReviews.jsx";
import {
  openDates,
  coverImage,
  formatDate,
  packagePriceFor,
  depositFor,
  PaymentTimeline,
  CancellationSchedule,
} from "./tour-helpers.jsx";
import {
  emptyTravelerDetails,
  travelerDetailsError,
  travelerDetailsBody,
  TravelerDetailsFields,
} from "./TravelerDetails.jsx";
import { API_BASE } from "./supabaseClient";
import { warnOnce } from "./warn-once.js";
import { ConfirmBookingPage } from "./BookingConfirmation.jsx";
import { BookingLookupPage } from "./PublicPages.jsx";
import { catalogueV2, turnstileSiteKey } from "./site-flags.js";
import { tooManyTravelers, GROUP_REQUEST_TITLE, GroupRequestForm } from "./GroupRequest.jsx";
import { JoinGroupLink } from "./GroupBooking.jsx";
import { keepLinksOutOfFrame } from "./embed-links.js";
import { EmbedGallery, EmbedOverview, EmbedTourDetails } from "./EmbedTourDetails.jsx";
import { CatalogueFacts, PhoneCodeStep } from "./TourDetail.jsx";
import { TurnstileBox } from "./Turnstile.jsx";

// Brand widget: the website's overall message + a click-through to the site.
// Short, professional, no per-tour detail. Embeddable on any external site.
function BrandEmbed() {
  useEmbedAutoResize(null);
  return (
    <a className="embed-banner" href={withEmbedRef(`${SITE_URL}/itineraries`)} target="_blank" rel="noopener noreferrer">
      <div className="embed-banner-content">
        <span className="embed-eyebrow"><SawaMark size={20} />Sawa Tours</span>
        <strong className="embed-banner-title">Egypt tours that actually run.</strong>
        <p className="embed-banner-text">Shared day tours and Nile cruises across Cairo, Luxor &amp; Aswan — your date is confirmed before you pay, and the price drops as the group grows.</p>
        <span className="embed-cta">Explore Egypt tours<ArrowRight size={16} /></span>
      </div>
      <div className="embed-banner-media" style={{ backgroundImage: "url(/images/hero.jpg)" }} aria-hidden="true" />
    </a>
  );
}

// Self-contained, embeddable booking widget for external sites (iframe).
// Shows a product's cover, rating, live shared price and a click-through CTA.
function EmbedWidget({ type, product }) {
  useEmbedAutoResize(product);
  // The average of the tour's published reviews (069), shown only when it has
  // some. It replaces tour_products.quality, a seeded number with no review behind it.
  const reviews = useReviewSummary(product?.id);

  if (!product) {
    return <div className="embed-card embed-empty">This tour is no longer available.</div>;
  }

  const pkg = isPackage(product);
  const lead = openDates(product)[0] || product.dates[0];
  const seats = lead ? seatsTotal(lead.pledges) : 0;
  const goAhead = goAheadSeatsFor(product);
  const livePrice = lead ? livePriceFor({ ...product, ...lead }, seats) : livePriceFor(product, goAhead);
  const breakPrice = clampPrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
  const url = withEmbedRef(`${SITE_URL}/${pkg ? "package" : "tour"}/${product.id}`);
  const facts = pkg
    ? `${(product.cities || [product.city]).join(" · ")}`
    : `${product.city} · ${product.duration || ""}`;

  return (
    <a className="embed-card" href={url} target="_blank" rel="noopener noreferrer">
      <div className="embed-media" style={{ backgroundImage: `url(${coverImage(product)})` }}>
        <span className="embed-badge">
          {pkg ? <><Package size={12} />{product.nights}-night package</> : product.city}
        </span>
      </div>
      <div className="embed-body">
        <div className="embed-meta">
          {reviews ? <span className="embed-rating" aria-label={`Average ${reviews.average.toFixed(1)} of 5 from ${reviews.count} traveler review${reviews.count === 1 ? "" : "s"}`}><Star size={12} />{reviews.average.toFixed(1)} <span className="embed-rating-count">({reviews.count})</span></span> : null}
          <span className="embed-facts">{facts}</span>
        </div>
        <strong className="embed-title">{product.title}</strong>
        {!product.catalogue?.priceNotSet && <div className="embed-price">
          <span>from</span><b>{CURRENCY_SYMBOL}{livePrice.toLocaleString()}</b><span>{CURRENCY} / person</span>
        </div>}
        {product.catalogue?.priceNotSet
          ? <p className="embed-hook">{product.catalogue.priceUnavailable || "Exchange rate not set"}</p>
          : product.catalogue?.priceSummary
          ? <p className="embed-hook">{product.catalogue.priceSummary}</p>
          : <p className="embed-hook">Shared price — it drops as the group grows, down to {CURRENCY_SYMBOL}{breakPrice.toLocaleString()} {CURRENCY}/person.</p>}
        <span className="embed-cta">View &amp; book<ArrowRight size={16} /></span>
        <span className="embed-brand">Powered by <b>Sawa&nbsp;Tours</b></span>
      </div>
    </a>
  );
}

// ---- Complete a booking's details (/booking-details/:token), phase 3 --------
function BookingDetailsPage({ token }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState("");
  const [details, setDetails] = useState(emptyTravelerDetails);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    fetch(`${API_BASE}/public/booking-details/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "This link isn't valid.");
        setInfo(j);
        const d = j.details || {};
        setPhone(d.phone || "");
        setDetails({
          names: Array.from({ length: j.seats }, (_, i) => (d.travelerNames || [])[i] || ""),
          pickupPoint: d.pickupPoint || "", nationality: d.nationality || "",
          safetyNeeds: d.safetyNeeds && d.safetyNeeds !== "None" ? d.safetyNeeds : "", safetyNone: d.safetyNeeds === "None",
        });
      })
      .catch((e) => setErr(e.message));
  }, [token]);
  async function save(e) {
    e.preventDefault();
    const missing = travelerDetailsError(details, info.seats, { needsNationality: info.needsNationality, phone });
    if (missing) return setErr(missing);
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API_BASE}/public/booking-details/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...travelerDetailsBody(details), customerPhone: phone.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "That didn't save. Please try again.");
      setDone(true);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <main className="bk-details-page" style={{ maxWidth: 560, margin: "40px auto", padding: "0 16px" }}>
      <h1>Booking details</h1>
      {!info && !err && <p>Loading…</p>}
      {err && <div className="auth-error" role="alert">{err}</div>}
      {done ? <p>Thank you. Your guide has everything they need.</p> : info && (
        <form onSubmit={save}>
          <p><strong>{info.title}</strong>, {info.dateLabel} · {info.seats} traveler{info.seats === 1 ? "" : "s"}</p>
          <label className="bk-field"><span>Phone number</span>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required autoComplete="tel" placeholder="+20 1XX XXX XXXX" />
          </label>
          <TravelerDetailsFields value={details} onChange={setDetails} seats={info.seats} needsNationality={info.needsNationality} />
          <button className="btn-primary" disabled={busy} style={{ marginTop: 16 }}>{busy ? "Saving…" : "Save details"}</button>
        </form>
      )}
    </main>
  );
}

// ---- Book inside the widget (/embed/book, /embed/book/:type/:id) ----------
// The card above is a link out: the visitor leaves the partner's site for
// sawa.tours in a new tab, and the partner is credited only if the ?ref code
// survives there — which it does only after the visitor accepts functional
// cookies, since it is kept in localStorage. These views run the whole booking
// inside the iframe instead: pick a date, add travellers, reserve. The partner
// code is read from this iframe's own address and sent with the booking, so
// attribution needs no storage and no consent, and cannot be lost on the way.
const EMBED_TRACKED = new Set();
function trackEmbedVisit(code) {
  // One click-through per partner per page load: the same counter the link-out
  // widget feeds, counted when a visitor actually opens a tour to book.
  if (!code || EMBED_TRACKED.has(code) || embedPreview()) return;
  EMBED_TRACKED.add(code);
  fetch(`${API_BASE}/track/referral`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }), keepalive: true,
  }).catch((e) => warnOnce("embed-referral-beacon", "[embed] click-through not recorded —", e.message));
}

// The partner's display name, looked up from its code on the server — the
// snippet carries only the code, so nobody can put another agency's name on it.
function useEmbedPartner(code) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (!code) return undefined;
    let live = true;
    fetch(`${API_BASE}/public/referrals/${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.name) setName(j.name); })
      .catch((e) => warnOnce("embed-partner", "[embed] partner name not loaded —", e.message));
    return () => { live = false; };
  }, [code]);
  return name;
}

// ?tours=id,id on the frame's address: the tours this partner chose to list
// (the Promote page writes it into the snippet). Absent: every tour.
function embedToursFromUrl() {
  try { return String(new URLSearchParams(window.location.search).get("tours") || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 200); }
  catch (e) { return []; }
}

// A "Join my group" link opened in the widget: which date the group is on.
// { status: "loading" | "ready" | "closed" | "invalid", ... }
function useEmbedGroup(token, products) {
  const [group, setGroup] = useState(token ? { status: "loading" } : null);
  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    fetch(`${API_BASE}/public/parties/${encodeURIComponent(token)}`)
      .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
      .then(({ ok, j }) => {
        if (!live) return;
        if (!ok || !j.departure) return setGroup({ status: "invalid", error: j.error || "This group link isn't valid." });
        setGroup({ status: j.bookable ? "ready" : "closed", token, departureId: j.departure.id, title: j.departure.title,
          lead: j.group?.leadFirstName || "", seats: j.group?.seats || 0, seatsLeft: j.seatsLeft });
      })
      .catch(() => { if (live) setGroup({ status: "invalid", error: "We couldn't open this group link. Check your connection and try again." }); });
    return () => { live = false; };
  }, [token]);
  if (!group || group.status !== "ready") return group;
  // The tour whose calendar holds the group's date.
  const product = products.find((p) => (p.dates || []).some((d) => Number(d.id) === Number(group.departureId)));
  return product ? { ...group, productId: product.id } : { ...group, status: "closed" };
}

function EmbedBook({ products = [], productId = null, phoneVerification = false, bookingCode = null, confirmToken = null, joinToken = null }) {
  const ref = refFromUrl();
  const partner = useEmbedPartner(ref);
  const preview = embedPreview();
  const [openId, setOpenId] = useState(productId);
  const product = openId ? products.find((p) => p.id === openId) : null;
  // The booking a visitor is looking at, inside the frame: null (not looking),
  // "" (the lookup, no code yet) or a code. "Manage this booking" used to open
  // sawa.tours in a new tab; it opens this instead, on the partner's page.
  const [managing, setManaging] = useState(bookingCode);
  // A "Confirm my booking" link that came back to the partner's page: the
  // snippet's script opens the frame here with the link's token.
  const [confirming, setConfirming] = useState(confirmToken);
  const group = useEmbedGroup(joinToken, products);
  const [city, setCity] = useState("");
  useEmbedAutoResize(`${openId}|${managing}|${confirming}|${group?.status}|${city}`);
  useEffect(() => { if (group?.status === "ready" && group.productId) setOpenId(group.productId); }, [group?.status, group?.productId]);

  useEffect(() => { if (productId) setOpenId(productId); }, [productId]);

  // The frame grows to fit its content, so it has nothing to scroll: opening
  // a tour from low in the list would leave the visitor looking at the bottom
  // of the form. Ask the host page (the snippet's script) to bring the widget's
  // top into view instead.
  const scrollTop = () => {
    try { window.parent?.postMessage({ type: "sawa-embed-top" }, "*"); }
    catch (e) { warnOnce("embed-top", "[embed] scroll request not posted to host —", e.message); }
  };
  const footer = (
    <div className="eb-foot">
      {partner ? <span>Booked through <b>{partner}</b> · operated with <b>Sawa&nbsp;Tours</b></span> : <span>Powered by <b>Sawa&nbsp;Tours</b></span>}
      {managing == null && !confirming && <button type="button" className="eb-foot-link" onClick={() => { setManaging(""); scrollTop(); }}>Already booked? Check your booking</button>}
    </div>
  );

  const ribbon = preview ? <div className="eb-preview">Preview — this is your widget as customers see it. Booking is switched off here.</div> : null;

  if (confirming && managing == null) {
    return (
      <div className="eb">
        <button type="button" className="eb-back" onClick={() => { setConfirming(null); scrollTop(); }}><ArrowLeft size={14} />All tours</button>
        <ConfirmBookingPage embed token={confirming} onSeeBooking={(code) => { setConfirming(null); setManaging(code); }} />
        {footer}
      </div>
    );
  }

  if (managing != null) {
    const back = () => { setManaging(null); scrollTop(); };
    return (
      <div className="eb">
        <button type="button" className="eb-back" onClick={back}><ArrowLeft size={14} />{productId || openId ? "Back to the tour" : "All tours"}</button>
        <BookingLookupPage key={managing} embed initialCode={managing} onBrowse={back} />
        {footer}
      </div>
    );
  }

  if (group && group.status !== "ready" && !openId) {
    return (
      <div className="eb">
        <div className="embed-card embed-empty" role="status">
          {group.status === "loading" ? "Opening your group's date…"
            : group.status === "closed" ? "This group's date isn't taking more bookings. Ask whoever sent you the link about another date."
            : group.error}
        </div>
        {footer}
      </div>
    );
  }

  if (productId && !product) {
    return <div className="eb"><div className="embed-card embed-empty">This tour is no longer available.</div>{footer}</div>;
  }

  if (product) {
    return (
      <div className="eb">
        {ribbon}
        {!productId && (
          <button type="button" className="eb-back" onClick={() => { setOpenId(null); scrollTop(); }}>
            <ArrowLeft size={14} />All tours
          </button>
        )}
        <EmbedBookTour key={product.id} product={product} refCode={ref} phoneVerification={phoneVerification} onManage={(code) => { setManaging(code); scrollTop(); }}
          party={group?.status === "ready" && group.productId === product.id ? group : null} />
        {footer}
      </div>
    );
  }

  const chosen = embedToursFromUrl();
  const all = products.filter((p) => p.active !== false).filter((p) => !chosen.length || chosen.includes(String(p.id)));
  // A city filter, once the list spans more than one city and is long enough
  // to need it. A package is listed under each city it visits.
  const citiesOf = (p) => (isPackage(p) ? (p.cities || [p.city]) : [p.city]).filter(Boolean);
  const cities = [...new Set(all.flatMap(citiesOf))].sort();
  const showCities = cities.length > 1 && all.length > 3;
  const list = showCities && city ? all.filter((p) => citiesOf(p).includes(city)) : all;
  return (
    <div className="eb">
      {ribbon}
      {showCities && (
        <div className="eb-cities" role="group" aria-label="Filter by city">
          {["", ...cities].map((c) => (
            <button type="button" key={c || "all"} className={c === city ? "eb-city on" : "eb-city"} aria-pressed={c === city} onClick={() => setCity(c)}>{c || "All"}</button>
          ))}
        </div>
      )}
      <div className="eb-grid">
        {list.map((p) => {
          const pkg = isPackage(p);
          const open = openDates(p);
          const lead = open[0];
          const from = lead ? livePriceFor({ ...p, ...lead }, seatsTotal(lead.pledges)) : livePriceFor(p, goAheadSeatsFor(p));
          return (
            <button type="button" key={p.id} className="eb-card" onClick={() => { setOpenId(p.id); trackEmbedVisit(ref); scrollTop(); }}>
              <span className="eb-card-media" style={{ backgroundImage: `url(${coverImage(p)})` }}>
                <span className="embed-badge">{pkg ? <><Package size={12} />{p.nights ? `${p.nights}-night package` : "Package"}</> : p.city}</span>
              </span>
              <span className="eb-card-body">
                <strong>{p.title}</strong>
                <span className="eb-card-facts">{pkg ? (p.cities || [p.city]).join(" · ") : `${p.city}${p.duration ? ` · ${p.duration}` : ""}`}</span>
                <span className="eb-card-foot">
                  <span>from <b>{CURRENCY_SYMBOL}{from.toLocaleString()}</b>{pkg ? "/pp" : ""}</span>
                  <em>{lead ? `Next: ${formatDate(lead.date)}` : "Request a date"}</em>
                </span>
              </span>
            </button>
          );
        })}
        {list.length === 0 && <div className="embed-card embed-empty">No tours to show right now.</div>}
      </div>
      {footer}
    </div>
  );
}

function EmbedBookTour({ product, refCode, phoneVerification, onManage = null, party = null }) {
  const pkg = isPackage(product);
  // Phase 3: a catalog booking carries every traveler's details.
  const [details, setDetails] = useState(emptyTravelerDetails);
  const dates = openDates(product);
  const tiers = pkg ? (product.accommodationTiers || []) : [];
  // "join" an open date, or "request" a new one. A tour with nothing open
  // starts on the request: sending the visitor to sawa.tours for it was the one
  // step that still left the partner's site.
  const [mode, setMode] = useState(dates.length || catalogueV2() ? "join" : "request");
  // Through a "Join my group" link the date is the group's.
  const partyDate = party ? dates.find((d) => Number(d.id) === Number(party.departureId)) : null;
  const [depId, setDepId] = useState(partyDate?.id ?? dates[0]?.id ?? "");
  // A catalogue tour can have a date every day for a year. Listed whole, that
  // was 83 buttons and a frame 6,500px tall, with the form below them. Past a
  // handful, the dates are shown a month at a time.
  const dateMonth = (d) => (d?.date ? monthOf(d.date) : "");
  const months = [...new Set(dates.map(dateMonth))].filter(Boolean);
  const byMonth = dates.length > 8 && months.length > 1;
  const [month, setMonth] = useState(dateMonth(partyDate || dates[0]));
  const shownDates = byMonth ? dates.filter((d) => dateMonth(d) === month) : dates;
  const monthLabel = (m) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`));
  const [reqDate, setReqDate] = useState("");
  const [matches, setMatches] = useState(null);
  const [seats, setSeats] = useState(1);
  const [tierId, setTierId] = useState(tiers[0]?.id || "");
  const [roomingType, setRoomingType] = useState("double");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneToken, setPhoneToken] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);

  const requesting = mode === "request";
  const detailsForm = catalogueV2() && !!product.catalogue && !requesting;
  const dep = requesting ? null : dates.find((d) => Number(d.id) === Number(depId)) || null;
  const booked = dep ? seatsTotal(dep.pledges) : 0;
  const remaining = dep ? Math.max(0, Number(dep.maxSeats || 0) - booked) : 0;
  const capacity = Math.max(1, Number(product.maxSeats) || MAX_GROUP_SIZE);
  const nSeats = Math.max(1, Number(seats || 1));
  // A new date is priced the way the server prices its first booking: the
  // party's own size on an empty date (see F07 on the tour page).
  const projected = dep ? Math.min(dep.maxSeats, booked + nSeats) : nSeats;
  const pp = pkg
    ? packagePriceFor(product, dep, projected, { roomingType, tierId })
    : livePriceFor(dep ? { ...product, ...dep } : product, projected);
  const depositPct = Number(dep?.depositPercent || product.depositPercent || depositPctFor(product));
  const total = pp * nSeats;
  const deposit = depositFor(total, depositPct);
  const preview = embedPreview();
  // A preview never texts a real code: the step is shown as a note instead.
  const phoneConfirmed = preview || !phoneVerification || (!!phoneToken && verifiedPhone === phone.trim());
  // The average of the tour's published reviews, shown only when it has some.
  const reviews = useReviewSummary(product.id);

  // The window this tour accepts new dates in — the same shared rule the
  // server applies — and the weekdays it runs on.
  const isoIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  const minReq = isoIn(minLeadDaysFor(product));
  const maxReq = isoIn(maxHorizonDaysFor(product));
  const opDays = Array.isArray(product.operatingDays) ? product.operatingDays : [];

  function pickMode(next) { setMode(next); setErr(""); setMatches(null); }

  function checkTraveller() {
    if (name.trim().length < 2) return "Enter the lead traveler's name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email.";
    if (!phoneConfirmed) return "Confirm your phone number with the code we send you first.";
    if (detailsForm) return travelerDetailsError(details, nSeats, { needsNationality: product.catalogue.needsNationality, phone });
    return "";
  }

  async function post(path, body) {
    const r = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  }

  const traveller = () => ({
    customerName: name.trim(), customerEmail: email.trim(), customerPhone: phone.trim() || undefined,
    phoneToken: phoneToken || undefined, seats: nSeats, turnstileToken: turnstileToken || undefined,
    ...(pkg ? { roomingType, accommodationTier: tierId } : {}),
    refCode: refCode || undefined,
    pageUrl: embedHostPage() || undefined,
    // Sent only for the group's own date: pick another and it is an ordinary booking.
    ...(catalogueV2() && partyDate && Number(dep?.id) === Number(partyDate.id) ? { partyToken: party.token } : {}),
    ...(detailsForm ? travelerDetailsBody(details) : {}),
  });

  async function book() {
    if (!dep) return setErr("Pick a date.");
    if (tooManyTravelers(nSeats)) return setErr(GROUP_REQUEST_TITLE);
    if (nSeats > remaining) return setErr(`Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this date.`);
    const problem = checkTraveller();
    if (problem) return setErr(problem);
    if (preview) return setErr("Preview only — nothing was booked. On your website this reserves the seats and emails the customer.");
    const { r, j } = await post(`/public/departures/${dep.id}/bookings`, traveller());
    setTurnstileReset((n) => n + 1);
    if (!r.ok) throw new Error(j.error || "Could not reserve seats.");
    setDone({ kind: j.confirmationRequired ? "unconfirmed" : "booked", booking: j.booking || {}, date: dep.date });
  }

  async function request(ignoreMatches = false) {
    if (!reqDate) return setErr("Pick the date you'd like.");
    if (reqDate < minReq || reqDate > maxReq) return setErr(`Pick a date between ${formatDate(minReq, { alwaysYear: true })} and ${formatDate(maxReq, { alwaysYear: true })}.`);
    if (opDays.length && !opDays.includes(new Date(`${reqDate}T12:00:00`).getDay())) return setErr(`This tour runs on ${operatingDaysLabel(opDays)} only.`);
    if (tooManyTravelers(nSeats)) return setErr(GROUP_REQUEST_TITLE);
    if (nSeats > capacity) return setErr(`This tour takes up to ${capacity} travelers per date.`);
    const problem = checkTraveller();
    if (problem) return setErr(problem);
    if (preview) return setErr("Preview only — nothing was sent. On your website this sends the date request to Sawa.");
    const { r, j } = await post("/public/departure-requests", { tourProductId: product.id, date: reqDate, ignoreMatches, ...traveller() });
    setTurnstileReset((n) => n + 1);
    // Join-first: open dates close by are offered before a new one is made.
    if (r.status === 409 && j.code === "near_matches") { setMatches(Object.assign(j.nearMatches || [], { exactDay: !!j.exactDay })); return; }
    if (!r.ok) throw new Error(j.error || "Could not request this date.");
    setDone({ kind: j.confirmationRequired ? "request_unconfirmed" : "requested", booking: j.booking || {}, date: reqDate });
  }

  async function submit(e, opts) {
    e?.preventDefault?.();
    setErr("");
    setBusy(true);
    try { await (requesting ? request(opts?.ignoreMatches) : book()); }
    catch (e2) { setErr(e2 instanceof TypeError ? "We couldn't reach Sawa — check your connection and try again. Nothing was booked." : e2.message); }
    finally { setBusy(false); }
  }

  if (done) {
    const b = done.booking;
    const n = Number(b.seats || nSeats);
    return (
      <div className="eb-panel eb-done" role="status">
        <span className="eb-done-mark"><Check size={22} /></span>
        <strong className="eb-title">{done.kind === "requested" ? "Your date is requested" : done.kind === "unconfirmed" ? "Check your email to confirm your booking" : done.kind === "request_unconfirmed" ? "Check your email to confirm your date request" : "Your seats are held"}</strong>
        <p>{n} seat{n === 1 ? "" : "s"} on <b>{product.title}</b>, {formatDate(done.date, { alwaysYear: true })}.</p>
        {b.bookingCode && <p className="eb-code">Booking code <b>{b.bookingCode}</b></p>}
        <p className="eb-muted">
          {done.kind === "unconfirmed"
            ? `We've emailed a link to ${email || "you"}. Your booking is made when you click it, and lapses if it isn't confirmed within 24 hours. Nothing is charged now.`
            : done.kind === "request_unconfirmed"
            ? `We've emailed a link to ${email || "you"}. Your request goes to Sawa when you click it, and lapses if it isn't confirmed within 24 hours. Nothing is charged now.`
            : done.kind === "requested"
            ? `Nothing is charged now. Sawa reviews the date and emails ${email || "you"} once it opens for other travelers to join.`
            : `Nothing is charged now. We've emailed the details to ${email || "you"}; the deposit link follows once this date reaches GoAhead.`}
        </p>
        {/* Group bookings (catalogue_v2): share the date, from the partner's page. */}
        {done.kind === "booked" && b.bookingCode && catalogueV2() && product.catalogue && !preview && <JoinGroupLink code={b.bookingCode} />}
        {b.bookingCode && (onManage
          ? <button type="button" className="eb-link eb-linkbtn" onClick={() => onManage(b.bookingCode)}>See or cancel this booking <ArrowRight size={14} /></button>
          : <a className="eb-link" href={`${SITE_URL}/booking/${encodeURIComponent(b.bookingCode)}`} target="_blank" rel="noopener noreferrer">Manage this booking <ArrowRight size={14} /></a>)}
      </div>
    );
  }

  return (
    // The whole tour is here, so nothing sends the visitor to sawa.tours to
    // read it: photos, overview, itinerary, inclusions, reviews, and the
    // payment and cancellation terms beside the form they apply to.
    <div className="eb-panel eb-tour" onClickCapture={keepLinksOutOfFrame}>
      <EmbedGallery images={product.images} fallback={coverImage(product)} title={product.title} />
      <div className="eb-head">
        <strong className="eb-title">{product.title}</strong>
        <span className="eb-facts">
          {pkg ? (product.cities || [product.city]).join(" → ") : product.city}{product.duration ? ` · ${product.duration}` : ""}
          {reviews ? <span className="eb-rating" aria-label={`Average ${reviews.average.toFixed(1)} of 5 from ${reviews.count} traveler review${reviews.count === 1 ? "" : "s"}`}> · <Star size={12} /> {reviews.average.toFixed(1)} ({reviews.count})</span> : null}
        </span>
        {product.catalogue?.priceNotSet
          ? <p className="eb-desc"><b>{product.catalogue.priceUnavailable || "Exchange rate not set"}</b></p>
          : product.catalogue?.priceSummary && <p className="eb-desc"><b>{product.catalogue.priceSummary}</b></p>}
        <EmbedOverview product={product} />
      </div>

      <div className="eb-cols">
      <EmbedTourDetails product={product} isPackage={pkg}>
        {catalogueV2() && product.catalogue && <CatalogueFacts facts={product.catalogue} />}
        <TourReviews productId={product.id} />
      </EmbedTourDetails>

      <form className="eb-form" onSubmit={submit} onFocusCapture={() => trackEmbedVisit(refCode)}>
        {requesting ? (
          <div className="eb-dates">
            <span className="eb-label">{dates.length ? "Your own date" : "No dates are open yet — pick yours"}</span>
            <label className="eb-row eb-one">
              <input type="date" min={minReq} max={maxReq} value={reqDate} onChange={(e) => { setReqDate(e.target.value); setMatches(null); setErr(""); }} aria-label="Date you'd like" />
            </label>
            <p className="eb-note">
              {opDays.length ? `Runs on ${operatingDaysLabel(opDays)}. ` : ""}
              Sawa reviews the date, then it opens for other travelers to join. Nothing is charged unless it reaches GoAhead.
            </p>
            {dates.length > 0 && <button type="button" className="eb-switch" onClick={() => pickMode("join")}>Back to the open dates</button>}
          </div>
        ) : (
          <fieldset className="eb-dates">
            <legend>{pkg ? "Start date" : "Date"}</legend>
            {byMonth && (
              <div className="eb-months" role="group" aria-label="Month">
                {months.map((m) => (
                  <button type="button" key={m} className={m === month ? "eb-city on" : "eb-city"} aria-pressed={m === month}
                    onClick={() => { setMonth(m); const first = dates.find((d) => dateMonth(d) === m); if (first) setDepId(first.id); setErr(""); }}>{monthLabel(m)}</button>
                ))}
              </div>
            )}
            <div className={byMonth ? "eb-date-list many" : "eb-date-list"}>
            {shownDates.map((d) => {
              const n = seatsTotal(d.pledges);
              const need = Math.max(0, goAheadSeatsFor(d) - n);
              const go = isGoAheadDeparture(d);
              const on = Number(d.id) === Number(depId);
              return (
                <button type="button" key={d.id} className={on ? "eb-date on" : "eb-date"} aria-pressed={on} onClick={() => { setDepId(d.id); setErr(""); }}>
                  <span><b>{formatDate(d.date, { alwaysYear: true })}</b>{!pkg && d.time ? <em> · {d.time}</em> : null}</span>
                  <span className={go ? "eb-tag go" : "eb-tag"}>{catalogueV2() && d.catalogueLabel ? d.catalogueLabel : go ? "Confirmed" : `${need} more to confirm`}</span>
                  <span className="eb-left">{Math.max(0, d.maxSeats - n)} seats left</span>
                </button>
              );
            })}
            </div>
            {!catalogueV2() && <button type="button" className="eb-switch" onClick={() => pickMode("request")}>None of these work? Request your own date</button>}
            {catalogueV2() && !dates.length && <p className="eb-note">No dates are open for booking right now. New dates are added to the calendar regularly.</p>}
            {partyDate && (Number(depId) === Number(partyDate.id)
              ? <p className="eb-note eb-party"><Check size={14} />You're booking through {party.lead ? `${party.lead}'s` : "a"} group link: your seats join the same group.</p>
              : <p className="eb-note eb-party">This isn't the group's date. <button type="button" className="eb-switch" onClick={() => { setDepId(partyDate.id); setMonth(dateMonth(partyDate)); }}>Back to the group's date</button></p>)}
          </fieldset>
        )}

        {matches && (
          <div className="eb-matches" role="status">
            {matches.length ? (
              <>
                <p>{matches.exactDay ? "This tour already has a group on that day — join it:" : "There's already an open date close to that one — join it and your group confirms sooner:"}</p>
                {matches.map((m) => {
                  const known = dates.some((d) => Number(d.id) === Number(m.id));
                  return (
                    <div key={m.id} className="eb-match">
                      <span><b>{formatDate(m.date, { alwaysYear: true })}</b> · {seatsTotal(m.pledges)} booked</span>
                      {known && <button type="button" className="eb-switch" onClick={() => { setDepId(m.id); pickMode("join"); }}>Join this date</button>}
                    </div>
                  );
                })}
              </>
            ) : <p>There's already an open date close to that one.</p>}
            {!matches.exactDay && <button type="button" className="eb-switch" disabled={busy} onClick={(e) => submit(e, { ignoreMatches: true })}>No thanks — request {reqDate ? formatDate(reqDate, { alwaysYear: true }) : "my date"} anyway</button>}
          </div>
        )}

        {pkg && tiers.length > 0 && (
          <div className="eb-row">
            <label>Hotel &amp; cruise tier
              <select value={tierId} onChange={(e) => setTierId(e.target.value)}>
                {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>Room
              <select value={roomingType} onChange={(e) => setRoomingType(e.target.value)}>
                <option value="single">Single</option><option value="double">Double / twin</option><option value="triple">Triple</option>
              </select>
            </label>
          </div>
        )}

        <div className="eb-row">
          <label>Travelers
            <input type="number" min="1" value={seats} onChange={(e) => setSeats(e.target.value)} />
          </label>
          <label>Lead traveler
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Full name" />
          </label>
        </div>
        {tooManyTravelers(nSeats) && <GroupRequestForm size={nSeats} product={product} date={dep?.date} turnstileToken={turnstileToken} />}
        <div className="eb-row">
          <label>Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@email.com" />
          </label>
          <label>{phoneVerification ? "Mobile" : detailsForm ? "Phone" : "Phone (optional)"}
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="+20 1XX XXX XXXX" />
          </label>
        </div>
        {detailsForm && (
          <div className="eb-details">
            <TravelerDetailsFields value={details} onChange={setDetails} seats={nSeats} leadName={name} className="eb-field"
              needsNationality={product.catalogue.needsNationality} pickupHint={product.catalogue.pickupArea || ""} />
          </div>
        )}
        {phoneVerification && (preview
          ? <p className="eb-note">Customers confirm their mobile number with a one-time code here.</p>
          : <PhoneCodeStep phone={phone} confirmed={phoneConfirmed} onVerified={(token, num) => { setPhoneToken(token); setVerifiedPhone(num); }} />
        )}

        <div className="eb-sum">
          <div><span>{CURRENCY_SYMBOL}{pp.toLocaleString()} × {nSeats} traveler{nSeats === 1 ? "" : "s"}</span><b>{CURRENCY_SYMBOL}{total.toLocaleString()}</b></div>
          <div><span>Deposit once the date is confirmed ({depositPct}%)</span><b>{CURRENCY_SYMBOL}{deposit.toLocaleString()}</b></div>
          <p>Nothing is charged today. The shared price drops as the group grows.</p>
          {/* The terms a reservation is made under, in view before it is made —
              the tour page shows both here, and the widget showed neither. */}
          <PaymentTimeline />
          <CancellationSchedule tour={product} depositPct={depositPct} />
        </div>

        {!preview && <TurnstileBox siteKey={turnstileSiteKey()} onToken={setTurnstileToken} resetKey={turnstileReset} />}
        {err && <div className={preview && err.startsWith("Preview only") ? "eb-preview" : "eb-err"} role="alert">{err}</div>}
        {requesting ? (
          <button className="embed-cta eb-submit" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Request this date"}{!busy && <ArrowRight size={16} />}
          </button>
        ) : (
          <button className="embed-cta eb-submit" type="submit" disabled={busy || remaining <= 0}>
            {busy ? "Reserving…" : remaining <= 0 ? "Date full" : "Reserve seats"}{!busy && remaining > 0 && <ArrowRight size={16} />}
          </button>
        )}
      </form>
      </div>
    </div>
  );
}

export {
  BrandEmbed, EmbedWidget, BookingDetailsPage, EMBED_TRACKED, trackEmbedVisit, useEmbedPartner,
  embedToursFromUrl, useEmbedGroup, EmbedBook, EmbedBookTour,
};
