// The tour page: its facts, its booking drawer, the phone-code step and the date-request path
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React, { useState, useRef, useEffect } from "react";
import { CURRENCY_SYMBOL, CURRENCY, CURRENCY_PROSE } from "../shared/currency.js";
import { isPackage, depositPctFor, hasNileCruise, CRUISE_STANDARD_NOTE } from "../shared/booking-policy.js";
import { goAheadSeatsFor, seatsTotal, isGoAheadDeparture, isBookingOpen } from "../shared/departure-state.js";
import { livePriceFor } from "../shared/pricing.js";
import { MAX_GROUP_SIZE, GROUP_MAX_WORD, numberWord } from "../shared/group-size.js";
import { minLeadDaysFor, maxHorizonDaysFor } from "../shared/request-window.js";
import { operatingDaysLabel } from "../shared/operating-days.js";
import { UNNAMED_OPERATOR } from "../shared/operator-label.js";
import { tourSlug } from "../server/slug.js";
import { API_BASE, apiFetch } from "./supabaseClient";
import { SxCheck, observeReveal, SxNav, SpaLink, SxX, SxArrow, SxFooter } from "./SiteChrome.jsx";
import { warnOnce } from "./warn-once.js";
import {
  emptyTravelerDetails,
  travelerDetailsError,
  travelerDetailsBody,
  TravelerDetailsFields,
} from "./TravelerDetails.jsx";
import { catalogueV2, turnstileSiteKey } from "./site-flags.js";
import {
  packagePriceFor,
  depositFor,
  coverImage,
  DetailPending,
  formatDate,
  balanceDueLabel,
  PaymentTimeline,
  CancellationSchedule,
  openDates,
} from "./tour-helpers.jsx";
import { tooManyTravelers, GROUP_REQUEST_TITLE, GroupRequestForm } from "./GroupRequest.jsx";
import { TourReviews } from "./TourReviews.jsx";
import { RequestCalendar } from "./RequestCalendar.jsx";
import { TurnstileBox } from "./Turnstile.jsx";
import { JoinGroupLink, partyTokenFromUrl } from "./GroupBooking.jsx";

// S04 — "send me a code", then "here it is". Twilio sends and checks the code;
// the server hands back a token for this number, which the booking carries.
// F06 — the departure a link asked for (?date=<id>), if it is one of this
// tour's bookable dates. An unknown or stale id is ignored, not an error.
function requestedDate(tour) {
  const want = new URLSearchParams(window.location.search).get("date");
  if (!want) return null;
  return (tour.dates || []).find((d) => String(d.id) === want) || null;
}

