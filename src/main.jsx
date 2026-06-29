import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  CalendarDays,
  Camera,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Filter,
  Flag,
  Globe,
  Handshake,
  Hotel,
  Mail,
  MapPin,
  Menu,
  MessageCircle,
  Newspaper,
  Package,
  Percent,
  Phone,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  Users,
  Utensils,
  X,
} from "lucide-react";
import "./styles.css";
import { supabase, apiFetch, API_BASE } from "./supabaseClient";
// Lazy-loaded so the heavy authenticated portal (admin desk + TipTap editor)
// is split out of the public bundle and never downloaded by visitors.
const LoginGate = lazy(() => import("./LoginGate").then((m) => ({ default: m.LoginGate })));
const AdminDashboard = lazy(() => import("./AdminDashboard").then((m) => ({ default: m.AdminDashboard })));
const AgencyDashboard = lazy(() => import("./AgencyDashboard").then((m) => ({ default: m.AgencyDashboard })));

const DEFAULT_GO_AHEAD = 4;

const reviews = [
  {
    name: "Marta Llorente",
    location: "Valencia, Spain",
    trip: "Cairo Pyramids · May 2026",
    text: "We joined a confirmed Cairo date instead of paying for a private car. Pickup was on time, the guide knew every corner of Giza, and the shared price stayed fair the whole way.",
  },
  {
    name: "Daniel Krüger",
    location: "Munich, Germany",
    trip: "Luxor East Bank · May 2026",
    text: "The GoAhead status made the decision easy. We knew the tour was running before we booked anything else for the day.",
  },
  {
    name: "Nora Al-Hashimi",
    location: "Abu Dhabi, UAE",
    trip: "Aswan Philae · May 2026",
    text: "Good shared transport and no confusing WhatsApp back-and-forth. The agency confirmed our seats within the hour.",
  },
];

const articles = [
  {
    title: "Why shared tours usually get cancelled, and how we fix it",
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

function goAheadFor(item) {
  return Math.max(1, Number(item?.minSeats || DEFAULT_GO_AHEAD));
}

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

function formatDate(date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(date));
}

function formatRange(start, end) {
  if (!end || end === start) return formatDate(start);
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameMonth = startDate.getMonth() === endDate.getMonth();
  const monthFmt = new Intl.DateTimeFormat("en", { month: "short" });
  const dayFmt = new Intl.DateTimeFormat("en", { day: "numeric" });
  if (sameMonth) return `${monthFmt.format(startDate)} ${dayFmt.format(startDate)}–${dayFmt.format(endDate)}`;
  return `${monthFmt.format(startDate)} ${dayFmt.format(startDate)} – ${monthFmt.format(endDate)} ${dayFmt.format(endDate)}`;
}

function seatsTotal(pledges = []) {
  return pledges.reduce((sum, pledge) => sum + Number(pledge.seats || 0), 0);
}

function safePrice(value, fallback) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

function livePriceFor(item, seats) {
  const goAhead = goAheadFor(item);
  const startPrice = safePrice(item.publishedRate, 80);
  const breakPrice = Math.min(startPrice, safePrice(item.breakPrice, Math.round(startPrice * 0.8)));
  const maxSeats = Math.max(Number(item.maxSeats || goAhead), goAhead);
  const effectiveSeats = Math.min(maxSeats, Math.max(goAhead, Number(seats || 0)));
  const steps = Math.max(1, maxSeats - goAhead);
  const progress = Math.min(1, Math.max(0, effectiveSeats - goAhead) / steps);
  return Math.round(startPrice - (startPrice - breakPrice) * progress);
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

// A product is fully booked when it HAS dates and every one is full or cancelled.
function productFullyBooked(product) {
  const live = (product.dates || []).filter((d) => d.status !== "cancelled");
  return live.length > 0 && live.every(departureFull);
}

// Bookable dates only (not full, not cancelled).
function openDates(product) {
  return (product.dates || []).filter((d) => d.status !== "cancelled" && !departureFull(d));
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

function balanceDueDate(date) {
  const departureDate = new Date(`${date}T12:00:00`);
  departureDate.setDate(departureDate.getDate() - 1);
  return formatDate(departureDate.toISOString().slice(0, 10));
}

function statusFor(departure) {
  const seats = seatsTotal(departure.pledges);
  const goAhead = goAheadFor(departure);
  if (departure.status === "supplier_confirmed") return "Supplier confirmed";
  if (seats >= goAhead) return "GoAhead";
  const need = goAhead - seats;
  return need === 1 ? "1 seat needed" : `${need} seats needed`;
}

function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [agencies, setAgencies] = useState([]);
  const [cities, setCities] = useState([]);
  const [tourProducts, setTourProducts] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [selectedCity, setSelectedCity] = useState("All cities");
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [seatCount, setSeatCount] = useState(1);
  const [customerName, setCustomerName] = useState("");
  const [roomingType, setRoomingType] = useState("double");
  const [tierId, setTierId] = useState("");
  const [newRoute, setNewRoute] = useState("");
  const [newSeats, setNewSeats] = useState(4);
  const [scheduleProductId, setScheduleProductId] = useState("");
  const [scheduleDate, setScheduleDate] = useState("2026-05-25");
  const [schedulePackageId, setSchedulePackageId] = useState("");
  const [schedulePackageDate, setSchedulePackageDate] = useState("2026-06-15");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [publicBooking, setPublicBooking] = useState(null);
  const [authToken, setAuthToken] = useState(null); // changes when login/logout happens -> reloads data

  useEffect(() => {
    const handlePop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  async function loadBootstrap() {
    try {
      const response = await apiFetch(`/bootstrap`);
      if (!response.ok) throw new Error("Could not load portal data.");
      const data = await response.json();
      setAgencies(data.agencies || []);
      setCities(data.cities || []);
      setTourProducts(data.tourProducts || []);
      setDepartures(data.departures || []);
      setSelectedId((prev) => prev || data.departures?.[0]?.id || null);
      const firstDayTour = (data.tourProducts || []).find((p) => !isPackage(p));
      const firstPackage = (data.tourProducts || []).find((p) => isPackage(p));
      setScheduleProductId((prev) => prev || firstDayTour?.id || "");
      setSchedulePackageId((prev) => prev || firstPackage?.id || "");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  // Reload whenever the auth token changes (login/logout), so logged-in
  // users get their token-scoped data (own pledges visible, etc.).
  useEffect(() => {
    loadBootstrap();
  }, [authToken]);

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
  }

  const dayTourProducts = useMemo(() => tourProducts.filter((p) => !isPackage(p)), [tourProducts]);
  const packageProducts = useMemo(() => tourProducts.filter((p) => isPackage(p)), [tourProducts]);

  const visibleProducts = useMemo(() => {
    return tourProducts.filter((product) => selectedCity === "All cities" || product.city === selectedCity);
  }, [selectedCity, tourProducts]);

  const visibleDepartures = useMemo(() => {
    return departures.filter((departure) => selectedCity === "All cities" || departure.city === selectedCity);
  }, [departures, selectedCity]);

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
      const projected = Math.max(seatsTotal(selected.pledges) + Number(seatCount || 0), goAheadFor(selected));
      return packagePriceFor(selectedProduct, selected, projected, { roomingType, tierId });
    }
    return rateFor(selected);
  }, [selected, selectedProduct, seatCount, roomingType, tierId]);
  const goAheadSelected = selected ? goAheadFor(selected) : DEFAULT_GO_AHEAD;
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
      const goAhead = cityDepartures.filter((departure) => seatsTotal(departure.pledges) >= goAheadFor(departure) || departure.status === "supplier_confirmed").length;
      return { name: cityName, products: cityProducts.length, departures: cityDepartures.length, seats, goAhead };
    });
  }, [cities, departures, tourProducts]);

  const selectedCityStats = useMemo(() => {
    return {
      seats: visibleDepartures.reduce((sum, departure) => sum + seatsTotal(departure.pledges), 0),
      departures: visibleDepartures.length,
      products: visibleProducts.length,
      goAhead: visibleDepartures.filter((departure) => seatsTotal(departure.pledges) >= goAheadFor(departure) || departure.status === "supplier_confirmed").length,
    };
  }, [visibleDepartures, visibleProducts]);

  const customerCalendars = useMemo(() => {
    return visibleProducts.map((product) => ({
      ...product,
      dates: departures
        .filter((departure) => departure.tourProductId === product.id || (!isPackage(product) && departure.route === product.title))
        .sort((a, b) => `${a.date}T${a.time || ""}`.localeCompare(`${b.date}T${b.time || ""}`)),
    }));
  }, [departures, visibleProducts]);

  const customerSummary = useMemo(() => {
    const goAheadDates = visibleDepartures.filter((departure) => {
      return departure.status === "supplier_confirmed" || seatsTotal(departure.pledges) >= goAheadFor(departure);
    }).length;
    return {
      tours: visibleProducts.length,
      dates: visibleDepartures.length,
      goAheadDates,
      pendingDates: Math.max(0, visibleDepartures.length - goAheadDates),
    };
  }, [visibleDepartures, visibleProducts]);

  const routeTourId = decodeURIComponent(path.match(/^\/tour\/([^/]+)/)?.[1] || "");
  const routeTour = routeTourId ? customerCalendars.find((product) => product.id === routeTourId && !isPackage(product)) : null;
  const routePackageId = decodeURIComponent(path.match(/^\/package\/([^/]+)/)?.[1] || "");
  const routePackage = routePackageId ? customerCalendars.find((product) => product.id === routePackageId && isPackage(product)) : null;

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
    if (!selected) return;
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
      setNotice("Client cancelled from this shared group.");
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

  async function bookPublicDeparture({ departureId, customerName, customerEmail, seats, roomingType, accommodationTier }) {
    setIsSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE}/public/departures/${departureId}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName, customerEmail, seats: Number(seats), roomingType, accommodationTier }),
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
      setNotice("Booking cancelled. Availability updated live.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return <LoadingScreen />;
  }

  const isPortalRoute = path.startsWith("/admin") || path.startsWith("/agency") || path.startsWith("/portal");

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

