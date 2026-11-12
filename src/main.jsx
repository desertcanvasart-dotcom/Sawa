import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./redesign.css";
import { apiFetch, API_BASE } from "./supabaseClient";
import { warnOnce } from "./warn-once.js";
import { tourSlug } from "../server/slug.js";
import { daysAhead } from "./dates.js";
// The booking conditions, from the one place they are declared. This file used
// to carry its own `const DEFAULT_GO_AHEAD = 4`, free to drift from the server
// that enforces it and from the twenty static pages that state it.
import { DEFAULT_GO_AHEAD } from "../shared/group-size.js";
// NN2.1 — the board rules, from the one module that declares them. This file
// used to carry hand-written copies of seatsTotal and goAheadFor with a comment
// asking the next person to keep them in sync with domain.js.
import { seatsTotal, goAheadSeatsFor, isGoAheadDeparture, isBookingOpen } from "../shared/departure-state.js";
import { isPackage } from "../shared/booking-policy.js";
// Lazy-loaded so the heavy authenticated portal (admin desk + TipTap editor)
// is split out of the public bundle and never downloaded by visitors.
const LoginGate = lazy(() => import("./LoginGate").then((m) => ({ default: m.LoginGate })));
const ReviewPage = lazy(() => import("./ReviewPage.jsx").then((m) => ({ default: m.ReviewPage })));
import { WaitlistOfferPage } from "./PayAtGoAheadPublic.jsx";
import { JoinGroupPage, partyTokenFromUrl } from "./GroupBooking.jsx";
import { ConfirmBookingPage } from "./BookingConfirmation.jsx";
import { deviceHint } from "./deviceHint.js";
import { INLINE_BOOTSTRAP, setCatalogueV2, setTurnstileSiteKey, catalogueV2 } from "./site-flags.js";
import { BOOTSTRAP_TIMEOUT_MS, packagePriceFor, rateFor, departurePast } from "./tour-helpers.jsx";
import { LoadingScreen, LoadErrorScreen, CatalogueSkeleton } from "./SiteChrome.jsx";
import { captureReferral, getStoredRef } from "./referral.js";
import { applyRouteHead } from "./PublicPages.jsx";
import { BrandEmbed, EmbedBook, EmbedWidget, BookingDetailsPage } from "./EmbedBook.jsx";
import { Portal } from "./Portal.jsx";
import { showsCatalogue } from "./page-paths.js";
import { PublicSite } from "./PublicSite.jsx";


