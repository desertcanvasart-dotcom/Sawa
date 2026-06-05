import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Filter,
  Handshake,
  Hotel,
  MapPin,
  MessageCircle,
  Package,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import "./styles.css";
import { supabase, apiFetch, API_BASE } from "./supabaseClient";
import { LoginGate } from "./LoginGate";
import { AdminDashboard } from "./AdminDashboard";
import { AgencyDashboard } from "./AgencyDashboard";

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
    image: "https://images.unsplash.com/photo-1539650116574-75c0c6d73f6e?auto=format&fit=crop&w=900&q=80",
  },
  Luxor: {
    tags: "Temples · Tombs · Nile",
    image: "https://images.unsplash.com/photo-1601581875309-fafbf2d3ed3a?auto=format&fit=crop&w=900&q=80",
  },
  Aswan: {
    tags: "Islands · Nubian culture · Philae",
    image: "https://images.unsplash.com/photo-1568322445389-f64ac2515020?auto=format&fit=crop&w=900&q=80",
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
    return (
      <main className="loading-screen">
        <div className="brand-mark">S</div>
        <strong>Loading Sawa shared tour desk...</strong>
      </main>
    );
  }

  const isPortalRoute = path.startsWith("/admin") || path.startsWith("/agency") || path.startsWith("/portal");

  if (!isPortalRoute) {
    return (
      <PublicSite
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

function PublicSite({
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

  return (
    <main className="public-shell">
      <PublicNav navigate={navigate} />
      <section className={showDetail ? "public-hero" : "public-hero hero-soft"}>
        {!showDetail ? (
          <div className="hero-soft-grid">
            <div className="hero-soft-copy">
              <p className="hero-pill">
                <span className="live-dot" aria-hidden="true" />
                {customerSummary.dates} live departures this week
              </p>
              <h1>Egypt tours that actually run.</h1>
              <span>Shared day tours and multi-day packages across Cairo, Luxor, and Aswan — with live seat counts, so you know your date is going before you pay.</span>

              <form
                className="hero-search-bar"
                onSubmit={(event) => {
                  event.preventDefault();
                  document.getElementById("live-departures")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
                src="https://images.unsplash.com/photo-1539650116574-75c0c6d73f6e?auto=format&fit=crop&w=1100&q=82"
                alt="Pyramids of Giza at golden hour, near Cairo"
                loading="eager"
              />
              <div className="hero-media-chip">
                <span className="hero-chip-dot" aria-hidden="true" />
                <div>
                  <strong>{customerSummary.goAheadDates} groups going ahead</strong>
                  <span>Confirmed — guide &amp; transport booked</span>
                </div>
              </div>
              <div className="hero-media-badge">
                <BadgeCheck size={16} />
                No payment until your date confirms
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

            <section className="reviews-soft reveal" id="reviews">
              <div className="reviews-soft-head">
                <div>
                  <p className="reviews-kicker">After the tour ran</p>
                  <h2>Travellers who actually went.</h2>
                </div>
                <div className="reviews-rating">
                  <span className="reviews-rating-num">4.9</span>
                  <span className="reviews-rating-stars" aria-label="4.9 out of 5">★★★★★</span>
                  <span className="reviews-rating-meta">from 312 confirmed travellers</span>
                </div>
              </div>
              <div className="reviews-wall">
                {reviews.map((review, i) => (
                  <article className={i === 0 ? "review-soft-card is-featured" : "review-soft-card"} key={review.name}>
                    <div className="review-stars" aria-label="5 out of 5">★★★★★</div>
                    <p>“{review.text}”</p>
                    <div className="review-by">
                      <div className="review-avatar" aria-hidden="true">{review.name[0]}</div>
                      <div>
                        <strong>{review.name}</strong>
                        <span>{review.location} · {review.trip}</span>
                      </div>
                    </div>
                  </article>
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

function PublicNav({ navigate }) {
  return (
    <header className="public-nav">
      <button className="public-brand" onClick={() => navigate("/")}>
        <span className="brand-mark">S</span>
        <strong>Sawa Tours</strong>
      </button>
      <nav>
        <a href="/#live-departures">Tours</a>
        <a href="/#how-it-works">How it works</a>
        <a href="/#reviews">Reviews</a>
        <a href="/#blog">Notes</a>
      </nav>
      <button className="nav-cta" onClick={() => scrollToBooking(navigate)}>
        Book now
        <span className="nav-cta-icon"><ArrowRight size={15} /></span>
      </button>
    </header>
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
    <footer className="footer-min">
      <button className="footer-min-brand" onClick={() => navigate("/")}>
        <span className="brand-mark">S</span>
        <strong>Sawa Tours</strong>
      </button>

      <p className="footer-min-tag">Egypt tours that actually run.</p>

      <button className="footer-min-cta" onClick={() => scrollToBooking(navigate)}>
        Book now
        <span className="footer-min-arrow"><ArrowRight size={16} /></span>
      </button>

      <nav className="footer-min-links">
        <a href="/#live-departures">Tours</a>
        <a href="/#how-it-works">How it works</a>
        <a href="/#reviews">Reviews</a>
        <a href="https://wa.me/201092847613" target="_blank" rel="noreferrer">WhatsApp</a>
      </nav>

      <div className="footer-min-legal">
        <span>© {new Date().getFullYear()} Sawa Tours · Licensed in Cairo</span>
        <span className="footer-min-dot" aria-hidden="true">·</span>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <button className="footer-agency-link" onClick={() => navigate("/agency")}>Agency login</button>
      </div>
    </footer>
  );
}

// Renders trusted admin-authored HTML (TipTap output), or plain-text fallback.
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
  if (!product.meetingPoint && !product.pickupNote && !bring.length && !hasPolicy) return null;
  return (
    <div className="tour-extras">
      {(product.meetingPoint || product.pickupNote) && (
        <div className="extra-block">
          <h3><MapPin size={16} />Meeting & pickup</h3>
          {product.meetingPoint && <p>{product.meetingPoint}</p>}
          {product.pickupNote && <p className="muted-line">{product.pickupNote}</p>}
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
    <article className="tour-detail-page">
      <button className="back-button" onClick={() => navigate("/")}>
        <ArrowLeft size={18} />All tours
      </button>

      <Gallery product={tour} />

      <section className="tour-detail-grid">
        <div className="panel tour-detail-main">
          <div className="tour-calendar-header">
            <div>
              <strong>{tour.title}</strong>
              <p>{tour.city} · {tour.duration} · {tour.guide}</p>
            </div>
            <span className="price-pill">from ${currentPrice}</span>
          </div>

          <RichBlock html={tour.overviewHtml} fallback={tour.description} />

          <div className="included-grid">
            <div>
              <h3>What's included</h3>
              {(tour.included || []).map((item) => <p key={item}><Check size={16} />{item}</p>)}
              {!(tour.included || []).length && <p className="muted-line">Details on request.</p>}
            </div>
            <div>
              <h3>Not included</h3>
              {(tour.notIncluded || []).map((item) => <p key={item}><ChevronDown size={16} />{item}</p>)}
              {!(tour.notIncluded || []).length && <p className="muted-line">—</p>}
            </div>
          </div>

          <TourExtras product={tour} />
        </div>

        <aside className="panel booking-panel">
          <span>Live shared price</span>
          <strong>${projectedPrice}</strong>
          <p>Choose a date. If your seats make the group larger, the price drops automatically for this reservation.</p>
          <div className="price-ladder">
            <div><span>At {goAhead} seats</span><strong>${safePrice(tour.publishedRate, currentPrice)}</strong></div>
            <div><span>Current</span><strong>${currentPrice}</strong></div>
            <div><span>Break price</span><strong>${breakPrice}</strong></div>
          </div>
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
            <div className="field">
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
              {errors.name
                ? <span className="field-error" role="alert">{errors.name}</span>
                : <span className="field-hint">Who should we put the lead booking under?</span>}
            </div>
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
              {errors.email
                ? <span className="field-error" role="alert">{errors.email}</span>
                : <span className="field-hint">We'll email your booking confirmation here.</span>}
            </div>
            <div className="field">
              <label htmlFor="td-phone">Phone / WhatsApp <span className="field-opt">(optional)</span></label>
              <input id="td-phone" type="tel" value={travelerPhone} onChange={(e) => setTravelerPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
            </div>
            <div className="field">
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
              {errors.seats
                ? <span className="field-error" role="alert">{errors.seats}</span>
                : <span className="field-hint">{soldOut ? "This date is fully booked." : `${remainingSeats} seat${remainingSeats === 1 ? "" : "s"} left on this date.`}</span>}
            </div>
            <div className="deposit-summary">
              <div><span>Deposit today</span><strong>${depositDue}</strong></div>
              <div><span>Balance</span><strong>${balanceDue}</strong></div>
              <p>{depositPercentValue}% deposit confirms the reservation. The balance is due {selectedDeparture ? balanceDueDate(selectedDeparture.date) : "one day before departure"}.</p>
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
        </aside>
      </section>

      {leadDeparture && <LiveDepartureTimeline departure={leadDeparture} />}

      <section className="tour-calendar">
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
    <article className="tour-detail-page">
      <button className="back-button" onClick={() => navigate("/")}>
        <ArrowLeft size={18} />All tours
      </button>

      <Gallery product={pkg} />

      <section className="tour-detail-grid">
        <div className="panel tour-detail-main">
          <div className="tour-calendar-header">
            <div>
              <strong>{pkg.title}</strong>
              <p>{(pkg.cities || [pkg.city]).join(" → ")} · {pkg.duration} · {pkg.guide}</p>
            </div>
            <span className="price-pill">from ${pricePerPerson}/person</span>
          </div>

          <RichBlock html={pkg.overviewHtml} fallback={pkg.description} />

          <div className="itinerary-block">
            <h3>Day-by-day itinerary</h3>
            <ol className="itinerary-list">
              {(pkg.itinerary || []).map((day, i) => (
                <li key={day.day || i}>
                  <div className="itinerary-day">Day {day.day || i + 1} · {day.city}</div>
                  <strong>{day.title}</strong>
                  {day.description && /<\w+/.test(day.description)
                    ? <div className="rich" dangerouslySetInnerHTML={{ __html: day.description }} />
                    : <p>{day.description}</p>}
                  <small>Meals: {day.meals || "—"}</small>
                </li>
              ))}
            </ol>
          </div>

          <div className="included-grid">
            <div>
              <h3>What's included</h3>
              {(pkg.included || []).map((item) => <p key={item}><Check size={16} />{item}</p>)}
            </div>
            <div>
              <h3>Not included</h3>
              {(pkg.notIncluded || []).map((item) => <p key={item}><ChevronDown size={16} />{item}</p>)}
            </div>
          </div>

          <TourExtras product={pkg} />
        </div>

        <aside className="panel booking-panel">
          <span>Live shared price (per person)</span>
          <strong>${pricePerPerson}</strong>
          <p>The base shared rate drops as the group grows. Hotel tier and single supplement are added on top.</p>
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
              <label htmlFor="pk-tier">Hotel tier</label>
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
                <option value="single">Single (single supplement applies)</option>
                <option value="double">Double / twin</option>
                <option value="triple">Triple</option>
              </select>
            </div>
            <div className="field">
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
              {errors.name
                ? <span className="field-error" role="alert">{errors.name}</span>
                : <span className="field-hint">Who should we put the lead booking under?</span>}
            </div>
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
              {errors.email
                ? <span className="field-error" role="alert">{errors.email}</span>
                : <span className="field-hint">We'll email your booking confirmation here.</span>}
            </div>
            <div className="field">
              <label htmlFor="pk-phone">Phone / WhatsApp <span className="field-opt">(optional)</span></label>
              <input id="pk-phone" type="tel" value={travelerPhone} onChange={(e) => setTravelerPhone(e.target.value)} placeholder="+20 1XX XXX XXXX" />
            </div>
            <div className="field">
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
              {errors.seats
                ? <span className="field-error" role="alert">{errors.seats}</span>
                : <span className="field-hint">{soldOut ? "This departure is fully booked." : `${remainingSeats} place${remainingSeats === 1 ? "" : "s"} left.`}</span>}
            </div>
            <div className="deposit-summary">
              <div><span>Booking total</span><strong>${bookingTotal}</strong></div>
              <div><span>Deposit today</span><strong>${depositDue}</strong></div>
              <div><span>Balance</span><strong>${balanceDue}</strong></div>
              <p>{depositPercentValue}% deposit confirms the reservation. Balance due {selectedDeparture ? balanceDueDate(selectedDeparture.startDate || selectedDeparture.date) : "one day before departure"}.</p>
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
        </aside>
      </section>

      {leadDeparture && <LiveDepartureTimeline departure={leadDeparture} />}

      <section className="tour-calendar">
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
