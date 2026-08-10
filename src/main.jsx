import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  Clock3,
  Filter,
  Hotel,
  Mail,
  MapPin,
  MessageCircle,
  Newspaper,
  Package,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  Users,
} from "lucide-react";
import "./styles.css";
import "./redesign.css";
import { supabase, apiFetch, API_BASE } from "./supabaseClient";
import { warnOnce } from "./warn-once.js";
import { tourSlug } from "../server/slug.js";
import { toDate } from "./dates.js";
// The booking conditions, from the one place they are declared. This file used
// to carry its own `const DEFAULT_GO_AHEAD = 4`, free to drift from the server
// that enforces it and from the twenty static pages that state it.
import { DEFAULT_GO_AHEAD, MAX_GROUP_SIZE, GROUP_MAX_WORD, numberWord } from "../shared/group-size.js";
// DIR-17.1 — one owner for the support-availability string. This file held
// three of the four variants that were live, including the only one that
// contradicted the others outright ("9am - 9pm Cairo time" against "24/7").
import { INTERIM_COPY } from "../shared/site-copy.js";
const SUPPORT_AVAILABILITY = INTERIM_COPY["support-availability"];
// NN2.1 — the board rules, from the one module that declares them. This file
// used to carry hand-written copies of seatsTotal and goAheadFor with a comment
// asking the next person to keep them in sync with domain.js.
import { seatsTotal, goAheadSeatsFor } from "../shared/departure-state.js";
import { livePriceFor, priceFromTiers, clampPrice } from "../shared/pricing.js";
import { cleanRefCode } from "../shared/ref-code.js";
// Lazy-loaded so the heavy authenticated portal (admin desk + TipTap editor)
// is split out of the public bundle and never downloaded by visitors.
const LoginGate = lazy(() => import("./LoginGate").then((m) => ({ default: m.LoginGate })));
const AdminDashboard = lazy(() => import("./AdminDashboard").then((m) => ({ default: m.AdminDashboard })));
const AgencyDashboard = lazy(() => import("./AgencyDashboard").then((m) => ({ default: m.AgencyDashboard })));


// Three named traveler quotes lived here — Valencia, Munich, Abu Dhabi, each
// against a named trip in May 2026. No traveler has ever been on a Sawa
// departure: the pledges table has never held a row. They were invented to
// dress a design and there is nothing to reinstate them from, so they are gone
// rather than commented out.
//
const articles = [
  {
    title: "Why shared tours usually get canceled, and how we fix it",
    meta: "Planning guide",
    text: "A date becomes GoAhead when its minimum seats are booked, making the shared car and guide price work for everyone.",
  },
  {
    title: "Best first-time routes in Cairo, Luxor, and Aswan",
    meta: "City tips",
    text: "Start with the classics: Giza in Cairo, West Bank or East Bank in Luxor, and Philae in Aswan.",
  },
  {
    title: "Red flags: how to spot a shared tour that will not actually run",
    meta: "Traveler safety",
    text: "Look for clear pickup points, licensed guides, visible inclusions, and a published status for the date.",
  },
];

const destinationCopy = {
  Cairo: {
    tags: "Pyramids · Museums · Khan el-Khalili",
    image: "/images/cairo.jpg",
  },
  Luxor: {
    tags: "Temples · Tombs · Nile",
    image: "/images/luxor.jpg",
  },
  Aswan: {
    tags: "Islands · Nubian culture · Philae",
    image: "/images/aswan.jpg",
  },
};

const routeStops = {
  tour_cairo_pyramids: ["Cairo pickup", "Giza Plateau", "Sphinx"],
  tour_cairo_museum: ["Hotel pickup", "Egyptian Museum", "Khan el-Khalili"],
  tour_luxor_east_bank: ["Karnak", "Luxor Temple", "Nile Corniche"],
  tour_luxor_west_bank: ["Valley of the Kings", "Hatshepsut", "Colossi"],
  tour_aswan_philae: ["Aswan pickup", "High Dam", "Philae Temple"],
};

function isPackage(item) {
  return item && item.type === "package";
}

// NN2.1 kept `goAheadSeatsFor` under a local alias `goAheadFor`, because this
// file already used that name everywhere. The alias is gone: a second name for
// one function is a second thing to grep for, and `grep goAheadSeatsFor` should
// find every place the threshold is read. Same reason the `slugify` alias went.
//
// The original finding stands and is why the alias existed at all: the local
// copy read `minSeats` only, where the authority also accepts a raw `min_seats`
// row straight from the database.

function confidenceFor(seats, goAhead = DEFAULT_GO_AHEAD) {
  if (seats >= goAhead) return { label: "GoAhead confirmed", tone: "go" };
  if (seats >= goAhead - 1) return { label: "Likely to confirm", tone: "likely" };
  if (seats >= 2) return { label: "Growing group", tone: "growing" };
  return { label: "Early interest", tone: "early" };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formingLabel(city) {
  if (city.goAhead > 0) return `${pluralize(city.departures, "date")} this week · ${city.goAhead} confirmed`;
  return `${pluralize(city.departures, "date")} this week · forming`;
}

// A departure board that runs past December showed "Fri, Jan 15" next to
// "Sat, Nov 8" with nothing to say they were different years — and the same
// bare format was used for the balance-due date, which is a payment deadline.
// The year is added whenever the date is not in the current year, so the common
// case stays short and the ambiguous case can't arise.
function needsYear(date) {
  return date.getFullYear() !== new Date().getFullYear();
}

// `alwaysYear` is not just for payment deadlines: every date a traveler picks
// from carries its year too. The catalogue already runs into the following
// calendar year, and "Tue, Oct 7" beside a 2027 package is genuinely ambiguous.
function formatDate(date, { alwaysYear = false } = {}) {
  const d = toDate(date);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    weekday: "short",
    ...(alwaysYear || needsYear(d) ? { year: "numeric" } : {}),
  }).format(d);
}

function formatRange(start, end) {
  if (!end || end === start) return formatDate(start);
  const startDate = toDate(start);
  const endDate = toDate(end);
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  const monthFmt = new Intl.DateTimeFormat("en", { month: "short" });
  const dayFmt = new Intl.DateTimeFormat("en", { day: "numeric" });
  // Year goes on the end of the range, where it disambiguates both halves —
  // unless the range itself straddles New Year, when each half needs its own.
  const startYear = needsYear(startDate) && startDate.getFullYear() !== endDate.getFullYear()
    ? ` ${startDate.getFullYear()}` : "";
  const endYear = needsYear(endDate) ? ` ${endDate.getFullYear()}` : "";
  if (sameMonth) return `${monthFmt.format(startDate)} ${dayFmt.format(startDate)}–${dayFmt.format(endDate)}${endYear}`;
  return `${monthFmt.format(startDate)} ${dayFmt.format(startDate)}${startYear} – ${monthFmt.format(endDate)} ${dayFmt.format(endDate)}${endYear}`;
}




function rateFor(departure) {
  return livePriceFor(departure, seatsTotal(departure.pledges));
}

// Cover image: first uploaded tour image, else the city stock fallback.
function coverImage(product) {
  const img = (product.images || [])[0];
  if (img?.url) return img.url;
  return destinationCopy[product.city]?.image || destinationCopy.Cairo.image;
}

// A departure is full when booked seats reach its max.
function departureFull(d) {
  return seatsTotal(d.pledges) >= Number(d.maxSeats || 0);
}

// A product is fully booked when it HAS dates and every one is full or canceled.
function productFullyBooked(product) {
  const live = (product.dates || []).filter((d) => d.status !== "cancelled");
  return live.length > 0 && live.every(departureFull);
}

// Today in the visitor's own calendar, as "YYYY-MM-DD". Departure dates are
// plain calendar dates, so they compare as strings.
function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// A date that has already left. The server drops these from the anonymous
// bootstrap (see departureStarted in server/domain.js); this is the client-side
// backstop that also covers the local dev snapshot and a signed-in agency
// browsing the public catalogue. Deliberately coarser than the server rule —
// only whole days that are already behind us — so the two can never disagree
// about a departure leaving today.
function departurePast(departure, today = todayIso()) {
  const end = departure?.endDate || departure?.date;
  return typeof end === "string" && end < today;
}

// Bookable dates only (not past, not full, not canceled).
function openDates(product) {
  return (product.dates || []).filter((d) => d.status !== "cancelled" && !departureFull(d) && !departurePast(d));
}

function packagePriceFor(product, departure, seats, { roomingType = "double", tierId } = {}) {
  const base = livePriceFor(departure || product, seats);
  const tiers = product?.accommodationTiers || [];
  const tier = tiers.find((t) => t.id === tierId) || tiers[0];
  const tierSupplement = Number(tier?.perPersonSupplement || 0);
  const singleSupplement = roomingType === "single" ? Number(tier?.singleSupplement || 0) : 0;
  return Math.round(base + tierSupplement + singleSupplement);
}

function depositFor(total, percent = 10) {
  return Math.ceil(Number(total || 0) * (Number(percent || 10) / 100));
}

// Mirrors server/domain.js. Pure calendar arithmetic, done wholly in UTC: the
// previous version stepped back a LOCAL day and then read the result back with
// toISOString() (UTC), so a viewer at an offset beyond +12 — New Zealand, Fiji,
// Samoa — was shown the balance falling due a day early.
function balanceDueDate(date) {
  const departureDate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(departureDate.getTime())) return formatDate(date, { alwaysYear: true });
  departureDate.setUTCDate(departureDate.getUTCDate() - 1);
  // A payment deadline always carries its year, even for this calendar year.
  return formatDate(departureDate.toISOString().slice(0, 10), { alwaysYear: true });
}

// The sidebar used to show a deposit figure directly above an enabled "Reserve
// a seat" button, which reads as "you are about to be charged". Terms are
// explicit that the deposit only falls due once the departure reaches GoAhead
// and the booking is confirmed, so every surface that quotes a deposit shows
// this alongside it: the four steps, in order, with the charge point named.
function PaymentTimeline() {
  return (
    <ol className="pay-timeline" aria-label="When you pay">
      <li><b>Reserve</b><span>Free — no card</span></li>
      <li><b>GoAhead</b><span>Group reaches its minimum</span></li>
      <li><b>Deposit</b><span>Charged after GoAhead</span></li>
      <li><b>Balance</b><span>Due before departure</span></li>
    </ol>
  );
}

// DIR-7 — renamed from `statusFor`, which is the name shared/departure-state.js
// uses for a different thing: that returns a machine state ("open",
// "minimum_reached"), this returns a human label ("3 seats needed"). Not a
// copy — but a reader grepping the name found both, and it nearly went into
// the invariant register as a duplicated rule. A collision costs a reader
// exactly what a copy does.
function departureStatusLabel(departure) {
  const seats = seatsTotal(departure.pledges);
  const goAhead = goAheadSeatsFor(departure);
  if (departure.status === "supplier_confirmed") return "Supplier confirmed";
  if (seats >= goAhead) return "GoAhead";
  const need = goAhead - seats;
  return need === 1 ? "1 seat needed" : `${need} seats needed`;
}

// The server inlines the public catalogue into the page it renders (see
// renderPage in server/app.js), so the very first render already has data and
// there is no fetch to wait on. Read once, at module scope: it is a static
// snapshot of the response, and re-reading it later would resurrect stale data
// after the app has refreshed from the API.
//
// It is deliberately NOT deleted from window afterwards — a hydration-time
// error that remounts the app would otherwise fall back to the loading screen
// for no reason.
// Long enough to ride out a slow mobile connection, short enough that a dead
// backend doesn't read as an indefinite hang.
const BOOTSTRAP_TIMEOUT_MS = 12_000;

// The server sends every product except the current route's in card-complete
// but detail-incomplete form (sliceBootstrapForRoute), flagged detailPending.
// It normally never reaches a detail page: landing on /tour/x inlines x in
// full. It shows up in exactly one window — a client-side click from the
// catalogue to a tour before the background refresh has landed.
//
// Every detail section is guarded by `length > 0`, so a pending product would
// silently omit them and then have them appear mid-read. Standing in a
// placeholder keeps the page the right shape and says which parts are still
// coming, instead of implying the tour simply has no itinerary.
function DetailPending({ heading }) {
  return (
    <section className="sec rv" aria-busy="true">
      <h2>{heading}</h2>
      <span className="sr-only">Loading {heading.toLowerCase()}…</span>
      <div className="skel-lines" aria-hidden="true">
        <span className="skel skel-line w70" />
        <span className="skel skel-line w45" />
        <span className="skel skel-line w60" />
      </div>
    </section>
  );
}