function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [agencies, setAgencies] = useState(INLINE_BOOTSTRAP?.agencies || []);
  // agencyId -> { name, licensedSince, verified, verifiedAt }. Whitelisted on
  // the server by publicOperator(); the full agency rows stay staff-only.
  const [operatorsByProduct, setOperatorsByProduct] = useState(INLINE_BOOTSTRAP?.operatorsByProduct || {});
  // S04 — whether direct bookings must confirm a phone code (server/phone-verify.js).
  const [phoneVerification, setPhoneVerification] = useState(INLINE_BOOTSTRAP?.phoneVerification === true);
  const [cities, setCities] = useState(INLINE_BOOTSTRAP?.cities || []);
  const [tourProducts, setTourProducts] = useState(INLINE_BOOTSTRAP?.tourProducts || []);
  const [departures, setDepartures] = useState(INLINE_BOOTSTRAP?.departures || []);
  const [selectedCity, setSelectedCity] = useState("All cities");
  const [selectedId, setSelectedId] = useState(INLINE_BOOTSTRAP?.departures?.[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [seatCount, setSeatCount] = useState(1);
  const [customerName, setCustomerName] = useState("");
  const [roomingType, setRoomingType] = useState("double");
  const [tierId, setTierId] = useState("");
  const [newRoute, setNewRoute] = useState("");
  const [newSeats, setNewSeats] = useState(4);
  const [scheduleProductId, setScheduleProductId] = useState(
    () => (INLINE_BOOTSTRAP?.tourProducts || []).find((p) => !isPackage(p))?.id || ""
  );
  // Defaults a fortnight and a month ahead: the fixed dates that stood here
  // ("2026-05-25", "2026-06-15") had passed, so the form opened on a date the
  // server refuses.
  const [scheduleDate, setScheduleDate] = useState(() => daysAhead(14));
  const [schedulePackageId, setSchedulePackageId] = useState(
    () => (INLINE_BOOTSTRAP?.tourProducts || []).find((p) => isPackage(p))?.id || ""
  );
  const [schedulePackageDate, setSchedulePackageDate] = useState(() => daysAhead(30));
  // With an inlined payload there is nothing to wait for, so the app renders
  // content on first paint instead of gating the whole tree behind a spinner.
  const [isLoading, setIsLoading] = useState(!INLINE_BOOTSTRAP);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [publicBooking, setPublicBooking] = useState(null);
  const [authToken, setAuthToken] = useState(null); // changes when login/logout happens -> reloads data

  // E01 — after a client-side navigation, the <head> still described the page
  // the visitor LANDED on: open a tour from /itineraries and the title and
  // canonical still said /itineraries. The server's own buildHead() facts for
  // the new route are applied instead. Skipped on first render (the server
  // already rendered that head), on blog routes (they manage their own meta)
  // and in the portal.
  const headRendered = useRef(false);
  useEffect(() => {
    if (!headRendered.current) { headRendered.current = true; return undefined; }
    if (/^\/(blog|admin|agency|portal|embed)(\/|$)/.test(path)) return undefined;
    const ctl = new AbortController();
    fetch(`${API_BASE}/public/route-head?path=${encodeURIComponent(path)}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`route-head ${r.status}`))))
      .then(applyRouteHead)
      .catch((e) => { if (e.name !== "AbortError") warnOnce("route-head", "[head] couldn't update the page title —", e.message); });
    return () => ctl.abort();
  }, [path]);

  useEffect(() => {
    const handlePop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  // Cheap structural comparison. The payloads are plain JSON from one builder,
  // so key order is stable and stringify is a fair test; it runs once per
  // refresh over data the page already parsed, against a React re-render of
  // the whole catalogue, so it is the cheaper of the two by a wide margin.
  function same(prev, next) {
    if (!Array.isArray(prev) || !Array.isArray(next)) return false;
    if (prev.length !== next.length) return false;
    return JSON.stringify(prev) === JSON.stringify(next);
  }

  // Runs on mount and on every auth change. When the page arrived with an
  // inlined payload this is a background refresh — it must never put the app
  // back into a loading state, because content is already on screen.
  async function loadBootstrap() {
    // A request that HANGS is the case that used to strand the page: a rejected
    // fetch surfaced an error, but an open socket left the loader spinning with
    // no timeout and nothing for the visitor to do. Abort turns a hang into a
    // failure, which the retry screen can then act on.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
    try {
      let data;
      try {
        const response = await apiFetch(`/bootstrap`, { signal: controller.signal });
        if (!response.ok) throw new Error("api");
        data = await response.json();
      } catch (apiError) {
        // Local dev has no database, so /api/bootstrap fails — fall back to a
        // snapshot of live data so tour pages preview.
        // The checked-in snapshot exists only to make local development usable
        // without a database. In production, falling back to it after a
        // crawler-blocked /api/ request replaced current server data with an
        // older catalogue and turned valid detail URLs into soft 404s.
        if (!import.meta.env.DEV) throw apiError;
        const snap = await fetch("/_dev_bootstrap.json", { signal: controller.signal });
        if (!snap.ok) throw new Error("Could not load portal data.");
        data = await snap.json();
      }
      // Keep the state object we already have when the refresh carries the same
      // thing. The page arrives with an inlined payload and then fetches the
      // same catalogue again; replacing state unconditionally re-rendered every
      // card on the catalogue for data whose visible fields had not changed.
      setAgencies((prev) => same(prev, data.agencies) ? prev : (data.agencies || []));
      setCities((prev) => same(prev, data.cities) ? prev : (data.cities || []));
      setTourProducts((prev) => same(prev, data.tourProducts) ? prev : (data.tourProducts || []));
      setOperatorsByProduct((prev) => same(prev, data.operatorsByProduct) ? prev : (data.operatorsByProduct || {}));
      setPhoneVerification(data.phoneVerification === true);
      setCatalogueV2(data.catalogue?.enabled === true);
      setTurnstileSiteKey(data.turnstileSiteKey || null);
      setDepartures((prev) => same(prev, data.departures) ? prev : (data.departures || []));
      setSelectedId((prev) => prev || data.departures?.[0]?.id || null);
      const firstDayTour = (data.tourProducts || []).find((p) => !isPackage(p));
      const firstPackage = (data.tourProducts || []).find((p) => isPackage(p));
      setScheduleProductId((prev) => prev || firstDayTour?.id || "");
      setSchedulePackageId((prev) => prev || firstPackage?.id || "");
      setLoadFailed(false);
    } catch (error) {
      // A failed background refresh must not blank a page that is already
      // showing good data — only a cold load with nothing on screen is an error
      // the visitor needs to see and act on.
      if (tourProducts.length === 0) setLoadFailed(true);
      else setNotice(error.message);
    } finally {
      clearTimeout(timeout);
      setIsLoading(false);
    }
  }

  // Reload whenever the auth token changes (login/logout), so logged-in
  // users get their token-scoped data (own pledges visible, etc.).
  useEffect(() => {
    loadBootstrap();
  }, [authToken]);

  // Remember the referring partner on landing (skip the embed page itself —
  // that's an impression, we only count real click-throughs).
  useEffect(() => {
    if (!window.location.pathname.startsWith("/embed")) captureReferral();
  }, []);

  // Refetch the catalogue when the tab regains focus, so admin edits (new
  // dates, price or itinerary changes) appear without a manual hard refresh.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") loadBootstrap(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  function navigate(to) {
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
    // GA4 counts one page_view on load. Client-side routing never reloads, so
    // without this every tour page a visitor opens after landing goes
    // unrecorded and the whole SPA reads as a single-page session.
    if (typeof window.gtag === "function") {
      window.gtag("event", "page_view", {
        page_path: to,
        page_location: window.location.href,
      });
    }
  }

  const dayTourProducts = useMemo(() => tourProducts.filter((p) => !isPackage(p)), [tourProducts]);
  const packageProducts = useMemo(() => tourProducts.filter((p) => isPackage(p)), [tourProducts]);

  // The server already strips archived and unapproved listings from the
  // ANONYMOUS payload — but a signed-in admin gets the unfiltered one (their
  // dashboards need it), and these customer-facing pages rendered it as-is. So
  // an archived tour was invisible to every real customer yet showed up for
  // the one person checking the site: the admin who had just archived it.
  // The public rule is therefore applied here too, whoever is signed in.
  const publiclyVisible = (product) =>
    product.active !== false && (!product.status || product.status === "approved");
  const hiddenProductIds = useMemo(
    () => new Set(tourProducts.filter((p) => !publiclyVisible(p)).map((p) => p.id)),
    [tourProducts]
  );
  const visibleProducts = useMemo(() => {
    return tourProducts.filter((product) => publiclyVisible(product)
      && (selectedCity === "All cities" || product.city === selectedCity));
  }, [selectedCity, tourProducts]);

  const visibleDepartures = useMemo(() => {
    return departures.filter((departure) => !hiddenProductIds.has(departure.tourProductId)
      && (selectedCity === "All cities" || departure.city === selectedCity));
  }, [departures, hiddenProductIds, selectedCity]);

  const filtered = useMemo(() => {
    return visibleDepartures.filter((departure) => {
      const text = `${departure.route} ${departure.city} ${departure.date}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
  }, [query, visibleDepartures]);

  const selected =
    departures.find((departure) => departure.id === selectedId && (selectedCity === "All cities" || departure.city === selectedCity)) ||
    filtered[0] ||
    visibleDepartures[0] ||
    departures[0];

  const selectedProduct = selected ? tourProducts.find((p) => p.id === selected.tourProductId) : null;
  const selectedSeats = selected ? seatsTotal(selected.pledges) : 0;
  const selectedRate = useMemo(() => {
    if (!selected) return 0;
    if (isPackage(selected)) {
      const projected = Math.max(seatsTotal(selected.pledges) + Number(seatCount || 0), goAheadSeatsFor(selected));
      return packagePriceFor(selectedProduct, selected, projected, { roomingType, tierId });
    }
    return rateFor(selected);
  }, [selected, selectedProduct, seatCount, roomingType, tierId]);
  const goAheadSelected = selected ? goAheadSeatsFor(selected) : DEFAULT_GO_AHEAD;
  const isConfirmed = selected ? isGoAheadDeparture(selected) : false;

  // Reset/sync package-specific form fields when switching selection
  useEffect(() => {
    if (!selected) return;
    if (isPackage(selected) && selectedProduct?.accommodationTiers?.length) {
      if (!selectedProduct.accommodationTiers.some((t) => t.id === tierId)) {
        setTierId(selectedProduct.accommodationTiers[0].id);
      }
    }
  }, [selected, selectedProduct]);

  const cityStats = useMemo(() => {
    const names = cities.length ? cities.map((city) => city.name) : [...new Set(tourProducts.map((product) => product.city))];
    return names.map((cityName) => {
      const cityProducts = tourProducts.filter((product) => product.city === cityName);
      const cityDepartures = departures.filter((departure) => departure.city === cityName);
      const seats = cityDepartures.reduce((sum, departure) => sum + seatsTotal(departure.pledges), 0);
      const goAhead = cityDepartures.filter((departure) => isGoAheadDeparture(departure)).length;
      return { name: cityName, products: cityProducts.length, departures: cityDepartures.length, seats, goAhead };
    });
  }, [cities, departures, tourProducts]);

  const selectedCityStats = useMemo(() => {
    return {
      seats: visibleDepartures.reduce((sum, departure) => sum + seatsTotal(departure.pledges), 0),
      departures: visibleDepartures.length,
      products: visibleProducts.length,
      goAhead: visibleDepartures.filter((departure) => isGoAheadDeparture(departure)).length,
    };
  }, [visibleDepartures, visibleProducts]);

  const customerCalendars = useMemo(() => {
    return visibleProducts.map((product) => ({
      ...product,
      dates: departures
        .filter((departure) => departure.tourProductId === product.id || (!isPackage(product) && departure.route === product.title))
        // A departure that has already left is not a date anyone can join, and
        // the tour page picks tour.dates[0] as its lead — so a stale row used to
        // become the headline date on the detail page.
        .filter((departure) => !departurePast(departure))
        // F05 — nor is one past its booking cutoff: the server refuses those,
        // and the page used to offer "Reserve a seat" on them anyway.
        .filter((departure) => isBookingOpen(departure))
        .sort((a, b) => `${a.date}T${a.time || ""}`.localeCompare(`${b.date}T${b.time || ""}`)),
    }));
  }, [departures, visibleProducts]);

  const customerSummary = useMemo(() => {
    const goAheadDates = visibleDepartures.filter((departure) => {
      return isGoAheadDeparture(departure);
    }).length;
    return {
      tours: visibleProducts.length,
      dates: visibleDepartures.length,
      goAheadDates,
      pendingDates: Math.max(0, visibleDepartures.length - goAheadDates),
    };
  }, [visibleDepartures, visibleProducts]);

  // Resolve by clean SEO slug OR the raw DB id (so old /tour/<id> links still work).
  const routeTourId = decodeURIComponent(path.match(/^\/tour\/([^/]+)/)?.[1] || "");
  const routeTour = routeTourId ? customerCalendars.find((product) => !isPackage(product) && (product.id === routeTourId || tourSlug(product) === routeTourId)) : null;
  const routePackageId = decodeURIComponent(path.match(/^\/package\/([^/]+)/)?.[1] || "");
  const routePackage = routePackageId ? customerCalendars.find((product) => isPackage(product) && (product.id === routePackageId || tourSlug(product) === routePackageId)) : null;

  useEffect(() => {
    if (!dayTourProducts.length) return;
    const scoped = dayTourProducts.filter((product) => selectedCity === "All cities" || product.city === selectedCity);
    const next = scoped[0] || dayTourProducts[0];
    if (next && !scoped.some((p) => p.id === scheduleProductId)) {
      setScheduleProductId(next.id);
    }
  }, [scheduleProductId, selectedCity, dayTourProducts]);

  useEffect(() => {
    if (!packageProducts.length) return;
    if (!packageProducts.some((p) => p.id === schedulePackageId)) {
      setSchedulePackageId(packageProducts[0].id);
    }
  }, [packageProducts, schedulePackageId]);

  async function addPledge(event) {
    event.preventDefault();
    if (!selected || isSaving) return;
    setIsSaving(true);
    setNotice("");
    try {
      const body = {
        seats: Number(seatCount),
        customers: customerName.trim() || "Customer details pending",
      };
      if (isPackage(selected)) {
        body.roomingType = roomingType;
        body.accommodationTier = tierId;
      }
      const response = await apiFetch(`/departures/${selected.id}/pledges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add pledge.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
      setCustomerName("");
      setSeatCount(1);
      setNotice("Seat pledge saved.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function cancelPledge(pledgeId) {
    if (!selected) return;
    setIsSaving(true);
    setNotice("");
    try {
      // The agency cancel route: marked cancelled rather than erased, and the
      // GoAhead boundary applies (the old DELETE stopped only at
      // supplier_confirmed).
      const response = await apiFetch(`/agency/bookings/${encodeURIComponent(pledgeId)}/cancel`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not cancel client.");
      setNotice("Client canceled from this shared group.");
      await loadBootstrap();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function createDeparture(event) {
    event.preventDefault();
    if (!newRoute.trim()) return;
    setIsSaving(true);
    setNotice("");
    try {
      const response = await apiFetch(`/departures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: newRoute.trim(), minSeats: Number(newSeats) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create departure.");
      setDepartures((current) => [data.departure, ...current]);
      setSelectedId(data.departure.id);
      setNewRoute("");
      setNewSeats(4);
      setNotice("Pooling request published.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function scheduleAdminDeparture(event) {
    event.preventDefault();
    setIsSaving(true);
    setNotice("");
    try {
      const response = await apiFetch(`/admin/departures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tourProductId: scheduleProductId, date: scheduleDate }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not schedule tour date.");
      setDepartures((current) => [data.departure, ...current]);
      setSelectedId(data.departure.id);
      setNotice("Tour date published for agencies and customers.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function schedulePackageDeparture(event) {
    event.preventDefault();
    setIsSaving(true);
    setNotice("");
    try {
      const response = await apiFetch(`/admin/departures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tourProductId: schedulePackageId, startDate: schedulePackageDate }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not schedule package date.");
      setDepartures((current) => [data.departure, ...current]);
      setSelectedId(data.departure.id);
      setNotice("Package start date published.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmDeparture(departureId) {
    setIsSaving(true);
    setNotice("");
    try {
      const response = await apiFetch(`/admin/departures/${departureId}/confirm`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not confirm departure.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
      setNotice("Departure marked go-ahead for customers.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function updateProductPricing(productId, pricing) {
    setIsSaving(true);
    setNotice("");
    try {
      const response = await apiFetch(`/admin/tour-products/${productId}/pricing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricing),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update pricing.");
      setTourProducts((current) => current.map((product) => (product.id === data.product.id ? data.product : product)));
      setDepartures((current) => {
        const updates = new Map((data.departures || []).map((departure) => [departure.id, departure]));
        return current.map((departure) => updates.get(departure.id) || departure);
      });
      setNotice("Pricing ladder updated for this tour.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  // customerPhone was collected by the booking form but neither destructured
  // here nor put in the body, so every phone number travelers typed was thrown
  // away — even though the API accepts it, the column stores it, and the admin
  // bookings table has a column for it. WhatsApp is the primary contact channel
  // for these tours, so this was the operator's main way to reach a traveler.
  // Resolves to { ok: true } or { ok: false, error }. The tour page renders
  // before the shared `notice` banner, so a failure reported only there was
  // never seen — the caller shows the error itself and keeps the form (F01).
  async function bookPublicDeparture({ departureId, customerName, customerEmail, customerPhone, phoneToken, turnstileToken, seats, roomingType, accommodationTier, manifest }) {
    if (isSaving) return { ok: false, error: "" };
    setIsSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE}/public/departures/${departureId}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName, customerEmail, customerPhone, phoneToken, turnstileToken: turnstileToken || undefined, seats: Number(seats), roomingType, accommodationTier, refCode: getStoredRef(), ...(catalogueV2() && partyTokenFromUrl() ? { partyToken: partyTokenFromUrl() } : {}), ...(catalogueV2() ? { deviceHint: deviceHint() } : {}), ...(manifest || {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not request seats.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
      // Held until the traveler confirms their email (202): not a booking yet.
      if (data.confirmationRequired) {
        setPublicBooking({ departureId: data.departure.id, code: data.booking.bookingCode, seats: data.booking.seats, unconfirmed: true, email: customerEmail });
        setNotice("Check your email to confirm your booking.");
        return { ok: true };
      }
      setPublicBooking({
        departureId: data.departure.id,
        pledgeId: data.booking.id,
        code: data.booking.bookingCode,
        seats: data.booking.seats,
        customerName: data.booking.customers,
        pricePerPerson: data.booking.pricePerPerson,
        bookingTotal: data.booking.bookingTotal,
        depositDue: data.booking.depositDue,
        balanceDue: data.booking.balanceDue,
        balanceDueDate: data.booking.balanceDueDate,
        roomingType: data.booking.roomingType,
        tierName: data.booking.accommodationTierName,
      });
      setNotice("Seat request added. Price and availability updated live.");
      return { ok: true };
    } catch (error) {
      // A dropped connection surfaces as a TypeError with a browser-specific
      // message; say what it means instead.
      const message = error instanceof TypeError
        ? "We couldn't reach Sawa — check your connection and try again. Nothing was booked."
        : error.message;
      setNotice(message);
      return { ok: false, error: message };
    } finally {
      setIsSaving(false);
    }
  }

  async function cancelPublicBooking() {
    if (!publicBooking) return;
    setIsSaving(true);
    setNotice("");
    try {
      // S02 — the booking CODE is the credential, the same route the email's
      // cancel link uses. The old DELETE took only the pledge id, which the
      // public catalogue handed to every visitor, so anyone could cancel anyone.
      const response = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(publicBooking.code)}/cancel`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not cancel this booking.");
      setPublicBooking(null);
      setNotice("Booking canceled. Availability updated live.");
      await loadBootstrap();
      return { ok: true };
    } catch (error) {
      setNotice(error.message);
      return { ok: false, error: error.message };
    } finally {
      setIsSaving(false);
    }
  }

  const embedPath = path.replace(/\/+$/, "");
  if (embedPath === "/embed" || embedPath === "/embed/brand" || embedPath === "/embed/sawa") {
    return <BrandEmbed />;
  }
  // Booking inside the widget: the whole catalogue, or one tour.
  const embedBookMatch = embedPath.match(/^\/embed\/book(?:\/(tour|package)\/([^/?#]+))?$/);
  if (embedBookMatch) {
    if (isLoading) return null;
    const bookId = embedBookMatch[2] ? decodeURIComponent(embedBookMatch[2]) : null;
    return <EmbedBook products={customerCalendars} productId={bookId} phoneVerification={phoneVerification} />;
  }
  // A booking, looked up inside the widget (also reachable from its footer).
  const embedBookingMatch = embedPath.match(/^\/embed\/booking(?:\/([^/?#]+))?$/);
  if (embedBookingMatch) {
    if (isLoading) return null;
    return <EmbedBook products={customerCalendars} phoneVerification={phoneVerification} bookingCode={decodeURIComponent(embedBookingMatch[1] || "")} />;
  }
  // A friend's "Join my group" link, opened on the partner's page.
  const embedJoinMatch = embedPath.match(/^\/embed\/join\/([^/?#]+)$/);
  if (embedJoinMatch) {
    if (isLoading) return null;
    return <EmbedBook products={customerCalendars} phoneVerification={phoneVerification} joinToken={decodeURIComponent(embedJoinMatch[1])} />;
  }
  // "Confirm my booking", returned to the partner's page from the email.
  const embedConfirmMatch = embedPath.match(/^\/embed\/confirm\/([^/?#]+)$/);
  if (embedConfirmMatch) {
    if (isLoading) return null;
    return <EmbedBook products={customerCalendars} phoneVerification={phoneVerification} confirmToken={decodeURIComponent(embedConfirmMatch[1])} />;
  }
  const embedMatch = path.match(/^\/embed\/(tour|package)\/([^/?#]+)/);
  if (embedMatch) {
    if (isLoading) return null;
    const embedType = embedMatch[1];
    const embedId = decodeURIComponent(embedMatch[2]);
    const embedProduct = customerCalendars.find((p) => p.id === embedId);
    return <EmbedWidget type={embedType} product={embedProduct} />;
  }

  // Model phase 3: the private link to complete a booking's details.
  const detailsMatch = path.match(/^\/booking-details\/([^/?#]+)$/);
  if (detailsMatch) return <BookingDetailsPage token={decodeURIComponent(detailsMatch[1])} />;
  // Model phase 4: the page behind a waitlist offer.
  const waitlistMatch = path.match(/^\/waitlist\/([^/?#]+)$/);
  if (waitlistMatch && catalogueV2()) return <WaitlistOfferPage token={decodeURIComponent(waitlistMatch[1])} />;
  // The "Confirm my booking" link from the email (live).
  const confirmBookingMatch = path.match(/^\/confirm-booking\/([^/?#]+)$/);
  if (confirmBookingMatch) return <ConfirmBookingPage token={decodeURIComponent(confirmBookingMatch[1])} />;
  // A traveler's private link to review a tour they took (069).
  const reviewMatch = path.match(/^\/review\/([^/?#]+)$/);
  if (reviewMatch) return <Suspense fallback={<LoadingScreen label="Loading…" />}><ReviewPage token={decodeURIComponent(reviewMatch[1])} /></Suspense>;
  // Group bookings: the page behind a "Join my group" link.
  const joinMatch = path.match(/^\/join\/([^/?#]+)$/);
  if (joinMatch && catalogueV2()) return <JoinGroupPage token={decodeURIComponent(joinMatch[1])} />;

  const isPortalRoute = path.startsWith("/admin") || path.startsWith("/agency") || path.startsWith("/portal");
  // Editorial pages do not need the tour catalogue to load successfully.
  const isBlogRoute = /^\/blog(?:\/|$)/.test(path);

  if (loadFailed && !isLoading && !isBlogRoute) {
    return <LoadErrorScreen onRetry={() => { setLoadFailed(false); setIsLoading(true); loadBootstrap(); }} />;
  }

  if (isLoading && !isBlogRoute) {
    // The portal is a different shape entirely, so the catalogue skeleton would
    // be a lie there; it keeps the neutral loader. So does any route that isn't
    // going to render a catalogue at all — a mistyped URL used to announce
    // "Loading departures…" and paint six tour-card skeletons on its way to the
    // 404 page, promising a page that was never coming.
    if (isPortalRoute || !showsCatalogue(path)) return <LoadingScreen label="Loading…" />;
    return <CatalogueSkeleton />;
  }

  if (!isPortalRoute) {
    return (
      <PublicSite
        path={path}
        cityStats={cityStats}
        customerCalendars={customerCalendars}
        customerSummary={customerSummary}
        isSaving={isSaving}
        navigate={navigate}
        notice={notice}
        onBookPublicDeparture={bookPublicDeparture}
        onCancelPublicBooking={cancelPublicBooking}
        publicBooking={publicBooking}
        routeTour={routeTour}
        routePackage={routePackage}
        operatorsByProduct={operatorsByProduct}
        phoneVerification={phoneVerification}
        selectedCity={selectedCity}
        setSelectedCity={setSelectedCity}
        tourId={routeTourId}
        packageId={routePackageId}
      />
    );
  }

  // Authenticated portal: login required. View is driven by the user's ROLE.
  return (
    <Suspense fallback={<LoadingScreen />}>
    <LoginGate onSession={(token) => setAuthToken(token)}>
      {({ user, agency, signOut, refreshProfile }) => (
        <Portal
          user={user}
          agency={agency}
          signOut={signOut}
          refreshProfile={refreshProfile}
          navigate={navigate}
          notice={notice}
          cityStats={cityStats}
          departures={departures}
          selectedCity={selectedCity}
          setSelectedCity={setSelectedCity}
          selectedCityStats={selectedCityStats}
          agencyDeskProps={{
            cancelPledge, createDeparture, customerName, filtered, isConfirmed, isSaving,
            newRoute, newSeats, selected, selectedProduct, selectedRate, selectedSeats,
            goAheadSelected, roomingType, setRoomingType, tierId, setTierId, setCustomerName,
            setNewRoute, setNewSeats, setQuery, setSeatCount, setSelectedId, seatCount, query,
            addPledge, agencyId: agency?.id, tourProducts, onReload: loadBootstrap,
          }}
          adminDeskProps={{
            confirmDeparture, isSaving, scheduleAdminDeparture, scheduleDate, scheduleProductId,
            setScheduleDate, setScheduleProductId, schedulePackageDeparture, schedulePackageId,
            setSchedulePackageId, schedulePackageDate, setSchedulePackageDate, updateProductPricing,
            visibleDepartures,
            dayTourProducts: dayTourProducts.filter((p) => selectedCity === "All cities" || p.city === selectedCity),
            packageProducts: packageProducts.filter((p) => selectedCity === "All cities" || p.city === selectedCity),
          }}
        />
      )}
    </LoginGate>
    </Suspense>
  );
}

createRoot(document.getElementById("root")).render(<App />);