// ---- Super admin: manage agencies + their owners ----
function AgenciesPanel() {
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", contactName: "", phone: "", ownerName: "", ownerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);

  async function load() {
    try {
      const res = await apiFetch("/admin/agencies");
      const data = await res.json();
      if (res.ok) setAgencies(data.agencies || []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function createAgency(e) {
    e.preventDefault();
    setBusy(true); setError(""); setCreated(null);
    try {
      const res = await apiFetch("/admin/agencies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the agency.");
      setCreated({ email: data.ownerEmail, tempPassword: data.tempPassword, name: data.agency.name });
      setForm({ name: "", contactName: "", phone: "", ownerName: "", ownerEmail: "" });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel agencies-panel admin-wide" id="agencies">
      <div className="panel-header">
        <div><h2>Agencies</h2><p>Create a partner agency and its owner login.</p></div>
        <ShieldCheck size={20} />
      </div>

      <form className="agency-add" onSubmit={createAgency}>
        <div className="field"><label>Agency name</label><input value={form.name} onChange={set("name")} placeholder="Nile Star Travel" /></div>
        <div className="field"><label>Phone (optional)</label><input value={form.phone} onChange={set("phone")} placeholder="+20 …" /></div>
        <div className="field"><label>Owner name</label><input value={form.ownerName} onChange={set("ownerName")} placeholder="Owner full name" /></div>
        <div className="field"><label>Owner email</label><input type="email" value={form.ownerEmail} onChange={set("ownerEmail")} placeholder="owner@agency.com" /></div>
        <button className="primary" type="submit" disabled={busy}><Plus size={17} />{busy ? "Creating…" : "Create agency"}</button>
      </form>

      {error && <div className="auth-error" role="alert">{error}</div>}
      {created && (
        <div className="temp-pass" role="status">
          <strong>{created.name} created. Owner {created.email} can sign in.</strong>
          <p>Share this one-time password — it won't be shown again:</p>
          <code>{created.tempPassword}</code>
        </div>
      )}

      <div className="agency-list">
        {loading && <p className="field-hint">Loading agencies…</p>}
        {!loading && agencies.map((a) => (
          <div className="agency-row" key={a.id}>
            <div><strong>{a.name}</strong><span>{a.contactName}{a.phone ? ` · ${a.phone}` : ""}</span></div>
            <span className="agency-meta">{a.staffCount} {a.staffCount === 1 ? "member" : "members"}</span>
            <span className={`team-status ${a.status === "active" ? "active" : "disabled"}`}>{a.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function pageFromPath(p) {
  const clean = (p || "/").replace(/\/+$/, "") || "/";
  if (clean === "/tours" || clean === "/packages") return "tours";
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
    const aConfirmed = aSeats >= goAheadFor(aLead || a) ? 1 : 0;
    const bConfirmed = bSeats >= goAheadFor(bLead || b) ? 1 : 0;
    return bConfirmed - aConfirmed || bSeats - aSeats;
  });

  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".reveal"));
    if (!els.length) return;
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -50px 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [publicView, tourId, packageId]);

  if ((tourId && !routeTour) || (packageId && !routePackage)) {
    return (
      <main className="public-shell">
        <PublicNav navigate={navigate} />
        <section className="loading-screen">
          <strong>Not found.</strong>
          <button className="primary" onClick={() => navigate("/")}>Back to tours</button>
        </section>
      </main>
    );
  }

  const showDetail = routeTour || routePackage;
  const page = (path === "/" || path === "") ? "home" : (showDetail ? "detail" : pageFromPath(path));

  // Standalone marketing/legal pages share the nav + footer shell.
  if (page !== "home" && page !== "detail") {
    return (
      <main className="public-shell">
        <PublicNav navigate={navigate} path={path} />
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
        <PublicFooter navigate={navigate} />
      </main>
    );
  }

  return (
    <main className="public-shell">
      <PublicNav navigate={navigate} path={path} />
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
                  navigate("/tours");
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
                <p className="how-lead">Sawa pools small bookings into one shared group. You hold a seat for free; once enough travellers join the same date, it is guaranteed to run.</p>
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
                  <p>As more travellers book the same date, the shared price drops and the trip moves toward GoAhead.</p>
                </article>
                <article className="how-step is-go">
                  <span className="how-num">03</span>
                  <h3>It runs, guaranteed</h3>
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

            <section className="reviews2 reveal" id="reviews">
              <aside className="reviews2-aside">
                <p className="reviews2-kicker">After the tour ran</p>
                <h2>Travellers who actually went.</h2>
                <div className="reviews2-rating">
                  <span className="reviews2-num">4.9</span>
                  <span className="reviews2-stars" aria-label="4.9 out of 5">★★★★★</span>
                  <span className="reviews2-meta">from 312 confirmed travellers</span>
                </div>
                <ul className="reviews2-trust">
                  <li><Users size={17} /> Small groups, never crowded</li>
                  <li><ShieldCheck size={17} /> Verified, licensed operators</li>
                  <li><CalendarDays size={17} /> Real departures, confirmed before you pay</li>
                </ul>
              </aside>
              <div className="reviews2-quotes">
                {reviews.map((review) => (
                  <figure className="reviews2-quote" key={review.name}>
                    <span className="reviews2-stars" aria-label="5 out of 5">★★★★★</span>
                    <blockquote>{review.text}</blockquote>
                    <figcaption>
                      <strong>{review.name}</strong>
                      <span>{review.location} · {review.trip}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          </>
        )}

        {routeTour && (
          <TourDetail
            isSaving={isSaving}
            navigate={navigate}
            onBookPublicDeparture={onBookPublicDeparture}
            onCancelPublicBooking={onCancelPublicBooking}
            publicBooking={publicBooking}
            tour={routeTour}
          />
        )}

        {routePackage && (
          <PackageDetail
            isSaving={isSaving}
            navigate={navigate}
            onBookPublicDeparture={onBookPublicDeparture}
            onCancelPublicBooking={onCancelPublicBooking}
            publicBooking={publicBooking}
            pkg={routePackage}
          />
        )}
      </section>
      <PublicFooter navigate={navigate} />
    </main>
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

const PUBLIC_LINKS = [
  { label: "Tours", to: "/tours" },
  { label: "How it works", to: "/how-it-works" },
  { label: "Blog", to: "/blog" },
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
];

function PublicNav({ navigate, path = "/" }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (to) => { setMenuOpen(false); navigate(to); };
  const isActive = (to) => path === to || (to !== "/" && path.startsWith(to));

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [menuOpen]);

  return (
    <>
      <header className="public-nav">
        <button className="public-brand" onClick={() => go("/")} aria-label="Sawa Tours home">
          <SawaMark size={30} />
          <SawaWordmark />
        </button>
        <nav className="public-nav-links">
          {PUBLIC_LINKS.map((l) => (
            <a
              key={l.to}
              href={l.to}
              className={isActive(l.to) ? "active" : ""}
              onClick={(e) => { e.preventDefault(); go(l.to); }}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="public-nav-right">
          <button className="nav-cta" onClick={() => go("/tours")}>
            Book now
            <span className="nav-cta-icon"><ArrowRight size={15} /></span>
          </button>
          <button
            className="nav-burger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="nav-overlay" role="dialog" aria-modal="true">
          <nav className="nav-overlay-links">
            {PUBLIC_LINKS.map((l, i) => (
              <a
                key={l.to}
                href={l.to}
                style={{ "--i": i }}
                className={isActive(l.to) ? "active" : ""}
                onClick={(e) => { e.preventDefault(); go(l.to); }}
              >
                {l.label}
              </a>
            ))}
            <a href="/faq" style={{ "--i": PUBLIC_LINKS.length }} onClick={(e) => { e.preventDefault(); go("/faq"); }}>FAQ</a>
          </nav>
          <button className="nav-overlay-cta" onClick={() => go("/tours")}>
            Book now <ArrowRight size={18} />
          </button>
        </div>
      )}
    </>
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

function PublicFooter({ navigate }) {
  return (
    <footer className="footer-bare">
      <button className="footer-bare-brand" onClick={() => navigate("/")}>
        <SawaMark size={24} />
        <SawaWordmark />
      </button>
      <nav className="footer-bare-links">
        <button onClick={() => navigate("/faq")}>FAQ</button>
        <button onClick={() => navigate("/privacy")}>Privacy</button>
        <button onClick={() => navigate("/terms")}>Terms</button>
        <button onClick={() => navigate("/agency")}>Agency login</button>
      </nav>
      <span className="footer-bare-copy">© {new Date().getFullYear()} Sawa Tours</span>
    </footer>
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
    const ac = as >= goAheadFor(al || a) ? 1 : 0, bc = bs >= goAheadFor(bl || b) ? 1 : 0;
    return bc - ac || bs - as;
  });

  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Browse"
        title="Find a departure that's going."
        lead="Every tour shows live seats and whether the date is confirmed to run. Hold a seat for free — you only pay once it's GoAhead."
      />

      <div className="tours-toolbar reveal in">
        <div className="tours-cities">
          {cities.map((c) => (
            <button
              key={c}
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
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tours…" />
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
    { n: "02", t: "The group fills", d: "As more travellers book the same date, it moves toward GoAhead. The shared cost of the guide and vehicle is split across everyone, so the price stays fair." },
    { n: "03", t: "It runs — guaranteed", d: "Once the minimum number of travellers is reached, we confirm the guide and transport and take your deposit. If a date never fills, you pay nothing." },
  ];
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="How Sawa works"
        title="Your seat is free until the trip is real."
        lead="“Sawa” means together. We pool small bookings from different travellers into one shared group, so day tours and packages actually run — and you never pay for a date that isn't confirmed."
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
          <p>When a date reaches its minimum travellers, it turns GoAhead — the guide and vehicle are booked and the departure is locked in. Until then, your seat is just a free hold. No surprises, no last-minute cancellations after you've paid.</p>
        </div>
      </section>

      <section className="how2-trust reveal in">
        <div className="how2-trust-item"><Users size={20} /><div><strong>Small groups</strong><span>Shared, never crowded — a real guide, not a mega-bus.</span></div></div>
        <div className="how2-trust-item"><ShieldCheck size={20} /><div><strong>Verified operators</strong><span>Licensed Egyptian guides and checked vehicles on every trip.</span></div></div>
        <div className="how2-trust-item"><BadgeCheck size={20} /><div><strong>No payment until confirmed</strong><span>You're only charged once the date is guaranteed to run.</span></div></div>
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
        lead="Sawa is a Cairo-based shared-tour platform. We connect independent travellers heading the same way on the same day, so small bookings become real, guaranteed group departures across Egypt."
      />

      <section className="about-lead reveal in">
        <div className="about-lead-text">
          <h2>Why we built it</h2>
          <p>Booking a day tour in Egypt usually means two bad options: pay a premium for a private car, or book a cheap group tour that quietly gets cancelled when not enough people sign up. Sawa fixes the second problem. By pooling bookings from multiple agencies and travellers into one shared group, a date only needs a handful of people to become guaranteed — and everyone shares a fair price.</p>
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
        <article><ShieldCheck size={22} /><h3>Verified operators</h3><p>Every departure runs with licensed Egyptian guides and inspected transport.</p></article>
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
    window.location.href = `mailto:hello@sawatours.org?subject=${encodeURIComponent("Sawa enquiry")}&body=${body}`;
    setSent(true);
  };
  return (
    <div className="page-wrap">
      <PageHead
        eyebrow="Talk to us"
        title="We reply within two hours."
        lead="Questions about a date, a pickup, or a private group? Message us on WhatsApp for the fastest answer, or send a note below."
      />
      <div className="contact-grid reveal in">
        <div className="contact-methods">
          <a className="contact-card" href="https://wa.me/201092847613" target="_blank" rel="noreferrer">
            <MessageCircle size={20} />
            <div><strong>WhatsApp</strong><span>+20 109 284 7613</span></div>
          </a>
          <a className="contact-card" href="mailto:hello@sawatours.org">
            <Mail size={20} />
            <div><strong>Email</strong><span>hello@sawatours.org</span></div>
          </a>
          <div className="contact-card static">
            <Clock3 size={20} />
            <div><strong>Hours</strong><span>9am – 9pm Cairo time, daily</span></div>
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
              <p>We'll get back to you within two hours during Cairo hours. For anything urgent, reach us on WhatsApp.</p>
            </div>
          ) : (
            <>
              <label className="field"><span>Your name</span><input value={form.name} onChange={set("name")} required placeholder="Full name" /></label>
              <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set("email")} required placeholder="you@email.com" /></label>
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
      { q: "What happens if the tour doesn't fill?", a: "If a date never reaches the minimum number of travellers, it simply doesn't run and you're charged nothing. We'll let you know and help you move to another date." },
      { q: "How much is the deposit?", a: "It varies by tour, but it's a small percentage of the total shown clearly before you confirm. The balance is settled per the tour's terms." },
    ],
  },
  {
    title: "GoAhead & how it works",
    items: [
      { q: "What does GoAhead mean?", a: "GoAhead means a date has reached the minimum travellers, so the guide and vehicle are booked and the departure is guaranteed to run." },
      { q: "Can a confirmed tour still be cancelled?", a: "Once a date is GoAhead we don't cancel it for low numbers. In rare cases of safety or weather, we'll rebook or refund you." },
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
        <p className="legal-contact">Questions about this policy? Email <a href="mailto:hello@sawatours.org">hello@sawatours.org</a>.</p>
      </article>
    </div>
  );
}

const PRIVACY_SECTIONS = [
  { h: "What we collect", p: ["When you hold a seat or book a tour, we collect the details you give us — your name, email, phone number, the travellers in your party, and the tour and date you choose.", "We also collect basic technical information such as your browser type and pages visited, to keep the service running and secure."] },
  { h: "How we use it", p: ["We use your information to confirm departures, contact you about your booking, take payment when a date is confirmed, and provide support. Agencies you book through can see the booking details needed to run your tour.", "We do not sell your personal information."] },
  { h: "Who sees it", p: ["Your booking details are shared only with the operating agency and our operations team, strictly to deliver your tour. Payment is handled by our payment provider; we don't store full card details."] },
  { h: "Your choices", p: ["You can ask us to access, correct, or delete your information at any time by emailing us. You can opt out of non-essential messages while still receiving booking updates."] },
  { h: "Data retention", p: ["We keep booking records for as long as needed to provide the service and meet legal and accounting obligations, then delete or anonymise them."] },
];

const TERMS_SECTIONS = [
  { h: "The Sawa model", p: ["Sawa pools bookings from multiple travellers and agencies into shared group departures. Holding a seat is free and does not guarantee the tour will run. A departure becomes confirmed (GoAhead) only when it reaches the minimum number of travellers."] },
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
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. SAWA-7K2QX" />
        </label>
        <button className="btn-pill primary" type="submit" disabled={state.status === "loading"}>
          {state.status === "loading" ? "Checking…" : "Check status"} <Search size={16} />
        </button>
      </form>

      <div className="booking-result reveal in">
        {state.status === "notfound" && (
          <div className="page-empty"><Ticket size={26} /><strong>No booking found with that code.</strong><p>Double-check the code in your confirmation email, or contact us.</p><button className="btn-pill" onClick={() => navigate("/contact")}>Contact us</button></div>
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
            <div className="booking-progress">
              <div className="booking-progress-row"><span>{b.seatsBooked}/{b.goAhead} seats to confirm</span><b>{b.confirmed ? "GoAhead — confirmed" : "Still forming"}</b></div>
              <i><em style={{ width: `${Math.min(100, (b.seatsBooked / Math.max(1, b.goAhead)) * 100)}%` }} /></i>
            </div>
            <p className="booking-note">{b.confirmed
              ? "Your date is confirmed — the guide and transport are booked. See your confirmation email for the meeting point and time."
              : "Your seat is held. We'll let you know the moment this date reaches GoAhead."}</p>
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
        <div className="page-404-actions">
          <button className="btn-pill primary" onClick={() => navigate("/tours")}>Browse tours <ArrowRight size={16} /></button>
          <button className="btn-pill" onClick={() => navigate("/")}>Back home</button>
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
      <button className="btn-pill primary lg" onClick={() => navigate("/tours")}>Browse tours <ArrowRight size={18} /></button>
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
const blogDate = (d) => (d ? new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" }).format(new Date(d)) : "");

// ---- /blog : listing ----
function BlogIndexPage({ navigate }) {
  const [state, setState] = useState({ status: "loading", posts: [] });
  useEffect(() => {
    document.title = "Blog — Sawa Tours";
    let alive = true;
    fetch(`${API_BASE}/blog`).then((r) => r.json()).then((j) => { if (alive) setState({ status: "done", posts: j.posts || [] }); })
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
            <article className="blog-card" key={p.id} onClick={() => navigate(`/blog/${p.slug}`)}>
              <div className="blog-card-media" style={p.coverImage ? { backgroundImage: `url(${p.coverImage})` } : undefined}>
                {!p.coverImage && <Newspaper size={26} />}
              </div>
              <div className="blog-card-body">
                {p.tags?.[0] && <span className="blog-card-tag">{p.tags[0]}</span>}
                <h3>{p.title}</h3>
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
      .then((r) => (r.status === 404 ? Promise.reject(new Error("nf")) : r.json()))
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

// Image gallery for a tour/package detail page (cover large + thumbnails).
function Gallery({ product }) {
  const imgs = (product.images || []).filter((i) => i?.url);
  const [active, setActive] = useState(0);
  if (!imgs.length) {
    return <div className="detail-hero" style={{ backgroundImage: `url(${coverImage(product)})` }} />;
  }
  return (
    <div className="gallery">
      <div className="gallery-main" style={{ backgroundImage: `url(${imgs[Math.min(active, imgs.length - 1)].url})` }} />
      {imgs.length > 1 && (
        <div className="gallery-thumbs">
          {imgs.map((im, i) => (
            <button key={i} className={i === active ? "active" : ""} style={{ backgroundImage: `url(${im.url})` }}
              onClick={() => setActive(i)} aria-label={`Image ${i + 1}`} />
          ))}
        </div>
      )}
    </div>
  );
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
  const goAhead = goAheadFor(product);
  const goAheadDates = product.dates.filter((departure) => departure.status === "supplier_confirmed" || seatsTotal(departure.pledges) >= goAheadFor(departure)).length;
  const leadDate = openDates(product)[0] || product.dates[0];
  const seats = leadDate ? seatsTotal(leadDate.pledges) : 0;
  const confidence = confidenceFor(seats, goAhead);
  const stops = routeStops[product.id] || [product.city, product.title];
  const livePrice = leadDate ? livePriceFor({ ...product, ...leadDate }, seats) : livePriceFor(product, goAhead);
  const breakPrice = safePrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
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
          <strong>{product.title}</strong>
          <span className="tour-card-price">${livePrice}</span>
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
          <span>{full ? "All dates full — check back soon" : `${pluralize(openDates(product).length, "open date")} · from $${breakPrice} at full group`}</span>
        </div>
        <button className="departure-link" disabled={full} onClick={() => navigate(`/tour/${product.id}`)}>
          {full ? "Fully booked" : "View tour"}
        </button>
      </div>
    </article>
  );
}

function PackageCard({ navigate, product }) {
  const goAhead = goAheadFor(product);
  const leadDate = openDates(product)[0] || product.dates[0];
  const seats = leadDate ? seatsTotal(leadDate.pledges) : 0;
  const confidence = confidenceFor(seats, goAhead);
  const cities = product.cities || [product.city];
  const livePrice = leadDate ? livePriceFor({ ...product, ...leadDate }, seats) : livePriceFor(product, goAhead);
  const breakPrice = safePrice(product.breakPrice, Math.round(product.publishedRate * 0.8));
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
          <strong>{product.title}</strong>
          <span className="tour-card-price">from ${livePrice}</span>
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
          <span><Hotel size={13} />{(product.accommodationTiers || []).length || 1} hotel tier{((product.accommodationTiers || []).length || 1) > 1 ? "s" : ""} · from ${breakPrice}/pp</span>
        </div>
        <button className="departure-link" disabled={full} onClick={() => navigate(`/package/${product.id}`)}>
          {full ? "Fully booked" : "View package"}
        </button>
      </div>
    </article>
  );
}

// Star rating row (filled to the rounded score) for the detail header.
function Stars({ value = 5, size = 15 }) {
  const full = Math.round(value);
  return (
    <span className="tdx-stars" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={size} className={n <= full ? "on" : ""} />
      ))}
    </span>
  );
}

// Editorial gallery: one tall lead image + a 2x2 grid, opening a lightbox.
function TourGallery({ product }) {
  const imgs = (product.images || []).filter((i) => i?.url);
  const [lightbox, setLightbox] = useState(-1);

  if (!imgs.length) {
    return <div className="tdx-gallery-solo" style={{ backgroundImage: `url(${coverImage(product)})` }} />;
  }

  const lead = imgs[0];
  const rest = imgs.slice(1, 5);

  return (
    <>
      <div className={`tdx-gallery ${rest.length ? "has-side" : "lead-only"}`}>
        <button
          className="tdx-gallery-lead"
          style={{ backgroundImage: `url(${lead.url})` }}
          onClick={() => setLightbox(0)}
          aria-label="Open photo 1"
        />
        {rest.length > 0 && (
          <div className="tdx-gallery-side">
            {rest.map((im, i) => (
              <button
                key={i}
                className="tdx-gallery-cell"
                style={{ backgroundImage: `url(${im.url})` }}
                onClick={() => setLightbox(i + 1)}
                aria-label={`Open photo ${i + 2}`}
              >
                {i === rest.length - 1 && imgs.length > 5 && (
                  <span className="tdx-gallery-more"><Camera size={16} />+{imgs.length - 5}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {imgs.length > 1 && (
          <button className="tdx-gallery-all" onClick={() => setLightbox(0)}>
            <Camera size={15} />All {imgs.length} photos
          </button>
        )}
      </div>
      {lightbox >= 0 && (
        <Lightbox imgs={imgs} index={lightbox} setIndex={setLightbox} onClose={() => setLightbox(-1)} />
      )}
    </>
  );
}

// Full-screen photo viewer with keyboard + click navigation.
function Lightbox({ imgs, index, setIndex, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((i) => (i + 1) % imgs.length);
      if (event.key === "ArrowLeft") setIndex((i) => (i - 1 + imgs.length) % imgs.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imgs.length, onClose, setIndex]);

  const img = imgs[index];
  return (
    <div className="tdx-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="tdx-lb-close" onClick={onClose} aria-label="Close photos"><X size={20} /></button>
      <button
        className="tdx-lb-nav prev"
        onClick={(event) => { event.stopPropagation(); setIndex((i) => (i - 1 + imgs.length) % imgs.length); }}
        aria-label="Previous photo"
      ><ArrowLeft size={22} /></button>
      <figure className="tdx-lb-stage" onClick={(event) => event.stopPropagation()}>
        <img src={img.url} alt={img.alt || `Photo ${index + 1}`} />
      </figure>
      <button
        className="tdx-lb-nav next"
        onClick={(event) => { event.stopPropagation(); setIndex((i) => (i + 1) % imgs.length); }}
        aria-label="Next photo"
      ><ArrowRight size={22} /></button>
      <span className="tdx-lb-count">{index + 1} / {imgs.length}</span>
    </div>
  );
}

// Long overview text, clamped with a "Read more" toggle to keep the page calm.
function CollapsibleHtml({ html, fallback }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const hasHtml = html && html.replace(/<[^>]*>/g, "").trim();
  useEffect(() => {
    if (ref.current) setOverflowing(ref.current.scrollHeight > 320);
  }, [html, fallback]);
  if (!hasHtml && !fallback) return null;
  const clamped = overflowing && !expanded;
  return (
    <div className={`tdx-readmore ${clamped ? "is-clamped" : ""}`}>
      <div className="tdx-readmore-body" ref={ref}>
        {hasHtml
          ? <div className="rich" dangerouslySetInnerHTML={{ __html: html }} />
          : <p>{fallback}</p>}
      </div>
      {overflowing && (
        <button type="button" className="tdx-readmore-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Read more"}
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// Collapsible day-by-day itinerary — one open at a time.
function ItineraryAccordion({ items }) {
  const [open, setOpen] = useState(0);
  return (
    <ol className="tdx-itin">
      {items.map((day, i) => {
        const isOpen = open === i;
        return (
          <li key={day.day || i} className={isOpen ? "open" : ""}>
            <button
              type="button"
              className="tdx-itin-head"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? -1 : i)}
            >
              <span className="tdx-itin-mark">{i + 1}</span>
              <strong>{day.title || `Stop ${i + 1}`}</strong>
              <ChevronDown size={18} className="tdx-itin-chev" aria-hidden="true" />
            </button>
            <div className="tdx-itin-body">
              <div className="tdx-itin-inner">
                {day.description && (/<\w+/.test(day.description)
                  ? <div className="rich" dangerouslySetInnerHTML={{ __html: day.description }} />
                  : <p>{day.description}</p>)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Live shared-price explainer: one price for everyone, dropping as the group
// grows. Fully dynamic — the bar, cards and footer react to confirmed seats.
function LiveSharedPrice({ currentSeats, goAhead, maxSeats, headlinePrice, nowPrice, bestPrice }) {
  const cap = Math.max(Number(maxSeats) || 0, goAhead, 1);
  const fillPct = Math.min(100, Math.round((currentSeats / cap) * 100));
  const goPct = Math.min(98, Math.max(2, Math.round((goAhead / cap) * 100)));
  const confirmed = currentSeats >= goAhead;
  const needed = Math.max(0, goAhead - currentSeats);
  return (
    <div className="lsp">
      <span className="lsp-label">Live shared price · per person</span>
      <div className="lsp-now">
        <strong>${headlinePrice.toLocaleString()}</strong>
        <em>per person, today</em>
      </div>
      <p className="lsp-lead">Everyone on this departure pays the same price. As the group grows, it drops for all of you — early bookers are refunded the difference.</p>

      <div className="lsp-track">
        <div className="lsp-ends">
          <span><Flag size={14} />Departs at {goAhead}</span>
          <span><Percent size={14} />Best price at {maxSeats}</span>
        </div>
        <div className="lsp-bar">
          <i style={{ width: `${fillPct}%` }} />
          <span className="lsp-mark" style={{ left: `${goPct}%` }} />
        </div>
        <div className="lsp-scale">
          <span className="lsp-s-mid" style={{ left: `${goPct}%` }}>{goAhead} · departure go</span>
          <span className="lsp-s-right">{maxSeats} · full</span>
        </div>
      </div>

      <div className="lsp-cards">
        <div className="lsp-card">
          <span>Now · {currentSeats} confirmed</span>
          <strong>${nowPrice.toLocaleString()}</strong>
        </div>
        <div className="lsp-card is-best">
          <span>Best · all {maxSeats} seats</span>
          <strong>${bestPrice.toLocaleString()}</strong>
        </div>
      </div>

      <p className="lsp-foot">
        <Users size={15} />
        {confirmed
          ? "This departure is confirmed — each extra traveller lowers the price for everyone"
          : `${needed} more confirm the departure · each extra traveller after that lowers the price for everyone`}
      </p>
    </div>
  );
}

function TourDetail({ isSaving, navigate, onBookPublicDeparture, onCancelPublicBooking, publicBooking, tour }) {
  const leadDeparture = tour.dates[0];
  const [selectedDepartureId, setSelectedDepartureId] = useState(leadDeparture?.id || "");
  const [travelerName, setTravelerName] = useState("");
  const [travelerEmail, setTravelerEmail] = useState("");
  const [travelerPhone, setTravelerPhone] = useState("");
  const [travelerSeats, setTravelerSeats] = useState(1);
  const [errors, setErrors] = useState({});
  const selectedDeparture = tour.dates.find((departure) => Number(departure.id) === Number(selectedDepartureId)) || leadDeparture;
  const goAhead = goAheadFor(tour);
  const currentSeats = selectedDeparture ? seatsTotal(selectedDeparture.pledges) : 0;
  const requestedSeats = Math.max(1, Number(travelerSeats || 1));
  const projectedSeats = selectedDeparture ? Math.min(selectedDeparture.maxSeats, currentSeats + requestedSeats) : requestedSeats;
  const currentPrice = selectedDeparture ? livePriceFor({ ...tour, ...selectedDeparture }, currentSeats) : livePriceFor(tour, goAhead);
  const projectedPrice = selectedDeparture ? livePriceFor({ ...tour, ...selectedDeparture }, projectedSeats) : currentPrice;
  const depositPercentValue = Number(selectedDeparture?.depositPercent || tour.depositPercent || 10);
  const bookingTotal = projectedPrice * requestedSeats;
  const depositDue = depositFor(bookingTotal, depositPercentValue);
  const balanceDue = Math.max(0, bookingTotal - depositDue);
  const breakPrice = safePrice(selectedDeparture?.breakPrice || tour.breakPrice, Math.round(tour.publishedRate * 0.8));
  const remainingSeats = selectedDeparture ? Math.max(0, selectedDeparture.maxSeats - currentSeats) : goAhead;

  const maxSelectable = Math.min(4, Math.max(0, remainingSeats));
  const soldOut = remainingSeats <= 0;
  const seatPct = goAhead ? Math.min(100, Math.round((currentSeats / goAhead) * 100)) : 0;
  const itinerary = (tour.itinerary || []).filter((day) => day && (day.title || day.description));
  const stops = routeStops[tour.id] || [tour.city, tour.title];

  useEffect(() => {
    setSelectedDepartureId(leadDeparture?.id || "");
  }, [leadDeparture?.id]);

  useEffect(() => {
    setErrors({});
  }, [selectedDepartureId]);

  function validate() {
    const next = {};
    if (!travelerName.trim()) {
      next.name = "Please enter the lead traveler's name.";
    } else if (travelerName.trim().length < 2) {
      next.name = "That name looks too short.";
    }
    if (travelerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(travelerEmail.trim())) {
      next.email = "That email doesn't look right.";
    }
    const seatsNum = Number(travelerSeats);
    if (!Number.isInteger(seatsNum) || seatsNum < 1) {
      next.seats = "Choose at least 1 seat.";
    } else if (seatsNum > maxSelectable) {
      next.seats = maxSelectable === 0
        ? "This date is full."
        : `Only ${maxSelectable} seat${maxSelectable === 1 ? "" : "s"} left on this date.`;
    }
    return next;
  }

  function submitPublicBooking(event) {
    event.preventDefault();
    if (!selectedDeparture) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length) return;
    onBookPublicDeparture({
      departureId: selectedDeparture.id,
      customerName: travelerName.trim(),
      customerEmail: travelerEmail.trim(),
      customerPhone: travelerPhone.trim(),
      seats: travelerSeats,
    });
    setTravelerName("");
    setTravelerEmail("");
    setTravelerPhone("");
    setTravelerSeats(1);
    setErrors({});
  }

  return (
    <article className="tdx">
      <button className="tdx-back" onClick={() => navigate("/tours")}>
        <ArrowLeft size={17} />All tours
      </button>

      <TourGallery product={tour} />

      <header className="tdx-head">
        <div className="tdx-head-top">
          <span className="tdx-eyebrow"><MapPin size={14} />{tour.city}, Egypt</span>
          {tour.quality ? (
            <span className="tdx-rating">
              <Stars value={tour.quality} />
              <b>{Number(tour.quality).toFixed(1)}</b>
              <span>from confirmed travellers</span>
            </span>
          ) : null}
        </div>
        <h1>{tour.title}</h1>
        <div className="tdx-facts">
          {tour.duration && <span><Clock3 size={16} />{tour.duration}</span>}
          <span><Users size={16} />Small group · max {tour.maxSeats}</span>
          {tour.guide && <span><Globe size={16} />{tour.guide}</span>}
          {tour.vehicle && <span><Car size={16} />{tour.vehicle}</span>}
        </div>
      </header>

      <div className="tdx-grid">
        <div className="tdx-content">
          <section className="tdx-block">
            <h2>About this tour</h2>
            <CollapsibleHtml html={tour.overviewHtml} fallback={tour.description} />
            {stops.length > 1 && (
              <div className="tdx-route">
                {stops.map((stop, i) => (
                  <span key={stop}>
                    {stop}{i < stops.length - 1 && <ChevronRight size={15} aria-hidden="true" />}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="tdx-block">
            <h2>What's included</h2>
            <div className="tdx-incl">
              <ul className="tdx-incl-yes">
                {(tour.included || []).map((item) => <li key={item}><Check size={16} />{item}</li>)}
                {!(tour.included || []).length && <li className="muted-line">Details on request.</li>}
              </ul>
              <ul className="tdx-incl-no">
                {(tour.notIncluded || []).map((item) => <li key={item}><X size={15} />{item}</li>)}
                {!(tour.notIncluded || []).length && <li className="muted-line">—</li>}
              </ul>
            </div>
          </section>

          {itinerary.length > 0 && (
            <section className="tdx-block">
              <h2>Your day, stop by stop</h2>
              <ItineraryAccordion items={itinerary} />
            </section>
          )}

          <TourExtras product={tour} />
        </div>

        <aside className="tdx-aside">
        <div className="tdx-booking">
          <LiveSharedPrice
            currentSeats={currentSeats}
            goAhead={goAhead}
            maxSeats={selectedDeparture?.maxSeats || goAhead}
            headlinePrice={projectedPrice}
            nowPrice={currentPrice}
            bestPrice={breakPrice}
          />
          <form className="public-booking-form" onSubmit={submitPublicBooking} noValidate>
            <div className="field">
              <label htmlFor="td-date">Date</label>
              <select id="td-date" value={selectedDepartureId} onChange={(event) => setSelectedDepartureId(event.target.value)}>
                {tour.dates.map((departure) => {
                  const seats = seatsTotal(departure.pledges);
                  return (
                    <option key={departure.id} value={departure.id}>
                      {formatDate(departure.date)} · {seats}/{goAheadFor(departure)} seats
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="tdx-frow">
              <div className="field tdx-fname">
                <label htmlFor="td-name">Your name</label>
                <input
                  id="td-name"
                  value={travelerName}
                  onChange={(event) => {
                    setTravelerName(event.target.value);
                    if (errors.name) setErrors((e) => ({ ...e, name: undefined }));
                  }}
                  placeholder="e.g. Yara Mansour"
                  aria-invalid={errors.name ? "true" : "false"}
                  className={errors.name ? "input-error" : ""}
                />
                {errors.name && <span className="field-error" role="alert">{errors.name}</span>}
              </div>
              <div className="field tdx-fseats">
                <label htmlFor="td-seats">Seats</label>
                <input
                  id="td-seats"
                  min="1"
                  max={Math.max(1, maxSelectable)}
                  type="number"
                  value={travelerSeats}
                  onChange={(event) => {
                    setTravelerSeats(event.target.value);
                    if (errors.seats) setErrors((e) => ({ ...e, seats: undefined }));
                  }}
                  aria-invalid={errors.seats ? "true" : "false"}
                  className={errors.seats ? "input-error" : ""}
                  disabled={soldOut}
                />
                {errors.seats && <span className="field-error" role="alert">{errors.seats}</span>}
              </div>
            </div>
            <div className="tdx-frow">
              <div className="field">
                <label htmlFor="td-email">Email <span className="field-opt">(optional)</span></label>
                <input
                  id="td-email"
                  type="email"
                  value={travelerEmail}
                  onChange={(event) => {
                    setTravelerEmail(event.target.value);
                    if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
                  }}
                  placeholder="you@email.com"
                  aria-invalid={errors.email ? "true" : "false"}
                  className={errors.email ? "input-error" : ""}
                />
                {errors.email && <span className="field-error" role="alert">{errors.email}</span>}
              </div>
              <div className="field">
                <label htmlFor="td-phone">Phone <span className="field-opt">(optional)</span></label>
                <input id="td-phone" type="tel" value={travelerPhone} onChange={(e) => setTravelerPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
              </div>
            </div>
            <div className="deposit-summary tdx-deposit">
              <div><span>Deposit today</span><strong>${depositDue}</strong></div>
              <div><span>Balance</span><strong>${balanceDue}</strong></div>
              <p>{depositPercentValue}% confirms your seat · balance due {selectedDeparture ? balanceDueDate(selectedDeparture.date) : "before departure"}.</p>
            </div>
            <button className="primary full" disabled={isSaving || !selectedDeparture || soldOut} type="submit">
              {isSaving ? "Updating seats..." : soldOut ? "Date full" : "Join this departure"}
            </button>
          </form>
          {publicBooking && Number(publicBooking.departureId) === Number(selectedDeparture?.id) && (
            <div className="booking-receipt">
              <strong>Request added: {publicBooking.code}</strong>
              <p>{publicBooking.seats} seat{publicBooking.seats > 1 ? "s" : ""} for {publicBooking.customerName}</p>
              {publicBooking.depositDue && (
                <p>${publicBooking.depositDue} deposit due now · ${publicBooking.balanceDue} balance due {publicBooking.balanceDueDate}</p>
              )}
              <button disabled={isSaving} onClick={onCancelPublicBooking}>Cancel this request</button>
            </div>
          )}
        </div>
        <ul className="tdx-assure">
          <li><ShieldCheck size={16} />No payment until your group is confirmed</li>
          <li><Users size={16} />Small shared groups, never crowded</li>
          <li><BadgeCheck size={16} />Licensed guide &amp; vehicle on every date</li>
        </ul>
        </aside>
      </div>

      {leadDeparture && <LiveDepartureTimeline departure={leadDeparture} />}

      <section className="tour-calendar tdx-dates">
        <div className="tour-calendar-header">
          <div>
            <strong>Available dates</strong>
            <p>Once minimum seats are booked, the date is GoAhead.</p>
          </div>
          <span className="pill"><CalendarDays size={15} />{tour.dates.length} date{tour.dates.length === 1 ? "" : "s"}</span>
        </div>
        <div className="calendar-days">
          {tour.dates.length === 0 && <div className="empty-day">No dates published yet</div>}
          {tour.dates.map((departure) => <CalendarDay departure={departure} key={departure.id} />)}
        </div>
      </section>
    </article>
  );
}

// Rich day-by-day accordion for packages: city + title header, then meals,
// accommodation, included-today and optional activities on expand.
function PackageItinerary({ items }) {
  const [open, setOpen] = useState(0);
  return (
    <ol className="pitin">
      {items.map((day, i) => {
        const isOpen = open === i;
        const included = (day.included || []).filter(Boolean);
        const optional = (day.optional || []).filter(Boolean);
        const dayNum = day.day || i + 1;
        const meals = day.meals && day.meals !== "—" ? day.meals : "";
        const last = i === items.length - 1;
        return (
          <li key={dayNum} className={`pitin-day${isOpen ? " open" : ""}${last ? " last" : ""}`}>
            <div className="pitin-rail"><span className="pitin-node">{dayNum}</span></div>
            <div className="pitin-card">
              <button
                type="button"
                className="pitin-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                <span className="pitin-headmain">
                  <span className="pitin-eyebrow">Day {dayNum} · {day.city}</span>
                  <strong className="pitin-title">{day.title}</strong>
                </span>
                {day.overnight && (
                  <span className="pitin-overnight"><Hotel size={13} />{day.overnight}</span>
                )}
                <ChevronDown size={18} className="pitin-chev" aria-hidden="true" />
              </button>
              <div className="pitin-body">
                <div className="pitin-inner">
                  {day.description && <p className="pitin-desc">{day.description}</p>}
                  {meals && (
                    <div className="pitin-chips">
                      <span className="pitin-chip"><Utensils size={13} />{meals}</span>
                    </div>
                  )}
                  {included.length > 0 && (
                    <ul className="pitin-incl">
                      {included.map((x) => <li key={x}><Check size={15} />{x}</li>)}
                    </ul>
                  )}
                  {optional.length > 0 && (
                    <div className="pitin-opt">
                      <span className="pitin-opt-tag">Optional</span>
                      <ul>{optional.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                  )}
                  {day.special && <p className="pitin-note"><Bell size={13} />{day.special}</p>}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PackageDetail({ isSaving, navigate, onBookPublicDeparture, onCancelPublicBooking, publicBooking, pkg }) {
  const leadDeparture = pkg.dates[0];
  const [selectedDepartureId, setSelectedDepartureId] = useState(leadDeparture?.id || "");
  const [travelerName, setTravelerName] = useState("");
  const [travelerEmail, setTravelerEmail] = useState("");
  const [travelerPhone, setTravelerPhone] = useState("");
  const [travelerSeats, setTravelerSeats] = useState(2);
  const tiers = pkg.accommodationTiers || [];
  const [tierId, setTierId] = useState(tiers[0]?.id || "");
  const [roomingType, setRoomingType] = useState("double");
  const [errors, setErrors] = useState({});
  const selectedDeparture = pkg.dates.find((d) => Number(d.id) === Number(selectedDepartureId)) || leadDeparture;
  const goAhead = goAheadFor(pkg);
  const currentSeats = selectedDeparture ? seatsTotal(selectedDeparture.pledges) : 0;
  const requestedSeats = Math.max(1, Number(travelerSeats || 1));
  const projectedSeats = selectedDeparture ? Math.min(selectedDeparture.maxSeats, currentSeats + requestedSeats) : Math.max(goAhead, requestedSeats);
  const pricePerPerson = packagePriceFor(pkg, selectedDeparture, projectedSeats, { roomingType, tierId });
  const depositPercentValue = Number(selectedDeparture?.depositPercent || pkg.depositPercent || 20);
  const bookingTotal = pricePerPerson * requestedSeats;
  const depositDue = depositFor(bookingTotal, depositPercentValue);
  const balanceDue = Math.max(0, bookingTotal - depositDue);
  const remainingSeats = selectedDeparture ? Math.max(0, selectedDeparture.maxSeats - currentSeats) : goAhead;
  const soldOut = remainingSeats <= 0;
  const basePrice = livePriceFor(selectedDeparture || pkg, currentSeats);
  const projectedBase = livePriceFor(selectedDeparture || pkg, projectedSeats);
  const breakBase = safePrice(pkg.breakPrice, Math.round(pkg.publishedRate * 0.8));
  const seatPct = goAhead ? Math.min(100, Math.round((currentSeats / goAhead) * 100)) : 0;
  const cities = pkg.cities || [pkg.city];
  const itin = (pkg.itinerary || []).filter((day) => day && (day.title || day.description));

  useEffect(() => {
    setSelectedDepartureId(leadDeparture?.id || "");
  }, [leadDeparture?.id]);

  useEffect(() => {
    setErrors({});
  }, [selectedDepartureId]);

  function validate() {
    const next = {};
    if (!travelerName.trim()) {
      next.name = "Please enter the lead traveler's name.";
    } else if (travelerName.trim().length < 2) {
      next.name = "That name looks too short.";
    }
    if (!tierId) next.tier = "Choose a hotel tier.";
    if (travelerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(travelerEmail.trim())) {
      next.email = "That email doesn't look right.";
    }
    const seatsNum = Number(travelerSeats);
    if (!Number.isInteger(seatsNum) || seatsNum < 1) {
      next.seats = "Add at least 1 traveler.";
    } else if (seatsNum > remainingSeats) {
      next.seats = remainingSeats === 0
        ? "This departure is full."
        : `Only ${remainingSeats} place${remainingSeats === 1 ? "" : "s"} left on this departure.`;
    }
    return next;
  }

  function submitPublicBooking(event) {
    event.preventDefault();
    if (!selectedDeparture) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length) return;
    onBookPublicDeparture({
      departureId: selectedDeparture.id,
      customerName: travelerName.trim(),
      customerEmail: travelerEmail.trim(),
      customerPhone: travelerPhone.trim(),
      seats: travelerSeats,
      roomingType,
      accommodationTier: tierId,
    });
    setTravelerName("");
    setTravelerEmail("");
    setTravelerPhone("");
    setTravelerSeats(2);
    setErrors({});
  }

  return (
    <article className="tdx">
      <button className="tdx-back" onClick={() => navigate("/tours")}>
        <ArrowLeft size={17} />All tours
      </button>

      <TourGallery product={pkg} />

      <header className="tdx-head">
        <div className="tdx-head-top">
          <span className="tdx-eyebrow"><Package size={14} />{pkg.duration} · multi-day package</span>
          {pkg.quality ? (
            <span className="tdx-rating">
              <Stars value={pkg.quality} />
              <b>{Number(pkg.quality).toFixed(1)}</b>
              <span>from confirmed travellers</span>
            </span>
          ) : null}
        </div>
        <h1>{pkg.title}</h1>
        <div className="tdx-facts">
          <span><MapPin size={16} />{cities.join(" · ")}</span>
          {pkg.nights ? <span><Hotel size={16} />{pkg.nights} nights</span> : null}
          {pkg.guide && <span><Globe size={16} />{pkg.guide}</span>}
          {pkg.vehicle && <span><Car size={16} />{pkg.vehicle}</span>}
        </div>
      </header>

      <div className="tdx-grid">
        <div className="tdx-content">
          <section className="tdx-block">
            <h2>About this trip</h2>
            <CollapsibleHtml html={pkg.overviewHtml} fallback={pkg.description} />
            {cities.length > 1 && (
              <div className="tdx-route">
                {cities.map((stop, i) => (
                  <span key={stop}>
                    {stop}{i < cities.length - 1 && <ChevronRight size={15} aria-hidden="true" />}
                  </span>
                ))}
              </div>
            )}
          </section>

          {itin.length > 0 && (
            <section className="tdx-block">
              <h2>Day-by-day itinerary</h2>
              <PackageItinerary items={itin} />
            </section>
          )}

          <section className="tdx-block">
            <h2>What's included</h2>
            <div className="tdx-incl">
              <ul className="tdx-incl-yes">
                {(pkg.included || []).map((item) => <li key={item}><Check size={16} />{item}</li>)}
                {!(pkg.included || []).length && <li className="muted-line">Details on request.</li>}
              </ul>
              <ul className="tdx-incl-no">
                {(pkg.notIncluded || []).map((item) => <li key={item}><X size={15} />{item}</li>)}
                {!(pkg.notIncluded || []).length && <li className="muted-line">—</li>}
              </ul>
            </div>
          </section>

          <TourExtras product={pkg} />
        </div>

        <aside className="tdx-aside">
          <div className="tdx-booking">
            <LiveSharedPrice
              currentSeats={currentSeats}
              goAhead={goAhead}
              maxSeats={selectedDeparture?.maxSeats || goAhead}
              headlinePrice={projectedBase}
              nowPrice={basePrice}
              bestPrice={breakBase}
            />
            <p className="lsp-tier-note">Shared rate shown per person. Your hotel &amp; cruise tier and any single supplement are added on top — see the total below.</p>
            <form className="public-booking-form" onSubmit={submitPublicBooking} noValidate>
              <div className="field">
                <label htmlFor="pk-date">Start date</label>
                <select id="pk-date" value={selectedDepartureId} onChange={(event) => setSelectedDepartureId(event.target.value)}>
                  {pkg.dates.map((d) => {
                    const seats = seatsTotal(d.pledges);
                    return (
                      <option key={d.id} value={d.id}>
                        {formatRange(d.startDate || d.date, d.endDate)} · {seats}/{goAheadFor(d)} seats
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pk-tier">Hotel &amp; cruise tier</label>
                <select
                  id="pk-tier"
                  value={tierId}
                  onChange={(event) => {
                    setTierId(event.target.value);
                    if (errors.tier) setErrors((e) => ({ ...e, tier: undefined }));
                  }}
                  aria-invalid={errors.tier ? "true" : "false"}
                  className={errors.tier ? "input-error" : ""}
                >
                  {tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.perPersonSupplement ? ` (+$${t.perPersonSupplement}/pp)` : ""}
                    </option>
                  ))}
                </select>
                {errors.tier && <span className="field-error" role="alert">{errors.tier}</span>}
              </div>
              <div className="field">
                <label htmlFor="pk-room">Room type</label>
                <select id="pk-room" value={roomingType} onChange={(event) => setRoomingType(event.target.value)}>
                  <option value="single">Single (supplement applies)</option>
                  <option value="double">Double / twin</option>
                  <option value="triple">Triple</option>
                </select>
              </div>
              <div className="tdx-frow">
                <div className="field tdx-fname">
                  <label htmlFor="pk-name">Your name</label>
                  <input
                    id="pk-name"
                    value={travelerName}
                    onChange={(event) => {
                      setTravelerName(event.target.value);
                      if (errors.name) setErrors((e) => ({ ...e, name: undefined }));
                    }}
                    placeholder="e.g. Tarek El-Sharkawy"
                    aria-invalid={errors.name ? "true" : "false"}
                    className={errors.name ? "input-error" : ""}
                  />
                  {errors.name && <span className="field-error" role="alert">{errors.name}</span>}
                </div>
                <div className="field tdx-fseats">
                  <label htmlFor="pk-seats">Travelers</label>
                  <input
                    id="pk-seats"
                    min="1"
                    max={Math.max(1, remainingSeats)}
                    type="number"
                    value={travelerSeats}
                    onChange={(event) => {
                      setTravelerSeats(event.target.value);
                      if (errors.seats) setErrors((e) => ({ ...e, seats: undefined }));
                    }}
                    aria-invalid={errors.seats ? "true" : "false"}
                    className={errors.seats ? "input-error" : ""}
                    disabled={soldOut}
                  />
                  {errors.seats && <span className="field-error" role="alert">{errors.seats}</span>}
                </div>
              </div>
              <div className="tdx-frow">
                <div className="field">
                  <label htmlFor="pk-email">Email <span className="field-opt">(optional)</span></label>
                  <input
                    id="pk-email"
                    type="email"
                    value={travelerEmail}
                    onChange={(event) => {
                      setTravelerEmail(event.target.value);
                      if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
                    }}
                    placeholder="you@email.com"
                    aria-invalid={errors.email ? "true" : "false"}
                    className={errors.email ? "input-error" : ""}
                  />
                  {errors.email && <span className="field-error" role="alert">{errors.email}</span>}
                </div>
                <div className="field">
                  <label htmlFor="pk-phone">Phone <span className="field-opt">(optional)</span></label>
                  <input id="pk-phone" type="tel" value={travelerPhone} onChange={(e) => setTravelerPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
                </div>
              </div>
              <div className="deposit-summary tdx-deposit">
                <div><span>Total</span><strong>${bookingTotal}</strong></div>
                <div><span>Deposit today</span><strong>${depositDue}</strong></div>
                <div><span>Balance</span><strong>${balanceDue}</strong></div>
                <p>{depositPercentValue}% confirms the reservation · balance due {selectedDeparture ? balanceDueDate(selectedDeparture.startDate || selectedDeparture.date) : "before departure"}.</p>
              </div>
              <button className="primary full" disabled={isSaving || !selectedDeparture || soldOut} type="submit">
                {isSaving ? "Updating seats..." : soldOut ? "Departure full" : "Join this package"}
              </button>
            </form>
            {publicBooking && Number(publicBooking.departureId) === Number(selectedDeparture?.id) && (
              <div className="booking-receipt">
                <strong>Request added: {publicBooking.code}</strong>
                <p>{publicBooking.seats} traveler{publicBooking.seats > 1 ? "s" : ""} · {publicBooking.tierName || "Standard"} · {publicBooking.roomingType || "double"} room</p>
                {publicBooking.depositDue && (
                  <p>${publicBooking.depositDue} deposit due now · ${publicBooking.balanceDue} balance due {publicBooking.balanceDueDate}</p>
                )}
                <button disabled={isSaving} onClick={onCancelPublicBooking}>Cancel this request</button>
              </div>
            )}
          </div>
          <ul className="tdx-assure">
            <li><ShieldCheck size={16} />No payment until your group is confirmed</li>
            <li><Users size={16} />Small shared groups, never crowded</li>
            <li><BadgeCheck size={16} />Domestic flights, Nile cruise &amp; sightseeing included</li>
          </ul>
        </aside>
      </div>

      {leadDeparture && <LiveDepartureTimeline departure={leadDeparture} />}

      <section className="tour-calendar tdx-dates">
        <div className="tour-calendar-header">
          <div>
            <strong>Upcoming departures</strong>
            <p>Once minimum travelers are booked, the package is GoAhead.</p>
          </div>
          <span className="pill"><CalendarDays size={15} />{pkg.dates.length} departure{pkg.dates.length === 1 ? "" : "s"}</span>
        </div>
        <div className="calendar-days">
          {pkg.dates.length === 0 && <div className="empty-day">No departures published yet</div>}
          {pkg.dates.map((d) => <PackageCalendarRow departure={d} key={d.id} />)}
        </div>
      </section>
    </article>
  );
}

function LiveDepartureTimeline({ departure }) {
  const seats = seatsTotal(departure.pledges);
  const goAhead = goAheadFor(departure);
  const confidence = confidenceFor(seats, goAhead);
  const steps = [
    { label: "1 traveler joined", active: seats >= 1 },
    { label: "Group growing", active: seats >= Math.max(2, Math.floor(goAhead / 2)) },
    { label: seats >= goAhead - 1 ? "Likely to confirm" : "Waiting for momentum", active: seats >= goAhead - 1 },
    { label: "GoAhead confirmed", active: seats >= goAhead },
  ];

  return (
    <section className="signature-timeline" aria-label="Live departure timeline">
      <div>
        <p>Live departure timeline</p>
        <h2>{departure.route}</h2>
        <span>{departure.city} · {isPackage(departure) ? formatRange(departure.startDate || departure.date, departure.endDate) : formatDate(departure.date)} · {confidence.label}</span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li className={step.active ? "active" : ""} key={step.label}>
            <b>{index + 1}</b>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </section>
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
            <button><ShieldCheck size={16} />Verified</button>
            <button><ChevronDown size={16} />Seats needed</button>
          </div>

          <div className="departure-list">
            {filtered.map((departure) => {
              const seats = seatsTotal(departure.pledges);
              const ga = goAheadFor(departure);
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
                      <span className={seats >= ga ? "status ok" : "status"}>{statusFor(departure)}</span>
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
            <span className={isConfirmed ? "status ok" : "status"}>{statusFor(selected)}</span>
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

function AdminDesk({
  confirmDeparture, isSaving, scheduleAdminDeparture, scheduleDate, scheduleProductId, setScheduleDate, setScheduleProductId,
  schedulePackageDeparture, schedulePackageId, setSchedulePackageId, schedulePackageDate, setSchedulePackageDate,
  updateProductPricing, visibleDepartures, dayTourProducts, packageProducts,
}) {
  return (
    <section className="admin-grid">
      <div className="panel">
        <div className="panel-header">
          <div><h2>Day tour products</h2><p>Fixed day-tour products agencies and customers can trust.</p></div>
          <Sparkles size={20} />
        </div>
        <div className="product-list">
          {dayTourProducts.map((product) => (
            <article className="product-card" key={product.id}>
              <div><strong>{product.title}</strong><p>{product.description}</p></div>
              <div className="product-meta">
                <span>{product.duration}</span>
                <span>GoAhead ${product.publishedRate}</span>
                <span>Break ${product.breakPrice}</span>
                <span>min {product.minSeats}</span>
                <span>{product.depositPercent || 10}% deposit</span>
              </div>
              <PricingControls isSaving={isSaving} onSave={updateProductPricing} product={product} />
            </article>
          ))}
          {dayTourProducts.length === 0 && <p className="empty-day">No day tours in this city.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div><h2>Publish day tour date</h2><p>Make a popular day tour available for agencies to add clients.</p></div>
          <CalendarDays size={20} />
        </div>
        <form className="join-form" onSubmit={scheduleAdminDeparture}>
          <label>
            Tour product
            <select value={scheduleProductId} onChange={(event) => setScheduleProductId(event.target.value)}>
              {dayTourProducts.map((product) => <option key={product.id} value={product.id}>{product.title}</option>)}
            </select>
          </label>
          <label>
            Date
            <input type="date" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} />
          </label>
          <button className="primary full" type="submit" disabled={isSaving || !dayTourProducts.length}><Plus size={18} />{isSaving ? "Saving..." : "Publish date"}</button>
        </form>
      </div>

      <div className="panel admin-wide">
        <div className="panel-header">
          <div><h2>Multi-day packages</h2><p>Multi-city itineraries with hotels and inter-city transport.</p></div>
          <Package size={20} />
        </div>
        <div className="product-list">
          {packageProducts.map((product) => (
            <article className="product-card package-card" key={product.id}>
              <div>
                <strong><span className="type-badge"><Package size={11} />Package</span> {product.title}</strong>
                <p>{product.description}</p>
                <p className="package-sub">{(product.cities || [product.city]).join(" → ")} · {product.duration} · min {product.minSeats}</p>
              </div>
              <div className="product-meta">
                <span>From ${product.publishedRate}/pp</span>
                <span>Break ${product.breakPrice}/pp</span>
                <span>{(product.accommodationTiers || []).length} tiers</span>
                <span>{product.depositPercent || 20}% deposit</span>
              </div>
              {(product.accommodationTiers || []).length > 0 && (
                <div className="tier-strip">
                  {product.accommodationTiers.map((t) => (
                    <span key={t.id}><Hotel size={12} />{t.name} (+${t.perPersonSupplement || 0}/pp · single +${t.singleSupplement || 0})</span>
                  ))}
                </div>
              )}
              <PricingControls isSaving={isSaving} onSave={updateProductPricing} product={product} />
            </article>
          ))}
          {packageProducts.length === 0 && <p className="empty-day">No packages in this city yet. Add one in db.json or via the API.</p>}
        </div>
        <form className="join-form package-publish" onSubmit={schedulePackageDeparture}>
          <label>
            Package
            <select value={schedulePackageId} onChange={(event) => setSchedulePackageId(event.target.value)}>
              {packageProducts.map((product) => <option key={product.id} value={product.id}>{product.title}</option>)}
            </select>
          </label>
          <label>
            Start date
            <input type="date" value={schedulePackageDate} onChange={(event) => setSchedulePackageDate(event.target.value)} />
          </label>
          <button className="primary full" type="submit" disabled={isSaving || !packageProducts.length}><Plus size={18} />{isSaving ? "Saving..." : "Publish package date"}</button>
        </form>
      </div>

      <div className="panel admin-wide">
        <div className="panel-header">
          <div><h2>Go-ahead queue</h2><p>Confirm transport, hotels, and guide when enough travelers have booked.</p></div>
          <BadgeCheck size={20} />
        </div>
        <div className="admin-queue">
          {visibleDepartures.map((departure) => {
            const seats = seatsTotal(departure.pledges);
            const ga = goAheadFor(departure);
            const ready = seats >= ga;
            const dIsPackage = isPackage(departure);
            return (
              <div className="queue-row" key={departure.id}>
                <div>
                  <strong>
                    {dIsPackage && <span className="type-badge"><Package size={11} />Package</span>}
                    {departure.route}
                  </strong>
                  <p>
                    {dIsPackage
                      ? `${formatRange(departure.startDate || departure.date, departure.endDate)} · ${seats}/${ga} seats`
                      : `${formatDate(departure.date)} at ${departure.time} · ${seats}/${ga} seats`}
                  </p>
                </div>
                <span className={departure.status === "supplier_confirmed" ? "status ok" : ready ? "status ok" : "status"}>
                  {departure.status === "supplier_confirmed" ? "Go-ahead" : ready ? "Ready to confirm" : "Pending demand"}
                </span>
                <button className="primary" disabled={!ready || departure.status === "supplier_confirmed" || isSaving} onClick={() => confirmDeparture(departure.id)}>
                  <Check size={18} />Confirm
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PricingControls({ isSaving, onSave, product }) {
  const [publishedRate, setPublishedRate] = useState(product.publishedRate);
  const [breakPrice, setBreakPrice] = useState(product.breakPrice || Math.round(product.publishedRate * 0.8));

  useEffect(() => {
    setPublishedRate(product.publishedRate);
    setBreakPrice(product.breakPrice || Math.round(product.publishedRate * 0.8));
  }, [product.breakPrice, product.publishedRate]);

  function savePricing(event) {
    event.preventDefault();
    onSave(product.id, {
      publishedRate: Number(publishedRate),
      breakPrice: Number(breakPrice),
    });
  }

  return (
    <form className="pricing-controls" onSubmit={savePricing}>
      <label>
        GoAhead price
        <input min="1" type="number" value={publishedRate} onChange={(event) => setPublishedRate(event.target.value)} />
      </label>
      <label>
        Max break price
        <input min="1" max={publishedRate} type="number" value={breakPrice} onChange={(event) => setBreakPrice(event.target.value)} />
      </label>
      <button className="primary" disabled={isSaving} type="submit">
        <CircleDollarSign size={17} />Save pricing
      </button>
    </form>
  );
}

function CityControls({ cityStats, departures, selectedCity, setSelectedCity }) {
  return (
    <>
      <section className="city-bar" aria-label="City filter">
        <button className={selectedCity === "All cities" ? "active" : ""} onClick={() => setSelectedCity("All cities")}>
          <MapPin size={17} /><span>All cities</span><b>{departures.length}</b>
        </button>
        {cityStats.map((city) => (
          <button className={selectedCity === city.name ? "active" : ""} key={city.name} onClick={() => setSelectedCity(city.name)}>
            <MapPin size={17} /><span>{city.name}</span><b>{city.departures}</b>
          </button>
        ))}
      </section>
      <section className="city-overview" aria-label="City overview">
        {cityStats.map((city) => (
          <button className={selectedCity === city.name ? "city-card active" : "city-card"} key={city.name} onClick={() => setSelectedCity(city.name)}>
            <strong>{city.name}</strong>
            <span>{city.products} tours</span>
            <span>{city.departures} dates</span>
            <span>{city.seats} seats</span>
            <b>{city.goAhead} GoAhead</b>
          </button>
        ))}
      </section>
    </>
  );
}

function CalendarDay({ departure }) {
  const seats = seatsTotal(departure.pledges);
  const goAhead = goAheadFor(departure);
  const goAheadHit = departure.status === "supplier_confirmed" || seats >= goAhead;
  const day = new Date(departure.date);
  const price = livePriceFor(departure, seats);

  return (
    <button className={`calendar-day ${goAheadHit ? "go" : ""}`}>
      <span>{new Intl.DateTimeFormat("en", { weekday: "short" }).format(day)}</span>
      <strong>{new Intl.DateTimeFormat("en", { day: "2-digit" }).format(day)}</strong>
      <small>{new Intl.DateTimeFormat("en", { month: "short" }).format(day)} · {departure.time}</small>
      <b>{seats} booked</b>
      <b>${price} live price</b>
      <em>{goAheadHit ? "GoAhead" : `${goAhead - seats} to go`}</em>
    </button>
  );
}

function PackageCalendarRow({ departure }) {
  const seats = seatsTotal(departure.pledges);
  const goAhead = goAheadFor(departure);
  const goAheadHit = departure.status === "supplier_confirmed" || seats >= goAhead;
  const price = livePriceFor(departure, seats);

  return (
    <button className={`calendar-day package-day ${goAheadHit ? "go" : ""}`}>
      <span>{formatRange(departure.startDate || departure.date, departure.endDate)}</span>
      <strong>{departure.nights || "—"} nights</strong>
      <b>{seats}/{goAhead} booked</b>
      <b>from ${price}/pp</b>
      <em>{goAheadHit ? "GoAhead" : `${goAhead - seats} to go`}</em>
    </button>
  );
}

function SummaryBox({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <div className="metric">
      <Icon size={22} />
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