const INLINE_BOOTSTRAP = (() => {
  try {
    const data = typeof window !== "undefined" ? window.__SAWA_BOOTSTRAP__ : null;
    // Guard the shape: a truncated or half-written payload should fall through
    // to the normal fetch rather than render an empty catalogue as if it were real.
    return data && Array.isArray(data.tourProducts) && Array.isArray(data.departures) ? data : null;
  } catch {
    return null;
  }
})();

function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [agencies, setAgencies] = useState(INLINE_BOOTSTRAP?.agencies || []);
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
  const [scheduleDate, setScheduleDate] = useState("2026-05-25");
  const [schedulePackageId, setSchedulePackageId] = useState(
    () => (INLINE_BOOTSTRAP?.tourProducts || []).find((p) => isPackage(p))?.id || ""
  );
  const [schedulePackageDate, setSchedulePackageDate] = useState("2026-06-15");
  // With an inlined payload there is nothing to wait for, so the app renders
  // content on first paint instead of gating the whole tree behind a spinner.
  const [isLoading, setIsLoading] = useState(!INLINE_BOOTSTRAP);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [publicBooking, setPublicBooking] = useState(null);
  const [authToken, setAuthToken] = useState(null); // changes when login/logout happens -> reloads data

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
        // snapshot of live data so tour pages preview. In production the live
        // API succeeds and this fallback is never used.
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
  const isConfirmed = selected ? selectedSeats >= goAheadSelected : false;

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
      const goAhead = cityDepartures.filter((departure) => seatsTotal(departure.pledges) >= goAheadSeatsFor(departure) || departure.status === "supplier_confirmed").length;
      return { name: cityName, products: cityProducts.length, departures: cityDepartures.length, seats, goAhead };
    });
  }, [cities, departures, tourProducts]);

  const selectedCityStats = useMemo(() => {
    return {
      seats: visibleDepartures.reduce((sum, departure) => sum + seatsTotal(departure.pledges), 0),
      departures: visibleDepartures.length,
      products: visibleProducts.length,
      goAhead: visibleDepartures.filter((departure) => seatsTotal(departure.pledges) >= goAheadSeatsFor(departure) || departure.status === "supplier_confirmed").length,
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
        .sort((a, b) => `${a.date}T${a.time || ""}`.localeCompare(`${b.date}T${b.time || ""}`)),
    }));
  }, [departures, visibleProducts]);

  const customerSummary = useMemo(() => {
    const goAheadDates = visibleDepartures.filter((departure) => {
      return departure.status === "supplier_confirmed" || seatsTotal(departure.pledges) >= goAheadSeatsFor(departure);
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
      const response = await apiFetch(`/departures/${selected.id}/pledges/${pledgeId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not cancel client.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
      setNotice("Client canceled from this shared group.");
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
  async function bookPublicDeparture({ departureId, customerName, customerEmail, customerPhone, seats, roomingType, accommodationTier }) {
    if (isSaving) return;
    setIsSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE}/public/departures/${departureId}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName, customerEmail, customerPhone, seats: Number(seats), roomingType, accommodationTier, refCode: getStoredRef() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not request seats.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
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
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function cancelPublicBooking() {
    if (!publicBooking) return;
    setIsSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE}/public/departures/${publicBooking.departureId}/bookings/${publicBooking.pledgeId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not cancel this booking.");
      setDepartures((current) => current.map((departure) => (departure.id === data.departure.id ? data.departure : departure)));
      setPublicBooking(null);
      setNotice("Booking canceled. Availability updated live.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  const embedPath = path.replace(/\/+$/, "");
  if (embedPath === "/embed" || embedPath === "/embed/brand" || embedPath === "/embed/sawa") {
    return <BrandEmbed />;
  }
  const embedMatch = path.match(/^\/embed\/(tour|package)\/([^/?#]+)/);
  if (embedMatch) {
    if (isLoading) return null;
    const embedType = embedMatch[1];
    const embedId = decodeURIComponent(embedMatch[2]);
    const embedProduct = customerCalendars.find((p) => p.id === embedId);
    return <EmbedWidget type={embedType} product={embedProduct} />;
  }

  const isPortalRoute = path.startsWith("/admin") || path.startsWith("/agency") || path.startsWith("/portal");

  if (loadFailed && !isLoading) {
    return <LoadErrorScreen onRetry={() => { setLoadFailed(false); setIsLoading(true); loadBootstrap(); }} />;
  }

  if (isLoading) {
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
      {({ user, agency, signOut }) => (
        <Portal
          user={user}
          agency={agency}
          signOut={signOut}
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

// ---- Authenticated portal shell: role decides which desk shows ----
function Portal({ user, agency, signOut, navigate, notice, cityStats, departures, selectedCity, setSelectedCity, selectedCityStats, agencyDeskProps, adminDeskProps }) {
  const isPlatform = user.role === "super_admin" || user.role === "ops_staff";
  const selected = agencyDeskProps.selected;

  // Platform staff get the full operations dashboard (own nav + sections).
  if (isPlatform) {
    return <AdminDashboard user={user} agency={agency} signOut={signOut} navigate={navigate} />;
  }

  // Agency users get the clean agency dashboard, reusing the existing
  // AgencyDesk (booking) and StaffPanel (team) components.
  return (
    <AgencyDashboard
      user={user}
      agency={agency}
      signOut={signOut}
      navigate={navigate}
      departures={departures}
      tourProducts={agencyDeskProps.tourProducts}
      onReload={agencyDeskProps.onReload}
      agencyDeskProps={agencyDeskProps}
      AgencyDesk={AgencyDesk}
      StaffPanel={StaffPanel}
    />
  );
}

function roleLabel(role) {
  return {
    super_admin: "Super admin",
    ops_staff: "Operations",
    agency_owner: "Agency owner",
    agency_agent: "Agent",
  }[role] || role;
}

// ---- Agency owner: manage their team ----
function StaffPanel({ agencyName, currentUserId }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("agency_agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null); // {email, tempPassword}

  async function load() {
    try {
      const res = await apiFetch("/agency/staff");
      const data = await res.json();
      if (res.ok) setStaff(data.staff || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function addStaff(e) {
    e.preventDefault();
    setBusy(true); setError(""); setCreated(null);
    try {
      const res = await apiFetch("/agency/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), fullName: fullName.trim(), role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add the team member.");
      setCreated({ email: data.staff.email, tempPassword: data.tempPassword });
      setEmail(""); setFullName(""); setRole("agency_agent");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id, status) {
    await apiFetch(`/agency/staff/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }
  async function changeRole(id, newRole) {
    await apiFetch(`/agency/staff/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    load();
  }
  async function remove(id) {
    await apiFetch(`/agency/staff/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <section className="panel team-panel" id="team">
      <div className="panel-header">
        <div><h2>Your team</h2><p>Give your colleagues their own login for {agencyName || "your agency"}.</p></div>
        <Users size={20} />
      </div>

      <form className="team-add" onSubmit={addStaff}>
        <div className="field">
          <label htmlFor="st-name">Full name</label>
          <input id="st-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Yara Mansour" />
        </div>
        <div className="field">
          <label htmlFor="st-email">Email</label>
          <input id="st-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@agency.com" />
        </div>
        <div className="field">
          <label htmlFor="st-role">Role</label>
          <select id="st-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="agency_agent">Agent — books seats</option>
            <option value="agency_owner">Owner — also manages the team</option>
          </select>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          <Plus size={17} />{busy ? "Adding…" : "Add team member"}
        </button>
      </form>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {created && (
        <div className="temp-pass" role="status">
          <strong>{created.email} can now sign in.</strong>
          <p>Share this one-time password — it won't be shown again:</p>
          <code>{created.tempPassword}</code>
          <span>They can change it after their first sign-in. (Email invites arrive in a later update.)</span>
        </div>
      )}

      <div className="team-list">
        {loading && <p className="field-hint">Loading team…</p>}
        {!loading && staff.map((m) => (
          <div className={`team-row ${m.status === "disabled" ? "is-disabled" : ""}`} key={m.id}>
            <div className="team-who">
              <strong>{m.fullName || m.email}</strong>
              <span>{m.email}</span>
            </div>
            <span className="team-role">{roleLabel(m.role)}</span>
            <span className={`team-status ${m.status}`}>{m.status === "active" ? "Active" : "Disabled"}</span>
            <div className="team-actions">
              {m.id === currentUserId ? (
                <span className="team-you">You</span>
              ) : (
                <>
                  <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} aria-label="Change role">
                    <option value="agency_agent">Agent</option>
                    <option value="agency_owner">Owner</option>
                  </select>
                  {m.status === "active"
                    ? <button className="ghost-danger" onClick={() => setStatus(m.id, "disabled")}>Disable</button>
                    : <button className="ghost" onClick={() => setStatus(m.id, "active")}>Re-enable</button>}
                  <button className="danger-icon" onClick={() => remove(m.id)} aria-label="Remove"><Trash2 size={15} /></button>
                </>
              )}
            </div>
          </div>
        ))}
        {!loading && staff.length === 0 && <p className="empty-day">No team members yet.</p>}
      </div>
    </section>
  );
}

// Which routes actually resolve to tour cards? Only these earn the catalogue
// skeleton while the bootstrap loads — everything else (legal pages, the contact
// page, a mistyped URL heading for the 404) gets a page-neutral loader.
function showsCatalogue(p) {
  const clean = (p || "/").replace(/\/+$/, "") || "/";
  return clean === "/" || clean === "/itineraries" || clean === "/tours" || clean === "/packages"
    || clean.startsWith("/tour/") || clean.startsWith("/package/");
}

function pageFromPath(p) {
  const clean = (p || "/").replace(/\/+$/, "") || "/";
  // /itineraries is the canonical catalogue URL; /tours and /packages are
  // legacy aliases the server 301s, kept here so a client-side hit still lands.
  if (clean === "/itineraries" || clean === "/tours" || clean === "/packages") return "tours";
  if (clean === "/how-it-works") return "how";
  if (clean === "/about") return "about";
  if (clean === "/contact") return "contact";
  if (clean === "/faq") return "faq";
  if (clean === "/privacy") return "privacy";
  if (clean === "/terms") return "terms";
  if (clean === "/booking" || clean.startsWith("/booking/")) return "booking";
  if (clean === "/blog") return "blog";
  if (clean.startsWith("/blog/")) return "blogpost";
  if (clean === "/") return "home";
  return "404";
}

// ============ Editorial home page (redesign), wired to live data ============
const SxArrow = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const SxLogoMark = () => (
  <svg className="mark" viewBox="0 0 100 100" aria-hidden="true">
    <circle className="ring" cx="50" cy="50" r="36" />
    <path className="s" d="M62 34 C44 34 44 50 52 50 C60 50 60 66 38 66" />
    <circle className="dot" cx="23" cy="40" r="5.5" /><circle className="dot" cx="31" cy="74" r="5.5" /><circle className="dot" cx="70" cy="62" r="5.5" />
    <circle className="go" cx="74" cy="30" r="6.5" />
  </svg>
);

// Global chrome — the editorial glass nav + footer, shared by every public page.
// Links point at the static editorial pages (served from /site) so the chrome is
// identical across the whole site. Real <a href> = full navigation out of the SPA
// back into the static pages; the SPA is only ever the tour-detail/booking body.
// Kept in step with the static pages' nav (site/*.html) — the detail page used to
// drop "The Promise", so a visitor who arrived on a tour page lost the link to
// the page that explains what they're being asked to trust.
// Plain <a> on purpose: /departures, /goahead and /destinations are static
// server pages, not SPA routes — SpaLink would client-route them into the 404.
// Mirrors the nav on the static pages; keep the two in sync.
const SX_NAV_LINKS = [["Itineraries", "/itineraries"], ["Departures", "/departures"], ["GoAhead", "/goahead"], ["How it works", "/how-it-works"], ["FAQ", "/faq"]];

// The skip link the static pages all carry. It only becomes visible on focus,
// and it targets the #main that SxChrome/TourDetailV2 put on their <main>.
function SxSkipLink() {
  return (
    <a
      className="sx-skip"
      href="#main"
      onFocus={(e) => { e.currentTarget.style.left = "12px"; }}
      onBlur={(e) => { e.currentTarget.style.left = "-999px"; }}
    >
      Skip to content
    </a>
  );
}

function SxNav({ cta = ["Find a departure", "/departures"] }) {
  const [tight, setTight] = useState(false);
  const [menu, setMenu] = useState(false);
  const overlayRef = useRef(null);
  const openBtnRef = useRef(null);
  const closeBtnRef = useRef(null);
  useEffect(() => {
    const onScroll = () => setTight(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // The overlay is always in the DOM, so a closed menu has to be taken out of
  // the tab order AND the accessibility tree — otherwise a desktop screen-reader
  // user meets a "Close menu" button and a duplicate set of nav links that are
  // nowhere on screen. CSS visibility does it everywhere; `inert` also blocks
  // find-in-page where it's supported.
  useEffect(() => {
    const ov = overlayRef.current;
    if (ov && "inert" in HTMLElement.prototype) ov.inert = !menu;
    document.body.style.overflow = menu ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menu]);
  // Focus follows the menu: into it on open, back to the hamburger on close, so
  // a keyboard user is never stranded behind an invisible layer. Escape closes.
  useEffect(() => {
    if (!menu) return;
    closeBtnRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  // Focus moves back to the hamburger BEFORE the overlay goes inert — the other
  // order leaves activeElement inside a hidden container and the next Tab
  // restarts from the top of the document.
  function closeMenu() {
    openBtnRef.current?.focus();
    setMenu(false);
  }
  return (
    <>
      <SxSkipLink />
      <div className="nav-shell">
        <nav className={`nav${tight ? " tight" : ""}`} aria-label="Primary">
          <a className="logo" href="/"><SxLogoMark /><span className="nm"><b>Sawa</b><i>Tours · Egypt</i></span></a>
          <div className="nav-links">{SX_NAV_LINKS.map(([l, to]) => <a key={to} href={to}>{l}</a>)}</div>
          <div className="nav-right">
            <a className="btn gold sm" href={cta[1]}>{cta[0]}<span className="chip"><SxArrow /></span></a>
            <button ref={openBtnRef} className="menu-btn" aria-label="Open menu" aria-expanded={menu ? "true" : "false"} onClick={() => setMenu(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
          </div>
        </nav>
      </div>
      <div ref={overlayRef} className={`overlay${menu ? " open" : ""}`}>
        <button ref={closeBtnRef} className="close" aria-label="Close menu" onClick={closeMenu}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        {/* Links navigate away, so just close — restoring focus would fight the
            page load. */}
        {SX_NAV_LINKS.map(([l, to]) => <a key={to} href={to} onClick={() => setMenu(false)}>{l}</a>)}
      </div>
    </>
  );
}

function SxFooter() {
  return (
    <div className="sfooter">
      <div className="wrap">
        <div className="fgrid">
          <div><a className="logo" href="/"><SxLogoMark /><span className="nm"><b>Sawa</b><i>Tours · Egypt</i></span></a><p className="fblurb">Shared departures, confirmed together. Sawa pools travelers across Ministry-licensed Egyptian operators so the tours you want actually run.</p></div>
          <div className="fcol"><h4>Travel</h4><a href="/itineraries">All itineraries</a><a href="/departures">Open departures</a><a href="/goahead">GoAhead departures</a><a href="/destinations">Destinations</a><a href="/how-it-works">How it works</a><a href="/trust">The GoAhead promise</a><a href="/faq">FAQ</a></div>
          <div className="fcol"><h4>Operators</h4><a href="/operators">List a tour</a><a href="/verify">List with Sawa</a><a href="/widget">Get the widget</a></div>
          <div className="fcol"><h4>Company</h4><a href="/about">About Sawa</a><a href="/contact">Support</a><a href="/privacy">Privacy Policy</a><a href="/cookies">Cookies</a><a href="/terms">Terms and Conditions</a></div>
        </div>
        <div className="fbot"><span>© 2026 Sawa Tours · Operated by Capital Travel Service · ETAA 2179</span></div>
      </div>
    </div>
  );
}

// Wraps a legacy (non-.sx) page body with the global glass nav + footer.
function SxChrome({ navigate, children }) {
  return (
    <>
      <div className="sx sx-chrome"><div className="grain" /><SxNav navigate={navigate} /></div>
      <main id="main" className="public-shell sx-shell-body">{children}</main>
      <div className="sx sx-chrome"><SxFooter navigate={navigate} /></div>
    </>
  );
}

const SxStar = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" /></svg>;
const SxCheck = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
const SxX = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6 6 18" /></svg>;

function TourDetailV2({ isSaving, navigate, onBookPublicDeparture, onCancelPublicBooking, publicBooking, tour: tourProp, allProducts = [] }) {
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
  const [depId, setDepId] = useState(lead?.id || "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
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
  const confirmed = !!dep && (dep.status === "supplier_confirmed" || booked >= goAhead);
  const depositPct = Number(dep?.depositPercent || tour.depositPercent || 10);
  const total = pp * nSeats;
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

  useEffect(() => { setDepId(lead?.id || ""); }, [lead?.id]);
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    // Scroll first: which elements count as "already on screen" depends on
    // being at the top of the new page, not wherever the previous one was left.
    window.scrollTo(0, 0);
    const stop = observeReveal(root, ".rv", { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    const t = setTimeout(() => root.querySelectorAll(".book [data-fill]").forEach((b) => { b.style.width = b.dataset.fill; }), 400);
    return () => { stop(); clearTimeout(t); };
  }, [tour.id]);

  function reserve(e) {
    e.preventDefault();
    setErr("");
    if (!dep) return setErr("Pick a departure date.");
    if (name.trim().length < 2) return setErr("Enter the lead traveler's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email.");
    if (Number(seats) > remaining) return setErr(`Only ${remaining} seat${remaining === 1 ? "" : "s"} left on this date.`);
    onBookPublicDeparture({
      departureId: dep.id, customerName: name.trim(), customerEmail: email.trim(),
      customerPhone: phone.trim(), seats: nSeats,
      // Only meaningful for packages; the server ignores them for day tours.
      ...(isPackage(tour) ? { roomingType, accommodationTier: tierId } : {}),
    });
    setName(""); setEmail(""); setPhone(""); setSeats(1);
  }

  const reqIso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

  // Operating days (0=Sun … 6=Sat): tours like Nile cruises depart only on
  // fixed weekdays. Constrained tours offer the actual eligible dates as
  // chips instead of a free calendar; the server enforces the same rule.
  const opDays = Array.isArray(tour.operatingDays) ? tour.operatingDays : [];
  const DAY_FULL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const opDaysLabel = opDays.length
    ? (opDays.length > 1
        ? `${opDays.slice(0, -1).map((d) => DAY_FULL[d]).join(", ")} and ${DAY_FULL[opDays[opDays.length - 1]]}`
        : DAY_FULL[opDays[0]])
    : "";
  const eligibleDates = useMemo(() => {
    if (!opDays.length) return [];
    const out = [];
    for (let i = 3; i <= 90 && out.length < 12; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      if (opDays.includes(d.getDay()) && !(blockedDates && blockedDates.has(iso))) out.push(iso);
    }
    return out;
  }, [tour.id, blockedDates]);

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
    setReqBusy(true);
    try {
      const response = await fetch(`${API_BASE}/public/departure-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tourProductId: tour.id, date: reqDate, customerName: name.trim(),
          customerEmail: email.trim(), customerPhone: phone.trim(), seats: nSeats, ignoreMatches,
          // The seed pledge is priced on submission, so a traveler starting
          // their own package date needs the same tier/room choice as one
          // joining an existing date — otherwise it silently seeds at the
          // cheapest tier in a shared room.
          ...(isPackage(tour) ? { roomingType, accommodationTier: tierId } : {}),
        }),
      });
      const data = await response.json();
      if (response.status === 409 && data.code === "near_matches") {
        setReqMatches(data.nearMatches || []);
        return;
      }
      if (!response.ok) throw new Error(data.error || "Could not request this date.");
      setReqDone({ code: data.booking?.bookingCode, date: reqDate });
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
            <div className="share-row">
              <button className="icon-btn" aria-label="Save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M19 14c1.5-1.5 3-3.4 3-5.5A4.5 4.5 0 0 0 12 5 4.5 4.5 0 0 0 2 8.5c0 2.1 1.5 4 3 5.5l7 7z" /></svg></button>
            </div>
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
              {itin.length > 0 && (
                <section className="sec rv">
                  <h2>Day by day</h2>
                  <div className="timeline">
                    {itin.map((d, i) => (
                      <div className={`day${i === 0 ? " go" : ""}`} key={d.day || i}>
                        <div className="line"><div className="marker">{`D${d.day || i + 1}`}</div><div className="stem" /></div>
                        <div className="content">
                          {d.city && <span className="dl">{d.city}</span>}
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
              {tour.guide ? (
                <section className="sec rv">
                  <h2>Your guide</h2>
                  <div className="op-card"><div className="op-inner">
                    <div className="op-meta">
                      <h3>{tour.guide}</h3>
                      <p>Every Sawa departure is run by an Egyptian travel company licensed by the Ministry of Tourism and Antiquities. The company responsible for this departure is named before you book.</p>
                    </div>
                    <SpaLink navigate={navigate} to="/about" className="btn plain">About Sawa<span className="chip" aria-hidden="true"><SxArrow /></span></SpaLink>
                  </div></div>
                </section>
              ) : null}

              <section className="sec rv" style={{ borderBottom: 0, marginBottom: 0 }}>
                <h2>Good to know</h2>
                <div className="faq">
                  {[["When is the trip confirmed?", "The moment this date reaches its own GoAhead number — the count is shown on the date itself."], ["Can I pick my own date?", "Yes — use 'start your own' in the dates list. Our team gives it a quick review, it opens for other travelers to join, and nothing is charged unless it reaches GoAhead."], ["What if a date doesn't fill?", "You're never charged for a trip that doesn't run. If it doesn't reach GoAhead, you're refunded in full or moved to another date."], ["Who will I travel with?", "A small mix of travelers pooled from operators registered with the Egyptian Ministry of Tourism & Antiquities — a shared group with one licensed guide, never a freelancer."], ["How do payments work?", "You hold a seat now and pay a deposit only once the date is confirmed. Funds release to the operator at GoAhead."]].map(([q, a]) => (
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
                      <b className="tnum">${pp}</b><span>USD / person</span>
                      <span className="book-promise">Never more than {GROUP_MAX_WORD}. Ever.</span>
                      <span className="book-threshold">This date confirms at {numberWord(goAhead)} traveler{goAhead === 1 ? "" : "s"}.</span>
                    </div>
                    <div className="go-status">{reqMode
                      ? (<><span className="pill form"><span className="d" />New date</span> Your day — travelers join you</>)
                      : (<><span className={`pill${confirmed ? "" : " form"}`}><span className="d" />{confirmed ? "GoAhead" : "Forming"}</span> {confirmed ? "Confirmed — this date is running" : `${Math.max(0, goAhead - booked)} more to confirm`}</>)}</div>
                  </div>
                  {!reqMode && <div className="seats-block">
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
                        const ga = goAheadSeatsFor(d); const cf = d.status === "supplier_confirmed" || s >= ga;
                        return (
                          <button
                            type="button"
                            className={`date-opt${on ? " on" : ""}`}
                            key={d.id}
                            onClick={() => setDepId(d.id)}
                            disabled={left <= 0}
                            aria-pressed={on}
                            aria-label={`${formatDate(d.date, { alwaysYear: true })}${d.time ? ` at ${d.time}` : ""} — ${s} of ${ga} joined${left <= 0 ? ", full" : ""}`}
                          >
                            <div className="d-left"><b>{formatDate(d.date, { alwaysYear: true })}{d.time ? ` · ${d.time}` : ""}</b><span>{s} of {ga} joined</span></div>
                            <span className={`d-right ${cf ? "go" : "form"}`}>{cf ? "GoAhead" : left > 0 ? `${Math.max(0, ga - s)} to go` : "Full"}</span>
                          </button>
                        );
                      })}

                      {/* Traveler-initiated date request (Phase A) */}
                      {reqDone ? (
                        <div className="bk-ok" style={{ marginTop: 8 }}>
                          Date request received for {formatDate(reqDone.date, { alwaysYear: true })}{reqDone.code ? ` — code ${reqDone.code}` : ""}. Our team reviews it and emails you shortly. Nothing is charged now.
                        </div>
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
                          {opDays.length ? (
                            <>
                              <div className="note" style={{ marginBottom: 8 }}>This {isPackage(tour) ? "cruise" : "tour"} departs on <b>{opDaysLabel}</b> — pick a departure day:</div>
                              <div className="req-days">
                                {eligibleDates.map((d) => (
                                  <button type="button" key={d} className={`req-day${reqDate === d ? " on" : ""}`} aria-pressed={reqDate === d}
                                    onClick={() => { setReqDate(d); setReqMatches(null); }}>
                                    {formatDate(d, { alwaysYear: true })}
                                  </button>
                                ))}
                              </div>
                              <div className="note" style={{ marginTop: 8 }}>Our team reviews each new date before it opens.</div>
                            </>
                          ) : (
                            <>
                              <input
                                type="date" className="req-date" value={reqDate} min={reqIso(3)} max={reqIso(90)}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setReqDate(v); setReqMatches(null);
                                  setReqErr(blockedDates && blockedDates.has(v) ? "That day isn't available operationally — please pick another date." : "");
                                }}
                                aria-label="Requested departure date"
                              />
                              <div className="note" style={{ marginTop: 8 }}>Any day from {formatDate(reqIso(3), { alwaysYear: true })} to {formatDate(reqIso(90), { alwaysYear: true })}. Our team reviews each new date before it opens.</div>
                            </>
                          )}
                          {reqMatches && reqMatches.length > 0 && (
                            <div style={{ marginTop: 10 }}>
                              <div className="lbl">Groups already forming near that date — joining confirms a trip faster:</div>
                              {reqMatches.map((m) => {
                                const ms = seatsTotal(m.pledges); const mga = goAheadSeatsFor(m);
                                return (
                                  <button type="button" className="date-opt" key={m.id} onClick={() => { setDepId(m.id); setReqMode(false); setReqMatches(null); }}>
                                    <div className="d-left"><b>{formatDate(m.date, { alwaysYear: true })}{m.time ? ` · ${m.time}` : ""}</b><span>{ms} of {mga} joined</span></div>
                                    <span className="d-right form">Join this date</span>
                                  </button>
                                );
                              })}
                              <button type="button" className="btn light full" style={{ marginTop: 6 }} disabled={reqBusy} onClick={() => submitDateRequest(true)}>
                                {reqBusy ? "Requesting…" : "None of these work — request my date"}
                              </button>
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
                                  {t.name}{Number(t.perPersonSupplement) > 0 ? ` (+$${Number(t.perPersonSupplement)} USD/person)` : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="bk-field">
                            <span>Room</span>
                            <select value={roomingType} onChange={(e) => setRoomingType(e.target.value)}>
                              <option value="double">Double / twin (shared)</option>
                              <option value="triple">Triple (shared)</option>
                              <option value="single">
                                Single{Number(pkgTiers.find((t) => t.id === tierId)?.singleSupplement) > 0
                                  ? ` (+$${Number(pkgTiers.find((t) => t.id === tierId).singleSupplement)})`
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
                          <span>Phone <i className="opt">(optional)</i></span>
                          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" autoComplete="tel" />
                        </label>
                      </div>
                      <label className="bk-field">
                        <span>Seats</span>
                        <input type="number" min="1" max={Math.max(1, remaining)} value={seats} onChange={(e) => setSeats(e.target.value)} required aria-required="true" />
                      </label>
                    </div>
                    {/* "$" on its own reads as CAD, AUD or SGD to a good share of
                        the people this page is for, so the booking summary — the
                        one place a visitor commits to a number — says USD. */}
                    {!reqMode && <div className="bk-sum">
                      <div className="r"><span>${pp} USD × {nSeats}</span><b>${total} USD</b></div>
                      <div className="r key"><span>Deposit at GoAhead ({depositPct}%)</span><b>${deposit} USD</b></div>
                      <div className="r"><span>Balance</span><b>${balance} USD</b></div>
                      <div className="nt">All amounts in US dollars (USD). Nothing is charged today. Balance due {dep ? balanceDueDate(dep.date) : "before departure"}.</div>
                      {/* The deadline is the other half of the GoAhead promise:
                          the date by which this either confirms or is canceled
                          and everyone refunded. Showing it before someone
                          reserves is the point — a commitment nobody can see is
                          not one they can rely on. */}
                      {dep?.confirmDeadline && (
                        <div className="nt">
                          This date confirms or cancels by <b>{formatDate(dep.confirmDeadline, { alwaysYear: true })}</b> — {dep.confirmDeadlineDays} days before departure. If it hasn't reached {goAheadSeatsFor(dep)} travelers by then it's canceled and you're charged nothing.
                        </div>
                      )}
                      <PaymentTimeline />
                    </div>}
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
                          <button className="btn gold full" type="submit" disabled={isSaving || !dep || remaining <= 0}>{isSaving ? "Holding…" : remaining <= 0 ? "Date full" : "Reserve a seat"}<span className="chip"><SxArrow /></span></button>
                          {err && <div className="bk-err" role="alert">{err}</div>}
                          {publicBooking && Number(publicBooking.departureId) === Number(dep?.id) && (
                            // Canceling a held seat is an action, not navigation, and it was an
                            // <a> with no href: unreachable by keyboard and announced to screen
                            // readers as plain text. A real <button> restores focus and Enter/Space.
                            <div className="bk-ok" role="status">Seat held — {publicBooking.code}. {publicBooking.depositDue ? `$${publicBooking.depositDue} USD deposit due at GoAhead.` : ""} <button type="button" className="bk-cancel" onClick={onCancelPublicBooking}>Cancel</button></div>
                          )}
                          <div className="note"><SxCheck />Free hold — you only pay once the date confirms</div>
                        </>
                      )}
                    </div>
                  </form>
                </div>
              </div>
              <div className="assur rv">
                <div className="a"><span className="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" /><path d="M9 12l2 2 4-4" /></svg></span><div><b>You only pay if it runs</b><span>Funds held until GoAhead.</span></div></div>
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
                  const cf = ld && (ld.status === "supplier_confirmed" || s >= ga); const pr = ld ? livePriceFor({ ...p, ...ld }, s) : livePriceFor(p, ga);
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
                          <div className="foot"><span className="pr tnum">${pr} <small>USD / person</small></span><span className="arr" aria-hidden="true"><SxArrow /></span></div></div>
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
        <div className="p"><b className="tnum">${pp}</b><span>{booked} of {goAhead} joined · {confirmed ? "GoAhead" : "Forming"}</span></div>
        <a className="btn gold sm" href="#book" onClick={(e) => { e.preventDefault(); document.getElementById("book")?.scrollIntoView({ behavior: "smooth" }); }}>Reserve<span className="chip"><SxArrow /></span></a>
      </div>

      <SxFooter navigate={navigate} />
    </div>
  );
}
function hasHtmlSx(s) { return s && s.replace(/<[^>]*>/g, "").trim().length > 0; }

function PublicSite({
  path,
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
    const aConfirmed = aSeats >= goAheadSeatsFor(aLead || a) ? 1 : 0;
    const bConfirmed = bSeats >= goAheadSeatsFor(bLead || b) ? 1 : 0;
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
        onBookPublicDeparture={onBookPublicDeparture}
        onCancelPublicBooking={onCancelPublicBooking}
        publicBooking={publicBooking}
        tour={routeTour || routePackage}
        allProducts={customerCalendars}
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
                {(routeStops[routeTour.id] || [routeTour.city, routeTour.title]).map((stop) => <span key={stop}>{stop}</span>)}
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
                  <p>At minimum seats we confirm the guide and vehicle and take your deposit. If it never fills, you pay nothing.</p>
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

function scrollToBooking(navigate) {
  const el = document.getElementById("live-departures");
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    navigate("/");
    window.setTimeout(() => {
      document.getElementById("live-departures")?.scrollIntoView({ behavior: "smooth" });
    }, 140);
  }
}

function SawaMark({ size = 30 }) {
  return (
    <svg className="sawa-mark" width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="12.4" stroke="currentColor" strokeWidth="1.4" opacity="0.8" />
      <path
        d="M21 11.4c0-2.3-3.2-3.1-5.4-1.9-2.1 1.1-2.1 3.7.6 4.8 3 1.2 3.4 4.1 1 5.4-2.2 1.2-5.4.3-5.4-2"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.1" cy="7.1" r="2" fill="currentColor" />
      <circle cx="24.9" cy="7.1" r="2.5" fill="#f4c95d" />
      <circle cx="7.1" cy="24.9" r="2" fill="currentColor" />
      <circle cx="24.9" cy="24.9" r="2" fill="currentColor" />
    </svg>
  );
}

function SawaWordmark() {
  return (
    <span className="sawa-wordmark">
      <strong>Sawa</strong>
      <em>Tours</em>
    </span>
  );
}

function LoadingScreen({ label = "Preparing your shared departures…" }) {
  return (
    <main className="app-loader">
      <div className="app-loader-inner">
        <div className="app-loader-mark">
          <span className="app-loader-ring" aria-hidden="true" />
          <SawaMark size={52} />
        </div>
        <SawaWordmark />
        <span className="app-loader-sub">{label}</span>
      </div>
    </main>
  );
}

// A logo on an empty page says "something is happening somewhere" and nothing
// else — after a few seconds it reads as broken. A skeleton in the shape of the
// page that is coming says how much is coming and where, and it gives the eye
// somewhere to rest. Only reached now when a page arrives without an inlined
// payload (the SPA's own client-side route changes, or a cache miss).
function CatalogueSkeleton() {
  return (
    <main className="page-wrap" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading departures…</span>
      <div className="skel-head" aria-hidden="true">
        <span className="skel skel-kicker" />
        <span className="skel skel-title" />
        <span className="skel skel-lede" />
      </div>
      <div className="skel-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="skel-card" key={i}>
            <span className="skel skel-media" />
            <span className="skel skel-line w70" />
            <span className="skel skel-line w45" />
            <span className="skel skel-bar" />
            <span className="skel skel-line w60" />
          </div>
        ))}
      </div>
    </main>
  );
}

// Terminal state for a cold load that never produced data. The previous
// behaviour was to sit on the spinner indefinitely, which gave the visitor
// nothing to do and no way to tell a slow network from an outage.
function LoadErrorScreen({ onRetry }) {
  return (
    <main className="page-wrap page-404" role="alert">
      <div>
        <SawaMark size={48} />
        <h1>We couldn't load the departures.</h1>
        <p>
          This is usually a connection blip rather than a problem with your booking.
          Nothing you've done has been lost — no seat is held and nothing is charged.
        </p>
        <div className="page-404-actions">
          <button type="button" className="btn-pill primary" onClick={onRetry}>
            Try again
          </button>
          <a className="btn-pill" href="/contact">Contact us</a>
        </div>
      </div>
    </main>
  );
}

// Canonical public site — embed links always point here, wherever the widget
// is hosted.
const SITE_URL = "https://sawa.tours";

// ---- Scroll reveal ------------------------------------------------------
// One implementation for both observers in this file (.rv on a tour or package
// page, .reveal on the listing) and the same rule the static pages follow in
// /assets/sawa.js: an entrance animation is for content you scroll to. Anything
// already on screen when the view renders is shown as it is, or every route
// change blanks the viewport and then slides it — which on a phone is the whole
// screen, on every tap.
function observeReveal(root, selector, options) {
  const els = Array.from((root || document).querySelectorAll(selector));
  if (!els.length) return () => {};
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("in"));
    return () => {};
  }

  const above = [], below = [];
  els.forEach((el) => (el.getBoundingClientRect().top < window.innerHeight ? above : below).push(el));

  above.forEach((el) => {
    el.style.transition = "none";
    el.classList.add("in");
    el.querySelectorAll("[data-fill]").forEach((b) => { b.style.width = b.dataset.fill; });
  });
  // Commits the revealed state while the transition is still off; without it
  // the browser coalesces both changes and animates anyway.
  if (above.length) void document.body.offsetHeight;
  requestAnimationFrame(() => above.forEach((el) => { el.style.transition = ""; }));

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-fill]").forEach((b) => { b.style.width = b.dataset.fill; });
      io.unobserve(e.target);
    });
  }, options);
  below.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

// ---- Referral attribution (?ref=CODE) ----
const REF_KEY = "sawa_ref";
const REF_TTL = 30 * 24 * 60 * 60 * 1000; // remember the partner for 30 days
function refFromUrl() {
  try { return cleanRefCode(new URLSearchParams(window.location.search).get("ref")); } catch (e) { return ""; }
}
// On a real landing (not the embed itself): remember the partner + count one
// click-through. Stored client-side; sent with the booking later.
//
// The store is a functional cookie under site/cookies.html, so it waits for
// consent. The code is read from the URL and held in memory meanwhile: a
// visitor who lands on ?ref=… and then accepts on the banner is still
// attributed to the partner who sent them, which would not be true if the code
// were only read on the initial call.
function captureReferral() {
  const code = refFromUrl();
  if (!code) return;
  const store = () => {
    try {
      localStorage.setItem(REF_KEY, JSON.stringify({ code, ts: Date.now() }));
      const flag = `sawa_ref_hit_${code}`;
      if (!sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, "1");
        fetch(`${API_BASE}/track/referral`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }), keepalive: true,
        }).catch((e) => warnOnce("referral-beacon", "[referral] click-through not recorded —", e.message));
      }
    } catch (e) {
      // Private mode and blocked storage genuinely throw here and there is
      // nothing to do about it. AAA1.3 — but this is a PARTNER ATTRIBUTION
      // silently not happening, which is somebody's commission, so it says so
      // once rather than never.
      warnOnce("referral-store", "[referral] storage blocked — partner attribution will not persist:", e.message);
    }
  };

  const consent = window.sawaConsent;
  if (!consent) return; // no consent module loaded — treat as no consent
  consent.onChange((choice) => { if (choice.functional) store(); });
}
function getStoredRef() {
  try {
    const raw = localStorage.getItem(REF_KEY);
    if (!raw) return "";
    const { code, ts } = JSON.parse(raw);
    return code && Date.now() - ts <= REF_TTL ? code : "";
  } catch (e) { return ""; }
}
// Carry the embed's own ?ref through to the click-through link.
function withEmbedRef(url) {
  const code = refFromUrl();
  return code ? `${url}?ref=${encodeURIComponent(code)}` : url;
}

// Reports the widget's height to the host page so the iframe can auto-size.
// ---- Embed theming: let the widget take on the host site's palette ----
function parseColor(c) {
  if (!c) return null;
  let s = String(c).trim();
  let m = s.match(/^#?([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1]; }
  m = s.match(/^#?([0-9a-f]{6})$/i);
  if (m) { const h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]; }
  m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(/[ ,/]+/).map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
  return null;
}
const rgbaStr = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
const readableOn = (c) => ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6 ? "#16242a" : "#ffffff");
function applyEmbedTheme(o) {
  if (!o) return;
  const s = document.documentElement.style, set = (k, v) => v && s.setProperty(k, v);
  if (o.theme === "dark") { set("--surface", "#16191c"); set("--ink", "#f2f4f5"); set("--ink-soft", "#a9b0b4"); set("--line", "rgba(255,255,255,0.14)"); }
  const bg = parseColor(o.bg); if (bg && bg[3] !== 0) set("--surface", rgbaStr(bg, 1));
  const text = parseColor(o.text); if (text) { set("--ink", rgbaStr(text, 1)); set("--ink-soft", rgbaStr(text, 0.62)); set("--line", rgbaStr(text, 0.14)); }
  const muted = parseColor(o.muted); if (muted) set("--ink-soft", rgbaStr(muted, 1));
  const border = parseColor(o.border); if (border) set("--line", rgbaStr(border, border[3]));
  const accent = parseColor(o.accent); if (accent && accent[3] !== 0) { set("--gold", rgbaStr(accent, 1)); set("--embed-cta-text", readableOn(accent)); }
  if (o.radius) set("--embed-radius", /[a-z%]/i.test(o.radius) ? o.radius : `${o.radius}px`);
  if (o.font) { set("--font-body", o.font); set("--font-display", o.font); }
}
function embedThemeFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    return { theme: q.get("theme"), bg: q.get("bg"), text: q.get("text"), muted: q.get("muted"),
      border: q.get("border"), accent: q.get("accent"), radius: q.get("radius"), font: q.get("font") };
  } catch (e) { return {}; }
}

function useEmbedAutoResize(dep) {
  useEffect(() => {
    document.body.style.background = "transparent";
    applyEmbedTheme(embedThemeFromUrl());
    const post = () => {
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      // AAA1.3 — warn-once, not silence and not a warning per resize: this runs
      // on every ResizeObserver callback, and if it is failing the embed never
      // resizes, which the host site sees as a widget stuck at the wrong height.
      try { window.parent?.postMessage({ type: "sawa-embed-height", height }, "*"); }
      catch (e) { warnOnce("embed-height", "[embed] height not posted to host —", e.message); }
    };
    // Let the host's optional companion script send its palette to match.
    const onMsg = (e) => { if (e.data && e.data.type === "sawa-embed-theme") applyEmbedTheme(e.data); };
    window.addEventListener("message", onMsg);
    try { window.parent?.postMessage({ type: "sawa-embed-ready" }, "*"); }
    catch (e) { warnOnce("embed-ready", "[embed] ready signal not posted to host —", e.message); }
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    window.addEventListener("load", post);
    return () => { ro.disconnect(); window.removeEventListener("load", post); window.removeEventListener("message", onMsg); };
  }, [dep]);
}

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
          {product.quality ? <span className="embed-rating"><Star size={12} />{Number(product.quality).toFixed(1)}</span> : null}
          <span className="embed-facts">{facts}</span>
        </div>
        <strong className="embed-title">{product.title}</strong>
        <div className="embed-price">
          <span>from</span><b>${livePrice.toLocaleString()}</b><span>USD / person</span>
        </div>
        <p className="embed-hook">Shared price — it drops as the group grows, down to ${breakPrice.toLocaleString()} USD/person.</p>
        <span className="embed-cta">View &amp; book<ArrowRight size={16} /></span>
        <span className="embed-brand">Powered by <b>Sawa&nbsp;Tours</b></span>
      </div>
    </a>
  );
}

function SectionHeading({ kicker, title }) {
  return (
    <div className="section-heading">
      <p>{kicker}</p>
      <h2>{title}</h2>
    </div>
  );
}

// Renders trusted admin-authored HTML (TipTap output), or plain-text fallback.
// ============================================================
// PUBLIC PAGES — standalone marketing / legal / utility pages
// ============================================================

function PublicRoute({ page, path, navigate, customerCalendars, customerSummary, cityStats, selectedCity, setSelectedCity }) {
  switch (page) {
    case "tours":
      return (
        <ToursPage
          navigate={navigate}
          customerCalendars={customerCalendars}
          cityStats={cityStats}
          selectedCity={selectedCity}
          setSelectedCity={setSelectedCity}
        />
      );
    case "how": return <HowItWorksPage navigate={navigate} customerSummary={customerSummary} />;
    case "about": return <AboutPage navigate={navigate} customerSummary={customerSummary} />;
    case "contact": return <ContactPage navigate={navigate} />;
    case "faq": return <FaqPage navigate={navigate} />;
    case "privacy": return <LegalPage kind="privacy" navigate={navigate} />;
    case "terms": return <LegalPage kind="terms" navigate={navigate} />;
    case "booking": return <BookingLookupPage navigate={navigate} path={path} />;
    case "blog": return <BlogIndexPage navigate={navigate} />;
    case "blogpost": return <BlogPostPage navigate={navigate} slug={decodeURIComponent((path.match(/^\/blog\/([^/]+)/) || [])[1] || "")} />;
    default: return <NotFoundPage navigate={navigate} />;
  }
}

function PageHead({ eyebrow, title, lead }) {
  return (
    <header className="page-head reveal in">
      {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {lead && <p className="page-lead">{lead}</p>}
    </header>
  );
}

// ---- /tours : full catalog ----
function ToursPage({ navigate, customerCalendars, cityStats, selectedCity, setSelectedCity }) {
  const [view, setView] = useState("all");
  const [q, setQ] = useState("");
  const cities = ["All cities", ...cityStats.map((c) => c.name)];

  let items = customerCalendars.filter((p) => selectedCity === "All cities" || p.city === selectedCity);
  if (view === "day_tours") items = items.filter((p) => !isPackage(p));
  if (view === "packages") items = items.filter((p) => isPackage(p));
  if (q.trim()) {
    const t = q.trim().toLowerCase();
    items = items.filter((p) => `${p.title} ${p.city} ${(p.cities || []).join(" ")}`.toLowerCase().includes(t));
  }
  items = items.slice().sort((a, b) => {
    const al = a.dates[0], bl = b.dates[0];
    const as = al ? seatsTotal(al.pledges) : 0, bs = bl ? seatsTotal(bl.pledges) : 0;
    const ac = as >= goAheadSeatsFor(al || a) ? 1 : 0, bc = bs >= goAheadSeatsFor(bl || b) ? 1 : 0;
    return bc - ac || bs - as;
  });

  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Itineraries"
        title="Every Sawa itinerary, on one page."
        // The ceiling is the universal promise and is rendered from the
        // constant; the threshold is per product and is never stated here,
        // because it is not the same number on every itinerary. Each card and
        // each date carries its own.
        lead={`Every itinerary Sawa runs is operated by an Egyptian travel company licensed by the Ministry of Tourism and registered with ETAA. Open one to join a forming date or start your own. Each date shows exactly how many travelers it needs to confirm — that moment is the GoAhead — and no Sawa group ever goes above ${GROUP_MAX_WORD}. You pay nothing until your date confirms.`}
      />

      <div className="tours-toolbar reveal in">
        {/* Toggle buttons: which city is active was conveyed by colour alone,
            so a screen-reader user heard a row of city names with no way to
            tell which filter was on. aria-pressed is the state that matches a
            toggle (aria-selected belongs to tabs/options). */}
        <div className="tours-cities" role="group" aria-label="Filter tours by city">
          {cities.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={selectedCity === c}
              className={selectedCity === c ? "chip on" : "chip"}
              onClick={() => setSelectedCity(c)}
            >
              {c === "All cities" ? "All Egypt" : c}
            </button>
          ))}
        </div>
        <div className="tours-toolbar-right">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={view === "all"} className={view === "all" ? "on" : ""} onClick={() => setView("all")}>All</button>
            <button role="tab" aria-selected={view === "day_tours"} className={view === "day_tours" ? "on" : ""} onClick={() => setView("day_tours")}>Day tours</button>
            <button role="tab" aria-selected={view === "packages"} className={view === "packages" ? "on" : ""} onClick={() => setView("packages")}>Packages</button>
          </div>
          <label className="tours-search">
            <Search size={16} />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tours…" aria-label="Search tours" />
          </label>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="page-empty reveal in">
          <MapPin size={26} />
          <strong>No tours match that yet.</strong>
          <p>Try another city or clear your search.</p>
          <button className="btn-pill" onClick={() => { setView("all"); setQ(""); setSelectedCity("All cities"); }}>Clear filters</button>
        </div>
      ) : (
        <div className="departure-modules tours-grid reveal in">
          {items.map((p) => (
            isPackage(p)
              ? <PackageCard key={p.id} navigate={navigate} product={p} />
              : <TourCard key={p.id} navigate={navigate} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- /how-it-works ----
function HowItWorksPage({ navigate, customerSummary }) {
  const steps = [
    { n: "01", t: "Hold a seat, free", d: "Pick a date and reserve your spot with no card and no deposit. You're simply joining the group that's forming for that day." },
    { n: "02", t: "The group fills", d: "As more travelers book the same date, it moves toward GoAhead. The shared cost of the guide and vehicle is split across everyone, so the price stays fair." },
    { n: "03", t: "It runs — confirmed.", d: "Once the minimum number of travelers is reached, we confirm the guide and transport and take your deposit. If a date never fills, you pay nothing." },
  ];
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="How Sawa works"
        title="Your seat is free until the trip is real."
        lead="“Sawa” means together. We pool small bookings from different travelers into one shared group, so day tours and packages actually run — and you never pay for a date that isn't confirmed."
      />

      <div className="how2-steps reveal in">
        {steps.map((s) => (
          <article className="how2-step" key={s.n}>
            <span className="how2-num">{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </article>
        ))}
      </div>

      <section className="how2-goahead reveal in">
        <div className="how2-goahead-mark"><SawaMark size={64} /></div>
        <div>
          <p className="page-eyebrow">The gold dot</p>
          <h2>GoAhead means your tour is confirmed.</h2>
          <p>When a date reaches its minimum travelers, it turns GoAhead — the guide and vehicle are booked and the departure is locked in. Until then, your seat is just a free hold. No surprises, no last-minute cancellations after you've paid.</p>
        </div>
      </section>

      <section className="how2-trust reveal in">
        <div className="how2-trust-item"><Users size={20} /><div><strong>Small groups</strong><span>Shared, never crowded — a real guide, not a mega-bus.</span></div></div>
        <div className="how2-trust-item"><ShieldCheck size={20} /><div><strong>Ministry-licensed operators</strong><span>Licensed Egyptian guides and checked vehicles on every trip.</span></div></div>
        <div className="how2-trust-item"><BadgeCheck size={20} /><div><strong>No payment until confirmed</strong><span>You're only charged once the date is confirmed to run.</span></div></div>
      </section>

      <PageCTA navigate={navigate} note={`${customerSummary?.goAheadDates ?? 0} groups going ahead right now`} />
    </div>
  );
}

// ---- /about ----
function AboutPage({ navigate, customerSummary }) {
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="About Sawa"
        title="Shared departures, confirmed together."
        lead="Sawa is a Cairo-based shared-tour platform. We connect independent travelers heading the same way on the same day, so small bookings become real, confirmed group departures across Egypt."
      />

      <section className="about-lead reveal in">
        <div className="about-lead-text">
          <h2>Why we built it</h2>
          <p>Booking a day tour in Egypt usually means two bad options: pay a premium for a private car, or book a cheap group tour that quietly gets canceled when not enough people sign up. Sawa fixes the second problem. By pooling bookings from multiple agencies and travelers into one shared group, a date only needs a handful of people to be confirmed — and everyone shares a fair price.</p>
          <p>You hold your seat for free and watch the group fill in real time. The moment it reaches GoAhead, the guide and vehicle are locked in. You only pay when the trip is real.</p>
        </div>
        <aside className="about-stats">
          <div><strong>{customerSummary?.tours ?? 0}</strong><span>tours &amp; packages</span></div>
          <div><strong>{customerSummary?.goAheadDates ?? 0}</strong><span>going ahead now</span></div>
          <div><strong>3</strong><span>cities: Cairo, Luxor, Aswan</span></div>
        </aside>
      </section>

      <section className="about-pillars reveal in">
        <article><Users size={22} /><h3>Small groups</h3><p>Shared, never crowded. A proper guide and a comfortable vehicle, not a packed coach.</p></article>
        <article><ShieldCheck size={22} /><h3>Ministry-licensed operators</h3><p>Every departure runs with licensed Egyptian guides and inspected transport.</p></article>
        <article><CalendarDays size={22} /><h3>Real departures</h3><p>Dates are confirmed before you pay — what you book is what actually runs.</p></article>
      </section>

      <PageCTA navigate={navigate} />
    </div>
  );
}

// ---- /contact ----
function ContactPage({ navigate }) {
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [sent, setSent] = useState(false);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    const body = encodeURIComponent(`From: ${form.name} (${form.email})\n\n${form.message}`);
    window.location.href = `mailto:hello@sawa.tours?subject=${encodeURIComponent("Sawa enquiry")}&body=${body}`;
    setSent(true);
  };
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Talk to us"
        title={SUPPORT_AVAILABILITY}
        lead="Questions about a date, a pickup, or a private group? Message us on WhatsApp for the fastest answer, or send a note below."
      />
      <div className="contact-grid reveal in">
        <div className="contact-methods">
          <a className="contact-card" href="https://wa.me/201092847613" target="_blank" rel="noreferrer">
            <MessageCircle size={20} />
            <div><strong>WhatsApp</strong><span>+20 109 284 7613</span></div>
          </a>
          <a className="contact-card" href="mailto:hello@sawa.tours">
            <Mail size={20} />
            <div><strong>Email</strong><span>hello@sawa.tours</span></div>
          </a>
          <div className="contact-card static">
            <Clock3 size={20} />
            <div><strong>Support</strong><span>{SUPPORT_AVAILABILITY}</span></div>
          </div>
          <div className="contact-card static">
            <MapPin size={20} />
            <div><strong>Based in</strong><span>Cairo, Egypt · licensed operator</span></div>
          </div>
        </div>

        <form className="contact-form" onSubmit={submit}>
          {sent ? (
            <div className="contact-sent">
              <BadgeCheck size={28} />
              <strong>Thanks — your message is on its way.</strong>
              <p>{SUPPORT_AVAILABILITY} — for anything urgent that is the fastest route. Email replies follow as soon as we can.</p>
            </div>
          ) : (
            <>
              <label className="field"><span>Your name</span><input value={form.name} onChange={set("name")} required autoComplete="name" placeholder="Full name" /></label>
              <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set("email")} required autoComplete="email" placeholder="you@email.com" /></label>
              <label className="field"><span>Message</span><textarea value={form.message} onChange={set("message")} required rows={5} placeholder="Which tour or date are you asking about?" /></label>
              <button className="btn-pill primary" type="submit">Send message <ArrowRight size={16} /></button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

// ---- /faq ----
const FAQ_GROUPS = [
  {
    title: "Booking & payment",
    items: [
      { q: "Do I pay when I book?", a: "No. Holding a seat is completely free. You only pay a deposit once your date reaches GoAhead and is confirmed to run." },
      { q: "What happens if the tour doesn't fill?", a: "If a date never reaches the minimum number of travelers, it simply doesn't run and you're charged nothing. We'll let you know and help you move to another date." },
      { q: "How much is the deposit?", a: "It varies by tour, but it's a small percentage of the total shown clearly before you confirm. The balance is settled per the tour's terms." },
    ],
  },
  {
    title: "GoAhead & how it works",
    items: [
      { q: "What does GoAhead mean?", a: "GoAhead means a date has reached its own confirmation number, so the guide and vehicle are booked and the departure is confirmed to run." },
      { q: "Can a confirmed tour still be canceled?", a: "Once a date is GoAhead we don't cancel it for low numbers. In rare cases of safety or weather, we'll rebook or refund you." },
    ],
  },
  {
    title: "On the day",
    items: [
      { q: "Where do we meet?", a: "Each tour lists its exact meeting point and time — for example the Egyptian Museum in Tahrir for Cairo tours. You'll get the details with your confirmation." },
      { q: "Are the groups large?", a: "No. Sawa runs small shared groups with a licensed guide — enough people to make the date work, never a crowded coach." },
    ],
  },
  {
    title: "Cancellations",
    items: [
      { q: "Can I cancel my booking?", a: "Yes. Free holds can be released any time before confirmation. After GoAhead, each tour's cancellation policy applies and is shown on the tour page." },
    ],
  },
];

function FaqPage({ navigate }) {
  return (
    <div className="page-wrap">
      <PageHead eyebrow="FAQ" title="Questions, answered." lead="Everything about holding a seat, GoAhead, and what happens on the day. Still stuck? Talk to us on WhatsApp." />
      <div className="faq-groups reveal in">
        {FAQ_GROUPS.map((g) => (
          <section className="faq-group" key={g.title}>
            <h2>{g.title}</h2>
            {g.items.map((it) => (
              <details className="faq-item" key={it.q}>
                <summary><span>{it.q}</span><ChevronDown size={18} /></summary>
                <p>{it.a}</p>
              </details>
            ))}
          </section>
        ))}
      </div>
      <PageCTA navigate={navigate} />
    </div>
  );
}

// ---- /privacy and /terms ----
function LegalPage({ kind, navigate }) {
  const updated = "June 2026";
  const content = kind === "privacy" ? PRIVACY_SECTIONS : TERMS_SECTIONS;
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Service";
  return (
    <div className="page-wrap legal-wrap">
      <PageHead eyebrow="Legal" title={title} lead={`Last updated ${updated}. This is a plain-language summary of how Sawa operates — please review with your own counsel before launch.`} />
      <article className="legal-body reveal in">
        {content.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((para, i) => <p key={i}>{para}</p>)}
          </section>
        ))}
        <p className="legal-contact">Questions about this policy? Email <a href="mailto:hello@sawa.tours">hello@sawa.tours</a>.</p>
      </article>
    </div>
  );
}

const PRIVACY_SECTIONS = [
  { h: "What we collect", p: ["When you hold a seat or book a tour, we collect the details you give us — your name, email, phone number, the travelers in your party, and the tour and date you choose.", "We also collect basic technical information such as your browser type and pages visited, to keep the service running and secure."] },
  { h: "How we use it", p: ["We use your information to confirm departures, contact you about your booking, take payment when a date is confirmed, and provide support. Agencies you book through can see the booking details needed to run your tour.", "We do not sell your personal information."] },
  { h: "Who sees it", p: ["Your booking details are shared only with the operating agency and our operations team, strictly to deliver your tour. Payment is handled by our payment provider; we don't store full card details."] },
  { h: "Your choices", p: ["You can ask us to access, correct, or delete your information at any time by emailing us. You can opt out of non-essential messages while still receiving booking updates."] },
  { h: "Data retention", p: ["We keep booking records for as long as needed to provide the service and meet legal and accounting obligations, then delete or anonymise them."] },
];

const TERMS_SECTIONS = [
  { h: "The Sawa model", p: ["Sawa pools bookings from multiple travelers and agencies into shared group departures. Holding a seat is free and does not guarantee the tour will run. A departure becomes confirmed (GoAhead) only when it reaches the minimum number of travelers."] },
  { h: "Bookings & payment", p: ["You pay nothing to hold a seat. Once a date reaches GoAhead, the deposit shown at booking becomes due to confirm your place. The remaining balance is payable per the individual tour's terms.", "Prices are shown per person and may vary with group size, accommodation tier, and room type for packages."] },
  { h: "Cancellations", p: ["You may release a free hold at any time before confirmation at no cost. After a date is confirmed, the cancellation policy shown on that tour applies. Sawa and its operators may cancel for reasons of safety, weather, or force majeure, in which case we will rebook or refund you."] },
  { h: "On the day", p: ["You are responsible for arriving at the listed meeting point at the stated time. Tours depart on schedule; missed departures due to late arrival are not refundable."] },
  { h: "Operators", p: ["Tours are delivered by licensed Egyptian operators. Sawa coordinates the shared booking; the operating agency is responsible for the conduct of the tour itself."] },
  { h: "Liability", p: ["To the extent permitted by law, Sawa's liability is limited to the amount you paid for the affected booking. Please ensure you have appropriate travel insurance."] },
];

// ---- /booking : look up a booking by code ----
function BookingLookupPage({ navigate, path }) {
  const initial = decodeURIComponent((path.match(/^\/booking\/([^/]+)/) || [])[1] || "");
  const [code, setCode] = useState(initial);
  const [state, setState] = useState({ status: "idle", data: null, error: "" });

  async function lookup(e) {
    if (e) e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setState({ status: "loading", data: null, error: "" });
    try {
      const r = await fetch(`${API_BASE}/public/bookings/${encodeURIComponent(c)}`);
      if (r.status === 404) { setState({ status: "notfound", data: null, error: "" }); return; }
      if (!r.ok) throw new Error("Something went wrong. Please try again.");
      const j = await r.json();
      setState({ status: "found", data: j.booking, error: "" });
    } catch (err) {
      setState({ status: "error", data: null, error: err.message });
    }
  }

  useEffect(() => { if (initial) lookup(); /* eslint-disable-next-line */ }, []);

  const b = state.data;
  return (
    <div className="page-wrap">
      <PageHead eyebrow="Your booking" title="Check your departure." lead="Enter the booking code from your confirmation to see whether your date has reached GoAhead." />
      <form className="booking-lookup reveal in" onSubmit={lookup}>
        <label className="field">
          <span>Booking code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. SAWA-7K2QXM4T" />
        </label>
        <button className="btn-pill primary" type="submit" disabled={state.status === "loading"}>
          {state.status === "loading" ? "Checking…" : "Check status"} <Search size={16} />
        </button>
      </form>

      <div className="booking-result reveal in">
        {state.status === "notfound" && (
          <div className="page-empty"><Ticket size={26} /><strong>No booking found with that code.</strong><p>Double-check the code in your confirmation email, or contact us.</p><SpaLink navigate={navigate} to="/contact" className="btn-pill">Contact us</SpaLink></div>
        )}
        {state.status === "error" && <div className="form-error">{state.error}</div>}
        {state.status === "found" && b && (
          <article className={`booking-card ${b.confirmed ? "is-go" : ""}`}>
            <div className="booking-card-status">
              <span className={`booking-badge ${b.statusTone}`}>{b.statusLabel}</span>
              <span className="booking-code">{b.code}</span>
            </div>
            <h2>{b.tourTitle}</h2>
            <div className="booking-meta">
              <div><CalendarDays size={16} /> {b.dateLabel}</div>
              <div><Users size={16} /> {b.seats} {b.seats === 1 ? "seat" : "seats"}</div>
              {b.city && <div><MapPin size={16} /> {b.city}</div>}
            </div>
            {/* LL3 — the seat count is a live figure. On a date that is not
                running it is not information, it is an invitation to keep
                waiting, so the server decides whether it is shown at all. */}
            {b.showProgress && (
              <div className="booking-progress">
                <div className="booking-progress-row"><span>{b.seatsBooked}/{b.goAhead} seats to confirm</span><b>{b.confirmed ? "GoAhead — confirmed" : "Still forming"}</b></div>
                <i><em style={{ width: `${Math.min(100, (b.seatsBooked / Math.max(1, b.goAhead)) * 100)}%` }} /></i>
              </div>
            )}
            {/* The note comes from the server, which is the only thing that
                knows the state. It used to be chosen here from `confirmed`
                alone, which is how a cancelled date came to read "the guide and
                transport are booked". */}
            <p className="booking-note">{b.note}</p>
            {b.state === "date_cancelled" && b.routePath && (
              <SpaLink navigate={navigate} to={b.routePath} className="btn-pill primary">
                See other dates on this route <ArrowRight size={16} />
              </SpaLink>
            )}
          </article>
        )}
      </div>
    </div>
  );
}

// ---- 404 ----
function NotFoundPage({ navigate }) {
  return (
    <div className="page-wrap page-404">
      <div className="reveal in">
        <SawaMark size={56} />
        <h1>This page wandered off.</h1>
        <p>The page you're looking for doesn't exist — but plenty of tours do.</p>
        {/* These two go somewhere, so they are links, not buttons — the one
            page where a visitor is most likely to want a new tab or to check
            where a control leads before following it. */}
        <div className="page-404-actions">
          <SpaLink navigate={navigate} to="/itineraries" className="btn-pill primary">Browse itineraries <ArrowRight size={16} /></SpaLink>
          <SpaLink navigate={navigate} to="/" className="btn-pill">Back home</SpaLink>
        </div>
      </div>
    </div>
  );
}

// Shared closing call-to-action used across marketing pages.
function PageCTA({ navigate, note }) {
  return (
    <section className="page-cta reveal in">
      {note && <p className="page-cta-note"><span className="live-dot" aria-hidden="true" />{note}</p>}
      <h2>Ready when your group is.</h2>
      <p>Hold a seat for free and watch it turn GoAhead.</p>
      <button className="btn-pill primary lg" onClick={() => navigate("/itineraries")}>Browse itineraries <ArrowRight size={18} /></button>
    </section>
  );
}

// ---- Blog: SEO + GEO meta injection ----
function upsertMeta(attr, key, content) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute("content", content);
  el.setAttribute("data-blog-meta", "1");
}
function setCanonical(href) {
  if (!href) return;
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) { el = document.createElement("link"); el.setAttribute("rel", "canonical"); document.head.appendChild(el); }
  el.setAttribute("href", href);
  el.setAttribute("data-blog-meta", "1");
}
function abs(u) { return u && !u.startsWith("http") ? window.location.origin + u : u; }
function applyPostMeta(p) {
  const title = p.metaTitle || p.title;
  const desc = p.metaDescription || p.excerpt || p.tldr || "";
  const url = p.canonicalUrl || `${window.location.origin}/blog/${p.slug}`;
  const img = abs(p.ogImage || p.coverImage || "");
  document.title = `${title} — Sawa Tours`;
  upsertMeta("name", "description", desc);
  if (p.keywords?.length) upsertMeta("name", "keywords", p.keywords.join(", "));
  upsertMeta("name", "robots", p.noindex ? "noindex,nofollow" : "index,follow");
  upsertMeta("name", "author", p.author || "Sawa Tours");
  setCanonical(url);
  upsertMeta("property", "og:type", "article");
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", desc);
  upsertMeta("property", "og:url", url);
  if (img) upsertMeta("property", "og:image", img);
  upsertMeta("name", "twitter:card", img ? "summary_large_image" : "summary");
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", desc);
  if (p.geoRegion) upsertMeta("name", "geo.region", p.geoRegion);
  if (p.geoPlace) upsertMeta("name", "geo.placename", p.geoPlace);
  if (p.geoLat && p.geoLng) { upsertMeta("name", "geo.position", `${p.geoLat};${p.geoLng}`); upsertMeta("name", "ICBM", `${p.geoLat}, ${p.geoLng}`); }
  const ld = [{
    "@context": "https://schema.org", "@type": "Article", headline: title, description: desc,
    image: img ? [img] : undefined, author: { "@type": "Person", name: p.author || "Sawa Tours", description: p.authorCredentials || undefined },
    publisher: { "@type": "Organization", name: "Sawa Tours" }, datePublished: p.publishedAt || undefined, mainEntityOfPage: url,
  }];
  if (p.faq?.length) ld.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: p.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
  if (p.geoPlace && p.geoLat && p.geoLng) ld.push({ "@context": "https://schema.org", "@type": "Place", name: p.geoPlace, geo: { "@type": "GeoCoordinates", latitude: p.geoLat, longitude: p.geoLng } });
  let s = document.getElementById("blog-jsonld");
  if (!s) { s = document.createElement("script"); s.id = "blog-jsonld"; s.type = "application/ld+json"; document.head.appendChild(s); }
  s.textContent = JSON.stringify(ld);
}
function resetMeta() {
  document.title = "Sawa Tours — Shared departures, confirmed together";
  document.querySelectorAll("[data-blog-meta]").forEach((e) => e.remove());
  const s = document.getElementById("blog-jsonld");
  if (s) s.remove();
}
const blogDate = (d) => (d ? new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" }).format(toDate(d)) : "");

// ---- /blog : listing ----
function BlogIndexPage({ navigate }) {
  const [state, setState] = useState({ status: "loading", posts: [] });
  useEffect(() => {
    document.title = "Blog — Sawa Tours";
    let alive = true;
    fetch(`${API_BASE}/blog`).then((r) => (r.ok ? r.json() : Promise.reject(r))).then((j) => { if (alive) setState({ status: "done", posts: j.posts || [] }); })
      .catch(() => alive && setState({ status: "error", posts: [] }));
    return () => { alive = false; };
  }, []);
  return (
    <div className="page-wrap">
      <PageHead eyebrow="The journal" title="Notes from the Nile." lead="Guides, history, and practical tips for seeing Egypt the shared way — written by the people who run the tours." />
      {state.status === "loading" ? (
        <div className="blog-grid">{[0, 1, 2].map((i) => <div className="blog-skel" key={i} />)}</div>
      ) : state.posts.length === 0 ? (
        <div className="page-empty"><Newspaper size={26} /><strong>No articles yet.</strong><p>Check back soon for stories from across Egypt.</p></div>
      ) : (
        <div className="blog-grid reveal in">
          {state.posts.map((p) => (
            // The card was an <article> with only an onClick: not focusable, not
            // announced as interactive, invisible to crawlers, and no
            // middle-click / open-in-new-tab. The title is now a real anchor —
            // that carries the semantics — stretched over the whole card, so
            // the card-level onClick is no longer needed to keep it clickable.
            <article className="blog-card" key={p.id}>
              <div className="blog-card-media" style={p.coverImage ? { backgroundImage: `url(${p.coverImage})` } : undefined}>
                {!p.coverImage && <Newspaper size={26} />}
              </div>
              <div className="blog-card-body">
                {p.tags?.[0] && <span className="blog-card-tag">{p.tags[0]}</span>}
                <h3>
                  <CardLink navigate={navigate} to={`/blog/${p.slug}`} label={`Read: ${p.title}`}>
                    {p.title}
                  </CardLink>
                </h3>
                {p.excerpt && <p>{p.excerpt}</p>}
                <div className="blog-card-meta">{p.author || "Sawa Tours"}{p.publishedAt ? ` · ${blogDate(p.publishedAt)}` : ""}</div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- /blog/:slug : article ----
function BlogPostPage({ navigate, slug }) {
  const [state, setState] = useState({ status: "loading", post: null });
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/blog/${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "nf" : "err"))))
      .then((j) => { if (alive) { setState({ status: "done", post: j.post }); applyPostMeta(j.post); } })
      .catch(() => alive && setState({ status: "error", post: null }));
    return () => { alive = false; resetMeta(); };
  }, [slug]);

  if (state.status === "loading") return <div className="page-wrap"><div className="blog-post-skel" /></div>;
  if (state.status !== "done" || !state.post) return <NotFoundPage navigate={navigate} />;
  const p = state.post;
  const takeaways = (p.keyTakeaways || []).filter(Boolean);
  const faq = (p.faq || []).filter((f) => f.q);
  return (
    <article className="page-wrap blog-post">
      <button className="blog-back" onClick={() => navigate("/blog")}><ArrowLeft size={16} /> All articles</button>
      <header className="blog-post-head reveal in">
        {p.tags?.[0] && <span className="page-eyebrow">{p.tags[0]}</span>}
        <h1>{p.title}</h1>
        <div className="blog-post-meta">
          <span>{p.author || "Sawa Tours"}{p.authorCredentials ? ` · ${p.authorCredentials}` : ""}</span>
          {p.publishedAt && <span>{blogDate(p.publishedAt)}</span>}
          {p.geoRegion && <span><MapPin size={14} /> {p.geoRegion}</span>}
        </div>
      </header>
      {p.coverImage && <img className="blog-post-cover reveal in" src={p.coverImage} alt={p.title} />}
      {p.tldr && <div className="blog-tldr reveal in"><strong>In short</strong><p>{p.tldr}</p></div>}
      <div className="blog-post-body rich reveal in" dangerouslySetInnerHTML={{ __html: p.bodyHtml || "" }} />
      {takeaways.length > 0 && (
        <div className="blog-takeaways reveal in">
          <h2>Key takeaways</h2>
          <ul>{takeaways.map((t, i) => <li key={i}><Check size={16} /> <span>{t}</span></li>)}</ul>
        </div>
      )}
      {faq.length > 0 && (
        <section className="blog-faq reveal in">
          <h2>Frequently asked</h2>
          {faq.map((item, i) => (
            <details className="faq-item" key={i}>
              <summary><span>{item.q}</span><ChevronDown size={18} /></summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>
      )}
      <PageCTA navigate={navigate} />
    </article>
  );
}

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

// Every catalogue card used <button onClick={navigate}>, which cost three
// things a link gives for free: cmd/middle-click to open in a new tab, a
// distinguishable accessible name (screen readers heard a run of identical
// "View tour" buttons), and an href for crawlers. This renders a real anchor
// and only hijacks the plain left click, so modified clicks fall through to the
// browser. The ::after in CSS stretches the hit area over the whole card, so
// there is exactly one link per card rather than a title/CTA duplicate pair.
function SpaLink({ navigate, to, label, className, children, ...rest }) {
  return (
    <a
      // rest is spread FIRST so a caller's styling props come through, but can
      // never overwrite href/onClick and silently turn this back into a div.
      {...rest}
      className={className}
      href={to}
      aria-label={label}
      onClick={(event) => {
        // Modified and non-primary clicks are the browser's to handle: this is
        // what makes cmd-click / middle-click open a new tab as users expect.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function CardLink(props) {
  return <SpaLink {...props} className="card-link" />;
}

function TourCard({ navigate, product }) {
  const goAhead = goAheadSeatsFor(product);
  const goAheadDates = product.dates.filter((departure) => departure.status === "supplier_confirmed" || seatsTotal(departure.pledges) >= goAheadSeatsFor(departure)).length;
  const leadDate = openDates(product)[0] || product.dates[0];
  const seats = leadDate ? seatsTotal(leadDate.pledges) : 0;
  const confidence = confidenceFor(seats, goAhead);
  const stops = routeStops[product.id] || [product.city, product.title];
  const livePrice = leadDate ? livePriceFor({ ...product, ...leadDate }, seats) : livePriceFor(product, goAhead);
  const breakPrice = clampPrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
  const full = productFullyBooked(product);

  return (
    <article className={`tour-card ${full ? "is-full" : ""}`}>
      <div className="tour-card-media" style={{ backgroundImage: `url(${coverImage(product)})` }}>
        <span className="tour-card-city">{product.city}</span>
        {full
          ? <span className="tour-card-flag full">Fully booked</span>
          : seats >= goAhead && <span className="tour-card-flag go">GoAhead</span>}
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
          <span className="tour-card-price">${livePrice} USD</span>
        </div>
        <p className="tour-card-sub">{product.duration || product.vehicle} · {product.guide}</p>
        <div className="route-line">
          {stops.slice(0, 3).map((stop) => <span key={stop}>{stop}</span>)}
        </div>
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
          <span>{full ? "All dates full — check back soon" : `${pluralize(openDates(product).length, "open date")} · from $${breakPrice} USD at full group`}</span>
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
  const confidence = confidenceFor(seats, goAhead);
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
          : seats >= goAhead && <span className="tour-card-flag go">GoAhead</span>}
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
          <span className="tour-card-price">from ${livePrice} USD</span>
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
          <span><Hotel size={13} />{(product.accommodationTiers || []).length || 1} hotel tier{((product.accommodationTiers || []).length || 1) > 1 ? "s" : ""} · from ${breakPrice} USD/pp</span>
        </div>
        <span className="departure-link" aria-hidden="true">
          {full ? "Fully booked — view dates" : "View package"}
        </span>
      </div>
    </article>
  );
}

// Full tour details shown to the agency while booking, so they know exactly
// what they're selling: images, overview, what's in/out, itinerary, policies.
function AgencyTourPreview({ info, departure, isPackage: pkg }) {
  const cities = info.cities || [info.city];
  const included = info.included || [];
  const notIncluded = info.notIncluded || [];
  const itinerary = info.itinerary || [];
  const cover = coverImage(info);
  return (
    <section className="panel agency-tour" id="tour-details">
      <div className="agency-tour-head">
        <div className="agency-tour-cover" style={{ backgroundImage: `url(${cover})` }} />
        <div className="agency-tour-intro">
          <div className="agency-tour-title">
            <h2>{info.title || departure.route}</h2>
            {pkg && <span className="type-badge"><Package size={11} />Package</span>}
          </div>
          <p className="agency-tour-meta">
            <MapPin size={14} />{pkg ? cities.join(" → ") : info.city}
            {info.duration ? ` · ${info.duration}` : ""}
            {info.guide ? ` · ${info.guide}` : ""}
          </p>
          <div className="agency-tour-facts">
            <span><CalendarDays size={14} />{pkg
              ? formatRange(departure.startDate || departure.date, departure.endDate)
              : `${formatDate(departure.date)}${departure.time ? ` · ${departure.time}` : ""}`}</span>
            <span><Car size={14} />{info.vehicle || "Shared vehicle"}</span>
            {info.bookingCutoffHours != null && <span><Clock3 size={14} />Cutoff {info.bookingCutoffHours}h before</span>}
          </div>
        </div>
      </div>

      <RichBlock html={info.overviewHtml} fallback={info.description || departure.notes} />

      <div className="included-grid agency-incl">
        <div>
          <h3>What's included</h3>
          {included.length ? included.map((x) => <p key={x}><Check size={15} />{x}</p>)
            : <p className="muted-line">Not specified.</p>}
        </div>
        <div>
          <h3>Not included</h3>
          {notIncluded.length ? notIncluded.map((x) => <p key={x}><ChevronDown size={15} />{x}</p>)
            : <p className="muted-line">—</p>}
        </div>
      </div>

      {pkg && itinerary.length > 0 && (
        <div className="itinerary-block">
          <h3>Day-by-day itinerary</h3>
          <ol className="itinerary-list">
            {itinerary.map((day, i) => (
              <li key={day.day || i}>
                <div className="itinerary-day">Day {day.day || i + 1} · {day.city}</div>
                <strong>{day.title}</strong>
                {day.description && /<\w+/.test(day.description)
                  ? <div className="rich" dangerouslySetInnerHTML={{ __html: day.description }} />
                  : day.description ? <p>{day.description}</p> : null}
                <small>Meals: {day.meals || "—"}</small>
              </li>
            ))}
          </ol>
        </div>
      )}

      <TourExtras product={info} />
    </section>
  );
}

function AgencyDesk(props) {
  const {
    agencyId, agencies, cancelPledge, createDeparture, customerName, filtered, isConfirmed, isSaving, newRoute, newSeats,
    selected, selectedProduct, selectedRate, selectedSeats, goAheadSelected, roomingType, setRoomingType, tierId, setTierId,
    setAgencyId, setCustomerName, setNewRoute, setNewSeats, setQuery, setSeatCount,
    setSelectedId, seatCount, query, addPledge,
  } = props;
  const selectedIsPackage = isPackage(selected);
  const tiers = selectedProduct?.accommodationTiers || [];
  // Full tour info the agency is selling — prefer the rich product record,
  // fall back to the departure's own fields for ad-hoc pooling requests.
  const info = selectedProduct || selected;

  return (
    <>
      <section className="main-grid">
        <div className="panel board" id="departures">
          <div className="panel-header">
            <div>
              <h2>Open pooled departures</h2>
              <p>Day tours and packages. Find ones that need a few more travelers to reach the published rate.</p>
            </div>
            <div className="search-box">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search route or city" aria-label="Search departures" />
            </div>
          </div>

          <div className="toolbar">
            <button><Filter size={16} />Date</button>
            <button><ShieldCheck size={16} />Status</button>
            <button><ChevronDown size={16} />Seats needed</button>
          </div>

          <div className="departure-list">
            {filtered.map((departure) => {
              const seats = seatsTotal(departure.pledges);
              const ga = goAheadSeatsFor(departure);
              const dIsPackage = isPackage(departure);
              return (
                <button key={departure.id} className={`departure-row ${selected.id === departure.id ? "selected" : ""}`} onClick={() => setSelectedId(departure.id)}>
                  <div className="date-tile">
                    <span>{formatDate(departure.date).split(",")[0]}</span>
                    <strong>{formatDate(departure.date).split(" ")[1]}</strong>
                  </div>
                  <div className="departure-copy">
                    <div className="row-title">
                      <strong>
                        {dIsPackage && <span className="type-badge"><Package size={11} />Package</span>}
                        {departure.route}
                      </strong>
                      <span className={seats >= ga ? "status ok" : "status"}>{departureStatusLabel(departure)}</span>
                    </div>
                    <p>
                      <MapPin size={14} />
                      {dIsPackage
                        ? `${(departure.cities || [departure.city]).join(" → ")} · ${formatRange(departure.startDate || departure.date, departure.endDate)}`
                        : `${departure.city} at ${departure.time}`}
                    </p>
                    <div className="progress" aria-label={`${seats} of ${ga} seats`}>
                      <span style={{ width: `${Math.min(100, (seats / ga) * 100)}%` }} />
                    </div>
                  </div>
                  <div className="rate-block">
                    <strong>${rateFor(departure)}</strong>
                    <span>{dIsPackage ? "from /pp" : "live rate"}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="panel join-panel">
          <div className="panel-header compact">
            <div>
              <h2>Join this group</h2>
              <p>{selected.route}</p>
            </div>
            <span className={isConfirmed ? "status ok" : "status"}>{departureStatusLabel(selected)}</span>
          </div>

          <div className="capacity">
            <div><span>Committed seats</span><strong>{selectedSeats}/{selected.maxSeats}</strong></div>
            <div><span>GoAhead at</span><strong>{goAheadSelected}</strong></div>
          </div>

          <form className="join-form" onSubmit={addPledge}>
            <label>
              Seats to add
              <input type="number" min="1" max={Math.max(1, selected.maxSeats - selectedSeats)} value={seatCount} onChange={(event) => setSeatCount(event.target.value)} />
            </label>
            {selectedIsPackage && (
              <>
                <label>
                  Hotel tier
                  <select value={tierId} onChange={(event) => setTierId(event.target.value)}>
                    {tiers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.perPersonSupplement ? ` (+$${t.perPersonSupplement}/pp)` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Room type
                  <select value={roomingType} onChange={(event) => setRoomingType(event.target.value)}>
                    <option value="single">Single</option>
                    <option value="double">Double / twin</option>
                    <option value="triple">Triple</option>
                  </select>
                </label>
              </>
            )}
            <label>
              Customer reference
              <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Name, party, voucher ID" />
            </label>
            <button className="primary full" type="submit" disabled={isSaving}><Check size={18} />{isSaving ? "Saving..." : "Pledge seats"}</button>
          </form>

          <div className="rate-card" id="pricing">
            <div><span>{selectedIsPackage ? "Price per person" : "Shared live rate"}</span><strong>${selectedRate}</strong></div>
            <div><span>Break price</span><strong>${selected.breakPrice || Math.round(selected.publishedRate * 0.8)}</strong></div>
            <p>
              {selectedIsPackage
                ? `${selected.depositPercent || 20}% deposit confirms each booking. Hotel tier and single supplement are included above.`
                : selectedSeats < goAheadSelected
                  ? "GoAhead price starts when minimum seats are reached, then drops as the group grows."
                  : `Minimum seats reached. ${selected.depositPercent || 10}% deposit per reservation, balance due one day before departure.`}
            </p>
          </div>
        </aside>
      </section>

      <AgencyTourPreview info={info} departure={selected} isPackage={selectedIsPackage} />

      <section className="bottom-grid">
        <div className="panel" id="manifest">
          <div className="panel-header">
            <div><h2>Shared manifest</h2><p>One vehicle, one guide, separate agency ownership.</p></div>
            <span className="pill"><Clock3 size={15} />Cutoff {selected.cutoff}</span>
          </div>
          <div className="manifest-list">
            {selected.pledges.map((pledge, index) => (
              <div className="manifest-item" key={pledge.id || `${pledge.agency}-${index}`}>
                <span>{index + 1}</span>
                <div>
                  <strong>{pledge.agency}</strong>
                  <p>{pledge.customers}</p>
                  {selectedIsPackage && pledge.accommodationTierName && (
                    <p className="manifest-sub">{pledge.accommodationTierName} · {pledge.roomingType || "double"} room</p>
                  )}
                  {pledge.depositDue && <p>${pledge.depositDue} deposit · ${pledge.balanceDue} balance</p>}
                </div>
                <b>{pledge.seats} seat{pledge.seats > 1 ? "s" : ""}</b>
                {pledge.agencyId === agencyId && selected.status !== "supplier_confirmed" && (
                  <button className="danger-icon" onClick={() => cancelPledge(pledge.id)} aria-label={`Cancel ${pledge.customers}`}><Trash2 size={16} /></button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="panel create-panel" id="create-request">
          <div className="panel-header">
            <div><h2>Create pooling request</h2><p>Start a day-tour departure when you have a booking but not enough travelers. For multi-day packages, ask the admin to publish a date.</p></div>
            <Sparkles size={20} />
          </div>
          <form className="create-form" onSubmit={createDeparture}>
            <input value={newRoute} onChange={(event) => setNewRoute(event.target.value)} placeholder="Tour route, e.g. Cairo sunset visit" aria-label="New route" />
            <input value={newSeats} min="2" max="12" type="number" onChange={(event) => setNewSeats(event.target.value)} aria-label="Minimum seats" />
            <button className="primary" type="submit" disabled={isSaving}><Plus size={18} />{isSaving ? "Saving..." : "Publish"}</button>
          </form>
          <div className="supplier-strip">
            <span><CalendarDays size={16} />Auto cutoff</span>
            <span><Car size={16} />Vehicle match</span>
            <span><ShieldCheck size={16} />Safety check</span>
          </div>
        </div>

        <div className="panel messages" id="messages">
          <h2>Coordination</h2>
          <div className="message">
            <strong>Supplier desk</strong>
            <p>{isConfirmed ? "Minimum seats reached. Holding vehicle and guide for final confirmation." : `Need ${goAheadSelected - selectedSeats} more seat${goAheadSelected - selectedSeats > 1 ? "s" : ""} before cutoff.`}</p>
          </div>
          <div className="message muted">
            <strong>Customer promise</strong>
            <p>Agency names stay separate on vouchers. Travelers meet at shared pickup points only after confirmation.</p>
          </div>
        </div>
      </section>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