function PhoneCodeStep({ phone, confirmed, onVerified }) {
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const typed = phone.trim();

  async function post(path, body) {
    const r = await fetch(`${API_BASE}/public/phone-verifications${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }
  async function send(channel) {
    setMsg("");
    if (typed.length < 6) return setMsg("Enter your mobile number first.");
    setBusy(true);
    try { await post("", { phone: typed, channel }); setSentTo(typed); setCode(""); setMsg(channel === "whatsapp" ? "Code sent on WhatsApp." : "Code sent by text message."); }
    catch (e) { setMsg(e instanceof TypeError ? "We couldn't reach Sawa — check your connection." : e.message); }
    finally { setBusy(false); }
  }
  async function check() {
    setMsg("");
    setBusy(true);
    try { const d = await post("/check", { phone: sentTo, code }); onVerified(d.phoneToken, sentTo); setMsg(""); }
    catch (e) { setMsg(e instanceof TypeError ? "We couldn't reach Sawa — check your connection." : e.message); }
    finally { setBusy(false); }
  }

  if (confirmed) return <div className="bk-ok" role="status"><SxCheck /> Mobile number confirmed.</div>;
  const awaitingCode = sentTo && sentTo === typed;
  return (
    <div className="bk-verify">
      <p className="bk-verify-note">To hold a seat, confirm your mobile number with a one-time code.</p>
      {!awaitingCode ? (
        <div className="bk-verify-row">
          <button type="button" className="btn plain" disabled={busy} onClick={() => send("sms")}>{busy ? "Sending…" : "Text me a code"}</button>
          <button type="button" className="btn plain" disabled={busy} onClick={() => send("whatsapp")}>WhatsApp me a code</button>
        </div>
      ) : (
        <div className="bk-verify-row">
          <input inputMode="numeric" autoComplete="one-time-code" aria-label="Verification code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))} />
          <button type="button" className="btn plain" disabled={busy || code.length < 4} onClick={check}>{busy ? "Checking…" : "Confirm"}</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => { setSentTo(""); setMsg(""); }}>Send a new code</button>
        </div>
      )}
      {msg && <div className={awaitingCode && !busy && /sent/.test(msg) ? "bk-verify-msg" : "bk-err"} role={/sent/.test(msg) ? "status" : "alert"}>{msg}</div>}
    </div>
  );
}

// catalogue_v2 — the fixed parts of a product's published specification that
// the "What's included" lists don't already say. Only what the spec states;
// an empty field is left out rather than guessed.
function CatalogueFacts({ facts }) {
  const bands = facts.vehicleByBand
    ? [["4–6", facts.vehicleByBand["4-6"]], ["7–9", facts.vehicleByBand["7-9"]], ["10–12", facts.vehicleByBand["10-12"]]].filter(([, v]) => v)
    : [];
  const rows = [
    facts.guideLanguages?.length ? ["Guide", `Licensed guide speaking ${facts.guideLanguages.join(", ")}`] : null,
    facts.meals ? ["Meals", facts.meals] : null,
    facts.pickupArea ? ["Pickup", facts.pickupWindow ? `${facts.pickupArea} (${facts.pickupWindow})` : facts.pickupArea] : null,
    facts.endCity ? ["Ends in", facts.endCity] : null,
    bands.length ? ["Vehicle", bands.map(([b, v]) => `${b} travelers: ${v}`).join("; ")] : null,
    facts.roomCategories?.length ? ["Rooms", facts.roomCategories.map((r) => r.name).join(", ")] : null,
    facts.addons?.length ? ["Optional extras", facts.addons.map((a) => (a.price != null ? `${a.name} (${CURRENCY_SYMBOL}${a.price})` : a.name)).join(", ")] : null,
  ].filter(Boolean);
  if (!rows.length) return null;
  return (
    <section className="sec rv">
      <h2>The details</h2>
      <dl className="cat-facts">
        {rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}
      </dl>
    </section>
  );
}

function TourDetailV2({ isSaving, navigate, phoneVerification = false, onBookPublicDeparture, onCancelPublicBooking, publicBooking, tour: tourProp, allProducts = [], operatorsByProduct = {} }) {
  const rootRef = useRef(null);

  // A page reached by clicking through from the catalogue holds the sliced copy
  // of this product — card-complete, detail-empty, flagged detailPending — so
  // it renders skeletons for "Day by day" and "What's included" until the whole
  // catalogue refresh lands, then swaps in several thousand characters of
  // itinerary. That swap is the second version of the page people notice.
  // Fetching this one product instead closes it in a single small request.
  // Overlaid, not substituted. `dates` is assembled by the parent out of the
  // departures list and does not exist on a product from the API at all, so
  // swapping the object wholesale would blank the page on tour.dates[0].
  // Everything the parent computed stays; only the stripped detail arrives.
  const [detail, setDetail] = useState(null);
  const tour = detail && detail.id === tourProp.id
    ? { ...tourProp, ...detail, dates: tourProp.dates, detailPending: false }
    : tourProp;

  useEffect(() => {
    if (!tourProp.detailPending) { setDetail(null); return; }
    let live = true;
    apiFetch(`/public/tour-products/${encodeURIComponent(tourProp.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      // A failure is not worth surfacing TO THE VISITOR: the background
      // catalogue refresh is already in flight and fills the same gap a moment
      // later. AAA1.3 — that is an argument for not rendering an error, not an
      // argument for the failure leaving no trace at all.
      .then((j) => { if (live && j?.product) setDetail(j.product); })
      .catch((e) => warnOnce("tour-detail", "[tour] background detail fetch failed —", e.message));
    return () => { live = false; };
  }, [tourProp.id, tourProp.detailPending]);

  const lead = tour.dates[0];
  // F06 — a date card links here with ?date=<departure id>; open on that date
  // when this tour has it, else on the earliest.
  const [depId, setDepId] = useState(() => requestedDate(tour)?.id ?? lead?.id ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // S04 — the token for the number the traveller confirmed. Editing the number
  // afterwards drops it: the server checks the token against the number sent.
  const [phoneToken, setPhoneToken] = useState(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const phoneConfirmed = !phoneVerification || (!!phoneToken && verifiedPhone === phone.trim());
  const [seats, setSeats] = useState(1);
  const [err, setErr] = useState("");
  // Packages are priced per hotel tier and per room type, and the server always
  // applies them (defaulting to the first tier + a double room). This page
  // renders packages too, but offered neither control and sent neither field —
  // so every package sold at the cheapest tier in a shared room, the Superior
  // and Luxury upgrades were unreachable, and a solo traveler was silently
  // booked into a double with no single supplement charged.
  const pkgTiers = isPackage(tour) ? (tour.accommodationTiers || []) : [];
  const [tierId, setTierId] = useState(pkgTiers[0]?.id || "");
  const [roomingType, setRoomingType] = useState("double");
  // Model phase 2 — what the operator's manifest needs; optional, catalog only.
  // Phase 3: required on catalog bookings (every name, pickup, nationality
  // where needed, safety needs or an explicit "none"; the phone too).
  const [details, setDetails] = useState(emptyTravelerDetails);
  const manifestForm = catalogueV2() && tour.catalogue;
  // Keep the selection valid if the tour (and therefore its tiers) changes.
  useEffect(() => {
    if (pkgTiers.length && !pkgTiers.some((t) => t.id === tierId)) setTierId(pkgTiers[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.id]);
  // Traveler-initiated date request (addendum Phase A): pick a date that
  // isn't on the board; ops reviews it before it opens.
  const [reqMode, setReqMode] = useState(false);
  const [reqDate, setReqDate] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [reqErr, setReqErr] = useState("");
  const [reqMatches, setReqMatches] = useState(null);
  const [reqDone, setReqDone] = useState(null);
  const [blockedDates, setBlockedDates] = useState(null); // operator blackouts (Autoura feed)

  const dep = tour.dates.find((d) => Number(d.id) === Number(depId)) || lead;
  const goAhead = goAheadSeatsFor(tour);
  // Whitelisted server-side by publicOperator(): name, licensed-since year,
  // verified flag and date. Never the licence number.
  // U01 — the company that runs the SELECTED date (the one with the most
  // confirmed travellers on it, fixed when bookings close), else the listing's default: the agency
  // that listed it, or the direct-bookings operator. Worked out on the server.
  const operator = operatorsByProduct[dep?.operatorAgencyId || tour.operatorAgencyId || tour.agencyId] || null;
  const booked = dep ? seatsTotal(dep.pledges) : 0;
  const remaining = dep ? Math.max(0, dep.maxSeats - booked) : 0;
  const nSeats = Math.max(1, Number(seats || 1));
  const projected = dep ? Math.min(dep.maxSeats, booked + nSeats) : nSeats;
  // Packages must price through packagePriceFor so the tier and single-room
  // supplements are included — otherwise the quoted price silently diverges
  // from what computePledgePricing() charges on the server.
  const pp = isPackage(tour)
    ? packagePriceFor(tour, dep, dep ? projected : goAhead, { roomingType, tierId })
    : dep ? livePriceFor({ ...tour, ...dep }, projected) : livePriceFor(tour, goAhead);
  const confirmed = !!dep && isGoAheadDeparture(dep);
  // F07 — a NEW date is priced the way the server prices its seed booking
  // (computePledgePricing on an empty date copied from the tour): the party's
  // own size, the tour's rates and deposit — never the headcount or deposit of
  // whichever existing date happens to be selected.
  const requestCapacity = Math.max(1, Number(tour.maxSeats) || MAX_GROUP_SIZE);
  const newDatePP = isPackage(tour)
    ? packagePriceFor(tour, null, nSeats, { roomingType, tierId })
    : livePriceFor(tour, nSeats);
  const quotePP = reqMode ? newDatePP : pp;
  const depositPct = reqMode
    ? Number(tour.depositPercent || depositPctFor(tour))
    : Number(dep?.depositPercent || tour.depositPercent || 10);
  const total = quotePP * nSeats;
  const deposit = depositFor(total, depositPct);
  const balance = Math.max(0, total - deposit);
  const seatPct = goAhead ? Math.min(100, Math.round((booked / goAhead) * 100)) : 0;
  const imgs = (tour.images || []).filter((i) => i?.url);
  const gallery = imgs.length ? imgs : [{ url: coverImage(tour) }];
  const itin = (tour.itinerary || []).filter((d) => d && (d.title || d.description));
  const included = (tour.included || []).filter(Boolean);
  const notIncluded = (tour.notIncluded || []).filter(Boolean);
  const related = allProducts.filter((p) => p.id !== tour.id && (p.dates || []).length).slice(0, 3);
  const cityLabel = isPackage(tour) ? (tour.cities || [tour.city]).join(" → ") : tour.city;

  useEffect(() => { setDepId(requestedDate(tour)?.id ?? lead?.id ?? ""); }, [lead?.id, tour.id]);
  // Picking a date writes it into the address, so a refresh, a shared link or
  // Back returns to the same date.
  function pickDate(id) {
    setDepId(id);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("date", String(id));
      window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    } catch (e) {
      warnOnce("date-param", "[tour] couldn't keep the chosen date in the address —", e.message);
    }
  }
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    // Scroll first: which elements count as "already on screen" depends on
    // being at the top of the new page, not wherever the previous one was left.
    window.scrollTo(0, 0);
    const stop = observeReveal(root, ".rv", { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    const t = setTimeout(() => root.querySelectorAll(".book [data-fill]").forEach((b) => { b.style.width = b.dataset.fill; }), 400);
    return () => { stop(); clearTimeout(t); };
  }, [tour.id]);

  async function reserve(e) {
    e.preventDefault();
    setErr("");
    if (!dep) return setErr("Pick a departure date.");
    if (name.trim().length < 2) return setErr("Enter the lead traveler's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email.");
    if (tooManyTravelers(seats)) return setErr(GROUP_REQUEST_TITLE);
    if (Number(seats) > remaining) return setErr(`Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this date.`);
    if (!phoneConfirmed) return setErr("Confirm your phone number with the code we send you first.");
    if (manifestForm) {
      const missing = travelerDetailsError(details, nSeats, { needsNationality: tour.catalogue.needsNationality, phone });
      if (missing) return setErr(missing);
    }
    const result = await onBookPublicDeparture({
      departureId: dep.id, customerName: name.trim(), customerEmail: email.trim(),
      customerPhone: phone.trim(), phoneToken: phoneToken || undefined, turnstileToken, seats: nSeats,
      // Only meaningful for packages; the server ignores them for day tours.
      ...(isPackage(tour) ? { roomingType, accommodationTier: tierId } : {}),
      ...(manifestForm ? { manifest: travelerDetailsBody(details) } : {}),
    });
    // A Turnstile token is good for one submission.
    setTurnstileReset((n) => n + 1);
    // F01 — the form used to clear straight away, before the server answered:
    // a full date, a closed cutoff or a dropped connection left the traveller
    // with an empty form and no message. Clear only on a confirmed booking.
    if (!result?.ok) {
      if (result?.error) setErr(result.error);
      return;
    }
    setName(""); setEmail(""); setPhone(""); setSeats(1); setDetails(emptyTravelerDetails());
  }

  const reqIso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  // The window this product sets, falling back to the defaults. The same pair
  // the server applies — one authority in shared/, so the calendar cannot offer
  // a day the request route will refuse.
  const REQUEST_MIN_LEAD_DAYS = minLeadDaysFor(tour);
  const REQUEST_MAX_HORIZON_DAYS = maxHorizonDaysFor(tour);
  // Which month the grid shows. Starts on the month containing the first
  // bookable day, not today — on the 29th, today's month is nearly all past and
  // the visitor opens on a grid with almost nothing left in it.
  const [reqMonth, setReqMonth] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Operating days (0=Sun … 6=Sat): tours like Nile cruises depart only on
  // fixed weekdays. The calendar greys the closed days rather than listing the
  // open ones, so a month the tour does not run in is still reachable and
  // visibly closed; the server enforces the same rule.
  const opDays = Array.isArray(tour.operatingDays) ? tour.operatingDays : [];
  // Was a second copy of the server's day table and its comma-and-"and" joiner.
  // Same rule, one implementation — so the chips and the refusal message cannot
  // phrase the same restriction differently.
  const opDaysLabel = operatingDaysLabel(opDays);

  // Operator blackout dates load lazily the first time the request panel
  // opens; eligible-date chips and the free calendar both respect them.
  useEffect(() => {
    if (!reqMode || blockedDates !== null) return;
    fetch(`${API_BASE}/public/unavailable-dates`)
      .then((r) => r.json())
      .then((d) => setBlockedDates(new Set(d.dates || [])))
      .catch(() => setBlockedDates(new Set()));
  }, [reqMode, blockedDates]);

  // Entering/leaving request mode collapses or restores ~800px of date cards
  // inside a sticky rail — without help the reflow leaves the visitor staring
  // below the widget. Keep the booking card pinned to their view on every
  // mode change, and put the cursor in the date field when the panel opens.
  const prevReqMode = useRef(reqMode);
  useEffect(() => {
    if (prevReqMode.current === reqMode) return; // skip initial mount
    prevReqMode.current = reqMode;
    const book = rootRef.current?.querySelector(".book");
    if (book) book.scrollIntoView({ behavior: "smooth", block: "start" });
    if (reqMode) setTimeout(() => rootRef.current?.querySelector(".req-date")?.focus(), 400);
  }, [reqMode]);

  const showDateField = () => {
    const el = rootRef.current?.querySelector(".req-date, .req-days");
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.focus?.(); }
  };

  async function submitDateRequest(ignoreMatches = false) {
    setReqErr(""); setReqMatches(null);
    // The date field sits at the top of the panel and the CTA at the bottom —
    // when the date is missing, bring the field to the visitor instead of
    // leaving an error they can't see the cause of.
    if (!reqDate) { setReqErr("Pick the date you want — we've highlighted the field."); showDateField(); return; }
    if (name.trim().length < 2) return setReqErr("Enter the lead traveler's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setReqErr("Enter a valid email — we'll confirm your date there.");
    if (!phoneConfirmed) return setReqErr("Confirm your phone number with the code we send you first.");
    // F07 — the same limit the server applies (the tour's own capacity), and
    // the browser's number-field limit is not enforced on a type="button".
    if (!Number.isInteger(Number(seats)) || Number(seats) < 1) return setReqErr("Enter how many travelers are coming.");
    if (tooManyTravelers(seats)) return setReqErr(GROUP_REQUEST_TITLE);
    if (Number(seats) > requestCapacity) return setReqErr(`${tour.title} takes up to ${requestCapacity} travelers per date.`);
    setReqBusy(true);
    try {
      const response = await fetch(`${API_BASE}/public/departure-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tourProductId: tour.id, date: reqDate, customerName: name.trim(),
          customerEmail: email.trim(), customerPhone: phone.trim(), phoneToken: phoneToken || undefined, seats: nSeats, ignoreMatches,
          turnstileToken: turnstileToken || undefined,
          // The seed pledge is priced on submission, so a traveler starting
          // their own package date needs the same tier/room choice as one
          // joining an existing date — otherwise it silently seeds at the
          // cheapest tier in a shared room.
          ...(isPackage(tour) ? { roomingType, accommodationTier: tierId } : {}),
        }),
      });
      const data = await response.json();
      setTurnstileReset((n) => n + 1);
      if (response.status === 409 && data.code === "near_matches") {
        // exactDay: the tour already has a group that very day — join it; no
        // second group for the same day (27 Sep 2026).
        setReqMatches(Object.assign(data.nearMatches || [], { exactDay: !!data.exactDay }));
        return;
      }
      if (!response.ok) throw new Error(data.error || "Could not request this date.");
      // Held until the traveler confirms their email (202): not a request yet.
      setReqDone({ code: data.booking?.bookingCode, date: reqDate, unconfirmed: !!data.confirmationRequired });
      setReqMode(false);
    } catch (error) {
      setReqErr(error.message);
    } finally {
      setReqBusy(false);
    }
  }

  const navLinks = [["How it works", "/how-it-works"], ["Itineraries", "/itineraries"], ["FAQ", "/faq"], ["Contact", "/contact"]];

  return (
    <div className="sx" ref={rootRef}>
      <div className="grain" />
      <SxNav navigate={navigate} />

      <main id="main">
        <div className="wrap">
          <nav className="crumbs" aria-label="Breadcrumb">
            {/* Breadcrumbs are the one navigation aid a crawler reads to
                understand hierarchy, and the JSON-LD in seo.js already claims
                this trail exists — so they have to be real links. */}
            <div className="row"><SpaLink navigate={navigate} to="/">Egypt</SpaLink><span className="sep">/</span><SpaLink navigate={navigate} to="/itineraries">Itineraries</SpaLink><span className="sep">/</span><b>{tour.title}</b></div>
          </nav>

          <header className="thead">
            <div>
              <span className="rt">{cityLabel}{tour.duration ? ` · ${tour.duration}` : ""} · Shared departure</span>
              <h1>{tour.title}</h1>
              <div className="facts">
                {tour.duration && <span className="f"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><b>{tour.duration}</b></span>}
                <span className="dot" />
                <span className="f"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></svg><b>{goAhead}–{tour.maxSeats}</b> travelers</span>
                <span className="dot" />
                <span className="f"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 11l19-9-9 19-2-8-8-2z" /></svg>{cityLabel}</span>
                {/* A star rating labelled "verified travelers" used to render here from
                    tour_products.quality — seeded values of 4.7 and 4.9 on a platform
                    that has taken zero bookings. There is no reviews table, so nothing
                    could evidence where the number came from or who gave it.
                    A rating returns when there are retained records behind it and a
                    stated source, per the amended acceptance criteria. */}
              </div>
            </div>
            {/* U03 — a heart "Save" button sat here, alone in its row, with no
                handler and no saved list behind it: a promise the page couldn't
                keep. Removed with its row until saving exists. */}
          </header>

          <section className="gallery rv" aria-label="Tour photos">
            {/* This carried an onClick to /tour/<id> — the page it is already
                on, addressed by raw id, so a click 301'd and reloaded the
                current page. It is a photo, not a control: the click is gone
                rather than converted to a link to itself. */}
            <div className="gcell big">
              {confirmed && <span className="go-badge"><span className="d" />GoAhead · confirmed</span>}
              <img src={gallery[0].url} alt={tour.title} />
            </div>
            {[1, 2, 3, 4].map((i) => gallery[i] ? (
              <div className={`gcell${i >= 3 ? " hide-sm" : ""}`} key={i}>
                <img src={gallery[i].url} alt={`${tour.title} ${i + 1}`} />
                {i === 4 && imgs.length > 5 && <button className="view-all"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>All {imgs.length} photos</button>}
              </div>
            ) : <div className={`gcell${i >= 3 ? " hide-sm" : ""}`} key={i} style={{ background: "var(--paper-2)" }} />)}
          </section>

          <div className="layout">
            <div className="content">
              <section className="sec rv">
                <h2>About this departure</h2>
                {hasHtmlSx(tour.overviewHtml) ? <div className="rich" dangerouslySetInnerHTML={{ __html: tour.overviewHtml }} /> : <p className="lead">{tour.description || "A shared Sawa departure across Egypt."}</p>}
              </section>

              {included.length > 0 && (
                <section className="sec rv">
                  <h2>Trip highlights</h2>
                  <div className="hl">
                    {included.slice(0, 4).map((h) => (
                      <div className="h" key={h}><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 11l19-9-9 19-2-8-8-2z" /></svg></span><div><b>{h}</b></div></div>
                    ))}
                  </div>
                </section>
              )}

              {tour.detailPending && <DetailPending heading="Day by day" />}
              {!tour.detailPending && itin.length > 0 && (
                <section className="sec rv">
                  {/* Packages narrate days; a day tour narrates one day's stops.
                      Same timeline, different unit — "D3" on a one-day tour
                      would claim days it does not have. A pending record may
                      carry the card slice's skeleton legs (titles, no prose) —
                      DetailPending stands in until the full record arrives. */}
                  <h2>{isPackage(tour) ? "Day by day" : "The shape of the day"}</h2>
                  <div className="timeline">
                    {itin.map((d, i) => (
                      <div className={`day${i === 0 ? " go" : ""}`} key={d.day || i}>
                        <div className="line"><div className="marker">{isPackage(tour) ? `D${d.day || i + 1}` : i + 1}</div><div className="stem" /></div>
                        <div className="content">
                          {(d.city || d.time) && <span className="dl">{d.city || d.time}</span>}
                          <h3>{d.title || `Stop ${i + 1}`}</h3>
                          {d.description && (/<\w/.test(d.description) ? <div className="rich" dangerouslySetInnerHTML={{ __html: d.description }} /> : <p>{d.description}</p>)}
                          {(d.included || []).length > 0 && <div className="tags">{d.included.slice(0, 3).map((t) => <span key={t}>{t}</span>)}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {tour.detailPending && <DetailPending heading="What's included" />}
              {(included.length > 0 || notIncluded.length > 0) && (
                <section className="sec rv">
                  <h2>What's included</h2>
                  <div className="inc-grid">
                    <div className="inc yes"><h4><span style={{ color: "#2c7a57", display: "grid", width: 18, height: 18 }}><SxCheck /></span>Included</h4>
                      <ul>{included.map((x) => <li key={x}><span className="ck"><SxCheck /></span>{x}</li>)}{!included.length && <li>Details on request.</li>}</ul>
                    </div>
                    <div className="inc no"><h4><span style={{ opacity: .6, display: "grid", width: 18, height: 18 }}><SxX /></span>Not included</h4>
                      <ul>{notIncluded.map((x) => <li key={x}><span className="ck"><SxX /></span>{x}</li>)}{!notIncluded.length && <li>—</li>}</ul>
                    </div>
                  </div>
                </section>
              )}

              {catalogueV2() && tour.catalogue && <CatalogueFacts facts={tour.catalogue} />}

              {/* "Your operator" used to render tour.guide as the operating company,
                  under a "Verified operator" badge and the line "Vetted by Sawa".
                  Every live product has guide = "Licensed Egyptologist" — a job
                  description, not a company — so the card named a verified operator
                  that does not exist, and the badge rendered whether or not there was
                  anything behind it.
                  It returns with the operator record in P2.3-R/P4.2, where the name,
                  the ETAA registration and the verification date come from a row.
                  Until then the honest thing is what the guide field can actually
                  support: who is leading the tour. No badge, no company name, and
                  nothing at all if the field is empty — never a fallback string
                  standing in for missing data. */}
              {/* The operator, from the record — the card P2.3-R held open.
                  It renders only when a company is actually attached, names it
                  only then, and says "verified" only when someone recorded a
                  verification. No badge on an unverified row: that is what the
                  old card did with tour.guide, and it named a verified operator
                  that did not exist.
                  No licence number, ever — /verify promises operators it is not
                  shared outside Sawa, and publicOperator() on the server does
                  not send it. */}
              {operator ? (
                <section className="sec rv">
                  <h2>Your operator</h2>
                  <div className="op-card"><div className="op-inner">
                    <div className="op-meta">
                      <h3>{operator.name}</h3>
                      {operator.verified && (
                        <p className="op-verified"><SxCheck />Verified by Sawa{operator.verifiedAt ? ` · ${formatDate(operator.verifiedAt, { alwaysYear: true })}` : ""}</p>
                      )}
                      <p>
                        {operator.licensedSince
                          ? `Licensed by the Egyptian Ministry of Tourism and Antiquities since ${operator.licensedSince}. `
                          : "Licensed by the Egyptian Ministry of Tourism and Antiquities. "}
                        This is the company responsible for delivering your departure.
                      </p>
                      {/* The operator can change hands until bookings close, so say so
                          rather than let a later change read as a switch. */}
                      {dep && isBookingOpen(dep) && (
                        <p className="op-note">Until bookings close, this date is run by the partner with the most confirmed travelers on it — those who have paid their deposit — so this can change. Once bookings close, the operator is fixed.</p>
                      )}
                    </div>
                  </div></div>
                </section>
              ) : (
                // No operator named: a direct booking with no operator record
                // behind it, or catalogue_v2, which names none before GoAhead.
                // Say who, in general terms, rather than leave it silent.
                <section className="sec rv">
                  <h2>Your operator</h2>
                  <div className="op-card"><div className="op-inner">
                    <div className="op-meta">
                      <h3>Run by {UNNAMED_OPERATOR}</h3>
                      <p>An Egyptian travel company licensed by the Ministry of Tourism and Antiquities. The company running your date is confirmed to you before you travel.</p>
                    </div>
                  </div></div>
                </section>
              )}

              {tour.guide ? (
                <section className="sec rv">
                  <h2>Your guide</h2>
                  <div className="op-card"><div className="op-inner">
                    <div className="op-meta">
                      <h3>{tour.guide}</h3>
                      <p>Every Sawa departure is run by an Egyptian travel company licensed by the Ministry of Tourism and Antiquities. {operator ? "The company responsible for this departure is named above." : "The company responsible for your date is confirmed to you before you travel."}</p>
                    </div>
                    <SpaLink navigate={navigate} to="/about" className="btn plain">About Sawa<span className="chip" aria-hidden="true"><SxArrow /></span></SpaLink>
                  </div></div>
                </section>
              ) : null}

              <TourReviews productId={tour.id} />

              <section className="sec rv" style={{ borderBottom: 0, marginBottom: 0 }}>
                <h2>Good to know</h2>
                <div className="faq">
                  {[["When is the trip confirmed?", "The moment this date reaches its own GoAhead number — the count is shown on the date itself."], ["Can I pick my own date?", "Yes — use 'start your own' in the dates list. Our team gives it a quick review, it opens for other travelers to join, and nothing is charged unless it reaches GoAhead."], ["What if a date doesn't fill?", "You're never charged for a trip that doesn't run. Nothing is taken before GoAhead, so there is nothing to refund — move to another date or walk away."], ["Who will I travel with?", "A small mix of travelers pooled from operators registered with the Egyptian Ministry of Tourism & Antiquities — a shared group with one licensed guide, never a freelancer."], ["How do payments work?", "You hold a seat now — nothing is charged. Once the date is confirmed we send a secure payment link for the deposit: 10% on a day tour, 25% on a package. The balance is due before you travel."]].filter(([q]) => !(catalogueV2() && q === "Can I pick my own date?")).map(([q, a]) => (
                    <div className="q" key={q}><h4>{q}</h4><p>{a}</p></div>
                  ))}
                </div>
              </section>
            </div>

            <aside className="rail" id="book">
              <div className="book rv">
                <div className="book-in">
                  <div className="book-top">
                    {/* P1.3 — the ceiling is universal and is the promise worth
                        marketing, so it sits against the price on every tour and
                        package. The threshold beside it is per product and comes
                        from the record, never from copy: this listing may confirm
                        at more than the default. */}
                    <div className="book-price">
                      {tour.catalogue?.priceNotSet
                        ? <b className="tnum">{tour.catalogue.priceUnavailable || "Exchange rate not set"}</b>
                        : <><b className="tnum">{CURRENCY_SYMBOL}{pp}</b><span>{CURRENCY} / person</span></>}
                      {/* Phase 5: the rate card's tier prices, and the refund promise. */}
                      {(tour.catalogue?.priceSummary || tour.catalogue?.priceLine) && (
                        <span className="book-threshold">{tour.catalogue.priceSummary || tour.catalogue.priceLine}.{(tour.catalogue.priceTierCount || 0) > 1 ? " You pay the price of the group size your date has when payment is asked for; if it grows into a cheaper tier by the cut-off, the difference is refunded." : ""}</span>
                      )}
                      <span className="book-promise">Never more than {GROUP_MAX_WORD}. Ever.</span>
                      <span className="book-threshold">This date confirms at {numberWord(goAhead)} traveler{goAhead === 1 ? "" : "s"}.</span>
                    </div>
                    <div className="go-status">{reqMode
                      ? (<><span className="pill form"><span className="d" />New date</span> Your day — travelers join you</>)
                      : (<><span className={`pill${confirmed ? "" : " form"}`}><span className="d" />{confirmed ? "GoAhead" : "Forming"}</span> {confirmed ? "Confirmed — this date is running" : `${Math.max(0, goAhead - booked)} more to confirm`}</>)}</div>
                  </div>
                  {/* `dep` and not just `!reqMode`: with no date published there is
                      no capacity to report, and the figures fall to zero — which
                      rendered "0 of 4 joined · 0 seats left" beside a disabled
                      "Date full" button on a tour that had never opened a single
                      date. Sold out and never offered are opposite states and
                      were displaying identically. */}
                  {!reqMode && dep && <div className="seats-block">
                    <div className="pbar"><i data-fill={`${seatPct}%`} /></div>
                    <div className="meta"><span><b className="tnum">{booked}</b> of {goAhead} joined</span><span><b className="tnum">{Math.max(0, remaining)}</b> seats left</span></div>
                    {/* BBBB5 — only once the date is confirmed. On a forming date
                        this answers a question nobody has asked yet, and naming
                        a cancellation risk beside a progress bar invents one. */}
                    {confirmed && <p className="confirmed-note">We don&rsquo;t cancel a confirmed date for low numbers. If someone drops out, your trip still runs.</p>}
                  </div>}
                  <form onSubmit={reserve}>
                    <div className="dates">
                      <div className="lbl">{reqMode ? "Start your own date" : "Live dates for this tour"}</div>
                      {!reqMode && tour.dates.map((d) => {
                        const s = seatsTotal(d.pledges); const left = d.maxSeats - s; const on = Number(d.id) === Number(depId);
                        const ga = goAheadSeatsFor(d); const cf = isGoAheadDeparture(d);
                        return (
                          <button
                            type="button"
                            className={`date-opt${on ? " on" : ""}`}
                            key={d.id}
                            onClick={() => pickDate(d.id)}
                            disabled={left <= 0}
                            aria-pressed={on}
                            aria-label={`${formatDate(d.date, { alwaysYear: true })}${d.time ? ` at ${d.time}` : ""} — ${s} of ${ga} joined${left <= 0 ? ", full" : ""}`}
                          >
                            <div className="d-left"><b>{formatDate(d.date, { alwaysYear: true })}{d.time ? ` · ${d.time}` : ""}</b><span>{s} of {ga} joined</span></div>
                            <span className={`d-right ${cf ? "go" : "form"}`}>{catalogueV2() && d.catalogueLabel && left > 0 ? d.catalogueLabel : cf ? "GoAhead" : left > 0 ? `${Math.max(0, ga - s)} to go` : "Full"}</span>
                          </button>
                        );
                      })}

                      {/* Traveler-initiated date request (Phase A) */}
                      {reqDone ? (
                        <div className="bk-ok" style={{ marginTop: 8 }}>
                          {reqDone.unconfirmed
                            ? <>Check your email to confirm your date request for {formatDate(reqDone.date, { alwaysYear: true })}{reqDone.code ? ` (code ${reqDone.code})` : ""}. We send it to our team when you click the link; it lapses if it isn't confirmed within 24 hours. Nothing is charged now.</>
                            : <>Date request received for {formatDate(reqDone.date, { alwaysYear: true })}{reqDone.code ? ` — code ${reqDone.code}` : ""}. Our team reviews it and emails you shortly. Nothing is charged now.</>}
                        </div>
                      ) : catalogueV2() ? (
                        !tour.dates.length && <div className="note" style={{ marginTop: 8 }}>No dates are open for booking right now. New dates are added to the calendar regularly.</div>
                      ) : !reqMode ? (
                        <button type="button" className="date-opt start-own" onClick={() => { setReqMode(true); setReqErr(""); }} aria-label="Start your own date — pick any day, free to request">
                          <span className="plus" aria-hidden="true">+</span>
                          <div className="d-left">
                            <b>{tour.dates.length ? "Start your own date" : "No open dates — start your own"}</b>
                            <span>Pick any day — free to request</span>
                          </div>
                        </button>
                      ) : (
                        <div style={{ marginTop: 4 }}>
                          {opDaysLabel && (
                            <div className="note" style={{ marginBottom: 8 }}>This {isPackage(tour) ? "cruise" : "tour"} departs on <b>{opDaysLabel}</b> — the other days are closed below.</div>
                          )}
                          <RequestCalendar
                            value={reqDate}
                            operatingDays={opDays}
                            blockedDates={blockedDates}
                            minIso={reqIso(REQUEST_MIN_LEAD_DAYS)}
                            maxIso={reqIso(REQUEST_MAX_HORIZON_DAYS)}
                            monthCursor={reqMonth}
                            onCursorChange={(delta) => setReqMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
                            onPick={(d) => { setReqDate(d); setReqMatches(null); setReqErr(""); }}
                          />
                          <div className="note" style={{ marginTop: 8 }}>
                            Any open day up to {formatDate(reqIso(REQUEST_MAX_HORIZON_DAYS), { alwaysYear: true })}. Our team reviews each new date before it opens.
                          </div>
                          {reqMatches && reqMatches.length > 0 && (
                            <div style={{ marginTop: 10 }}>
                              <div className="lbl">{reqMatches.exactDay ? "This tour already has a group on that day — join it:" : "Groups already forming near that date — joining confirms a trip faster:"}</div>
                              {reqMatches.map((m) => {
                                const ms = seatsTotal(m.pledges); const mga = goAheadSeatsFor(m);
                                return (
                                  <button type="button" className="date-opt" key={m.id} onClick={() => { pickDate(m.id); setReqMode(false); setReqMatches(null); }}>
                                    <div className="d-left"><b>{formatDate(m.date, { alwaysYear: true })}{m.time ? ` · ${m.time}` : ""}</b><span>{ms} of {mga} joined</span></div>
                                    <span className="d-right form">Join this date</span>
                                  </button>
                                );
                              })}
                              {!reqMatches.exactDay && (
                                <button type="button" className="btn light full" style={{ marginTop: 6 }} disabled={reqBusy} onClick={() => submitDateRequest(true)}>
                                  {reqBusy ? "Requesting…" : "None of these work — request my date"}
                                </button>
                              )}
                            </div>
                          )}
                          <button type="button" className="req-back" onClick={() => { setReqMode(false); setReqMatches(null); setReqErr(""); }}>← Back to open dates</button>
                        </div>
                      )}
                    </div>
                    {/* Name and email were enforced only by the custom checks in reserve();
                        native required/aria-required means assistive tech announces the
                        requirement up front and the browser blocks an empty submit even if
                        the handler doesn't run. autoComplete cuts the typing on mobile. */}
                    <div className="bk">
                      {isPackage(tour) && pkgTiers.length > 0 && (
                        <div className="frow">
                          <label className="bk-field">
                            <span>Hotel tier</span>
                            <select value={tierId} onChange={(e) => setTierId(e.target.value)}>
                              {pkgTiers.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}{Number(t.perPersonSupplement) > 0 ? ` (+${CURRENCY_SYMBOL}${Number(t.perPersonSupplement)} ${CURRENCY}/person)` : ""}
                                </option>
                              ))}
                            </select>
                            {/* The cruiser never changes with the tier — the supplement is for
                                hotel nights. Said here because this is where the money decision
                                is made, and only on a package that actually has a cruise. */}
                            {hasNileCruise(tour) && <small className="bk-tier-note">{CRUISE_STANDARD_NOTE}</small>}
                          </label>
                          <label className="bk-field">
                            <span>Room</span>
                            <select value={roomingType} onChange={(e) => setRoomingType(e.target.value)}>
                              <option value="double">Double / twin (shared)</option>
                              <option value="triple">Triple (shared)</option>
                              <option value="single">
                                Single{Number(pkgTiers.find((t) => t.id === tierId)?.singleSupplement) > 0
                                  ? ` (+${CURRENCY_SYMBOL}${Number(pkgTiers.find((t) => t.id === tierId).singleSupplement)})`
                                  : ""}
                              </option>
                            </select>
                          </label>
                        </div>
                      )}
                      {/* Wrapping <label> rather than aria-label: the name stays on screen
                          once the field has content, which a placeholder does not. */}
                      <label className="bk-field">
                        <span>Lead traveler name</span>
                        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amina Hassan" required aria-required="true" autoComplete="name" />
                      </label>
                      <div className="frow">
                        <label className="bk-field">
                          <span>Email</span>
                          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" required aria-required="true" autoComplete="email" />
                        </label>
                        <label className="bk-field">
                          <span>{phoneVerification ? "Mobile" : manifestForm ? "Phone" : <>Phone <i className="opt">(optional)</i></>}</span>
                          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" autoComplete="tel" required={phoneVerification || !!manifestForm} aria-required={phoneVerification || !!manifestForm} />
                        </label>
                      </div>
                      {manifestForm && (
                        <TravelerDetailsFields value={details} onChange={setDetails} seats={nSeats} leadName={name}
                          needsNationality={tour.catalogue.needsNationality} pickupHint={tour.catalogue.pickupArea || ""} />
                      )}
                      {phoneVerification && (
                        <PhoneCodeStep
                          phone={phone}
                          confirmed={phoneConfirmed}
                          onVerified={(token, forPhone) => { setPhoneToken(token); setVerifiedPhone(forPhone); }}
                        />
                      )}
                      <label className="bk-field">
                        <span>Seats</span>
                        <input type="number" min="1" value={seats} onChange={(e) => setSeats(e.target.value)} required aria-required="true" />
                      </label>
                      {tooManyTravelers(seats) && <GroupRequestForm size={Number(seats)} product={tour} date={dep?.date} turnstileToken={turnstileToken} />}
                    </div>
                    {/* The glyph is carried by the code as well as the symbol in
                        the booking summary — the one place a visitor commits to
                        a number. "€" is unambiguous in a way "$" never was here
                        (it read as CAD, AUD or SGD to a good share of the people
                        this page is for), but a figure someone is about to owe
                        is the wrong place to economise on words. */}
                    {/* F07 — shown for a requested date too: the traveller used to
                        lose the price, deposit and cancellation terms at the
                        point of asking for a date that would carry them. */}
                    {<div className="bk-sum">
                      <div className="r"><span>{CURRENCY_SYMBOL}{quotePP} {CURRENCY} × {nSeats}</span><b>{CURRENCY_SYMBOL}{total} {CURRENCY}</b></div>
                      <div className="r key"><span>Deposit at GoAhead ({depositPct}%)</span><b>{CURRENCY_SYMBOL}{deposit} {CURRENCY}</b></div>
                      <div className="r"><span>Balance</span><b>{CURRENCY_SYMBOL}{balance} {CURRENCY}</b></div>
                      <div className="nt">All amounts in {CURRENCY_PROSE}. Nothing is charged today. Balance due {reqMode ? (reqDate ? balanceDueLabel(reqDate, tour) : "before departure") : dep ? balanceDueLabel(dep.startDate || dep.date, tour) : "before departure"}.</div>
                      {/* The deadline is the other half of the GoAhead promise:
                          the date by which this either confirms or is canceled
                          and everyone refunded. Showing it before someone
                          reserves is the point — a commitment nobody can see is
                          not one they can rely on. */}
                      {!reqMode && dep?.confirmDeadline && (
                        <div className="nt">
                          This date confirms or cancels by <b>{formatDate(dep.confirmDeadline, { alwaysYear: true })}</b> — {dep.confirmDeadlineDays} days before departure. If it hasn't reached {goAheadSeatsFor(dep)} travelers by then it's canceled and you're charged nothing.
                        </div>
                      )}
                      <PaymentTimeline />
                      <CancellationSchedule tour={tour} depositPct={depositPct} />
                    </div>}
                    <TurnstileBox siteKey={turnstileSiteKey()} onToken={setTurnstileToken} resetKey={turnstileReset} />
                    <div className="book-cta">
                      {reqMode ? (
                        <>
                          <button className="btn gold full" type="button" disabled={reqBusy || (reqMatches && reqMatches.length > 0)} onClick={() => submitDateRequest(false)}>
                            {reqBusy ? "Requesting…" : reqMatches && reqMatches.length > 0 ? "Pick an option above" : "Request this date"}
                            <span className="chip"><SxArrow /></span>
                          </button>
                          {reqErr && <div className="bk-err" role="alert">{reqErr}</div>}
                          <div className="note"><SxCheck />Free to request — nothing is charged unless it runs</div>
                        </>
                      ) : (
                        <>
                          <button className="btn gold full" type="submit" disabled={isSaving || !dep || remaining <= 0}>{isSaving ? "Holding…" : !dep ? "No open dates" : remaining <= 0 ? "Date full" : "Reserve a seat"}<span className="chip"><SxArrow /></span></button>
                          {err && <div className="bk-err" role="alert">{err}</div>}
                          {publicBooking && Number(publicBooking.departureId) === Number(dep?.id) && (
                            // Canceling a held seat is an action, not navigation, and it was an
                            // <a> with no href: unreachable by keyboard and announced to screen
                            // readers as plain text. A real <button> restores focus and Enter/Space.
                            publicBooking.unconfirmed ? (
                              <div className="bk-ok" role="status">Check your email to confirm your booking ({publicBooking.code}). It's made when you click the link we sent{publicBooking.email ? ` to ${publicBooking.email}` : ""}, and lapses after 24 hours. <button type="button" className="bk-cancel" onClick={async () => { setErr(""); const r = await onCancelPublicBooking(); if (r && !r.ok) setErr(r.error); }}>Cancel</button></div>
                            ) : <div className="bk-ok" role="status">Seat held — {publicBooking.code}. {publicBooking.depositDue ? `${CURRENCY_SYMBOL}${publicBooking.depositDue} ${CURRENCY} deposit due at GoAhead.` : ""} <button type="button" className="bk-cancel" onClick={async () => { setErr(""); const r = await onCancelPublicBooking(); if (r && !r.ok) setErr(r.error); }}>Cancel</button></div>
                          )}
                          {/* Group bookings: share the date with the rest of the group. */}
                          {publicBooking && Number(publicBooking.departureId) === Number(dep?.id) && manifestForm && publicBooking.code && !publicBooking.unconfirmed && (
                            <JoinGroupLink code={publicBooking.code} />
                          )}
                          {manifestForm && partyTokenFromUrl() && !publicBooking && (
                            <div className="note"><SxCheck />You're booking through a group link: your seats join the same group</div>
                          )}
                          <div className="note"><SxCheck />Free hold — you only pay once the date confirms</div>
                        </>
                      )}
                    </div>
                  </form>
                </div>
              </div>
              <div className="assur rv">
                <div className="a"><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" /><path d="M9 12l2 2 4-4" /></svg></span><div><b>You only pay if it runs</b><span>Nothing charged until GoAhead.</span></div></div>
                <div className="a"><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg></span><div><b>Small, real groups</b><span>Shared departures, one guide.</span></div></div>
                <div className="a"><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></svg></span><div><b>Licensed Egyptian operator</b><span>Ministry of Tourism licensed, ETAA registered.</span></div></div>
              </div>
            </aside>
          </div>

          {related.length > 0 && (
            <section className="related rv">
              <span className="eyebrow" style={{ marginBottom: 20 }}><span className="live" />Other Egypt departures</span>
              <h2 style={{ fontFamily: "'Fraunces',serif", fontWeight: 500, color: "var(--teal)", fontSize: "clamp(1.9rem,3.6vw,2.6rem)", letterSpacing: "-.02em" }}>You might also join</h2>
              <div className="rel-grid">
                {related.map((p) => {
                  const ld = openDates(p)[0] || p.dates[0]; const s = ld ? seatsTotal(ld.pledges) : 0; const ga = goAheadSeatsFor(p);
                  const cf = !!ld && isGoAheadDeparture(ld); const pr = ld ? livePriceFor({ ...p, ...ld }, s) : livePriceFor(p, ga);
                  // Was an <a> with no href and an onClick to /tour/<raw id>:
                  // not keyboard-reachable, no open-in-new-tab, invisible to
                  // crawlers, and every click paid a 301 because the id-shaped
                  // URL redirects to the slug. Now a real link straight to the
                  // canonical slug, matching the catalogue cards.
                  const href = `/${isPackage(p) ? "package" : "tour"}/${tourSlug(p)}`;
                  return (
                    <article className="rcard" key={p.id}>
                      <div className="core">
                        <div className="media"><img src={coverImage(p)} alt={p.title} />{cf ? <span className="badge go"><span className="d" />GoAhead</span> : <span className="badge form">Forming</span>}</div>
                        <div className="body"><span className="rt">{(isPackage(p) ? (p.cities || [p.city]) : [p.city]).join(" · ")}{p.duration ? ` · ${p.duration}` : ""}</span>
                          <h3>
                            <SpaLink
                              navigate={navigate}
                              to={href}
                              className="card-link"
                              label={`View ${p.title} ${isPackage(p) ? "package" : "tour"}`}
                            >
                              {p.title}
                            </SpaLink>
                          </h3>
                          <div className="foot"><span className="pr tnum">{CURRENCY_SYMBOL}{pr} <small>{CURRENCY} / person</small></span><span className="arr" aria-hidden="true"><SxArrow /></span></div></div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </main>

      <div className="mbar">
        <div className="p"><b className="tnum">{CURRENCY_SYMBOL}{pp}</b><span>{booked} of {goAhead} joined · {confirmed ? "GoAhead" : "Forming"}</span></div>
        <a className="btn gold sm" href="#book" onClick={(e) => { e.preventDefault(); document.getElementById("book")?.scrollIntoView({ behavior: "smooth" }); }}>Reserve<span className="chip"><SxArrow /></span></a>
      </div>

      <SxFooter navigate={navigate} />
    </div>
  );
}
function hasHtmlSx(s) { return s && s.replace(/<[^>]*>/g, "").trim().length > 0; }

export {
  requestedDate, PhoneCodeStep, CatalogueFacts, TourDetailV2, hasHtmlSx,
};
