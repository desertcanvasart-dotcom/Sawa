// Tour and departure helpers the public pages share: copy, dates, prices, seat states, the cancellation schedule and the payment timeline
//
// Moved out of src/main.jsx verbatim (12 Nov 2026), as part of splitting that
// file. Nothing here was rewritten; the names other files use are exported at
// the bottom.
import React from "react";
import { DEFAULT_GO_AHEAD } from "../shared/group-size.js";
import { livePriceFor } from "../shared/pricing.js";
import { seatsTotal, goAheadSeatsFor, isGoAheadDeparture } from "../shared/departure-state.js";
import {
  balanceDueDate,
  cancellationBandsFor,
  CANCELLATION_BEFORE_GOAHEAD,
  CANCELLATION_CAP,
  CANCELLATION_COLUMNS,
  chargeText,
  CANCELLATION_QUALIFIER,
} from "../shared/booking-policy.js";
import { toDate } from "./dates.js";
// DIR-17.1 — one owner for the support-availability string. This file held
// three of the four variants that were live, including the only one that
// contradicted the others outright ("9am - 9pm Cairo time" against "24/7").
import { INTERIM_COPY } from "../shared/site-copy.js";

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

// Stops for a route line. The curated map above only knows the original demo
// ids; every later product fell through to `[city, title]`, which rendered the
// full tour title as if it were a stop — directly under a heading that already
// says it. Production titles carry their stop list after an em-dash ("Aswan
// Highlights — Unfinished Obelisk, High Dam & Philae"), so use that when it
// yields at least two stops; otherwise return null and let the caller drop the
// row rather than invent one.
function routeStopsFor(product) {
  // Recorded itinerary first — real data beats every heuristic below the
  // moment a product carries it (today none do; the catalogue's itineraries
  // live in prose and have not been loaded onto the products).
  const itin = (product.itinerary || [])
    .filter((leg) => leg && leg.kind !== "transit") // sites, not the drives between them
    .map((leg) => (leg.title || "").trim()).filter(Boolean);
  if (itin.length >= 2) return itin;
  if (routeStops[product.id]) return routeStops[product.id];
  const m = /—(.+)$/.exec(product.title || "");
  if (m) {
    const stops = m[1].split(/[,&]/).map((s) => s.trim()).filter(Boolean);
    if (stops.length >= 2) return stops;
  }
  return null;
}

// NN2.1 kept `goAheadSeatsFor` under a local alias `goAheadFor`, because this
// file already used that name everywhere. The alias is gone: a second name for
// one function is a second thing to grep for, and `grep goAheadSeatsFor` should
// find every place the threshold is read. Same reason the `slugify` alias went.
//
// The original finding stands and is why the alias existed at all: the local
// copy read `minSeats` only, where the authority also accepts a raw `min_seats`
// row straight from the database.

// `confirmed` is the date's own state (isGoAheadDeparture), not a recount: a
// date that reached GoAhead stays confirmed when a traveller later leaves.
function confidenceFor(seats, goAhead = DEFAULT_GO_AHEAD, confirmed = false) {
  if (confirmed) return { label: "GoAhead confirmed", tone: "go" };
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

// The arithmetic is shared/booking-policy.js; this only formats it. The two
// used to be one function declared twice under the same name, returning an ISO
// date on the server and a formatted string here — a collision, not a copy.
function balanceDueLabel(date, item) {
  const due = balanceDueDate(date, item);
  return due ? formatDate(due, { alwaysYear: true }) : formatDate(date, { alwaysYear: true });
}

// The sidebar used to show a deposit figure directly above an enabled "Reserve
// a seat" button, which reads as "you are about to be charged". Terms are
// explicit that the deposit only falls due once the departure reaches GoAhead
// and the booking is confirmed, so every surface that quotes a deposit shows
// this alongside it: the four steps, in order, with the charge point named.
// The cancellation schedule, beside the price a traveller is about to commit to.
//
// Terms §13.2 binds the default schedule only where it was "displayed before you
// reserve". It was displayed nowhere, so the clause was asserting a disclosure
// the build did not make; this is that disclosure.
//
// A <details> rather than an always-open table, and the summary carries the part
// that applies to almost everyone who ever cancels — before GoAhead it is free.
// The bands only ever bite after a date confirms, and burying the free case
// under three fee rows would misdescribe the offer at the exact moment someone
// is deciding. Closed by default, one click, and no numbers invented here: every
// value comes from shared/booking-policy.js, which terms.html is checked
// against.
function CancellationSchedule({ tour, depositPct }) {
  // Per type, because the two schedules genuinely differ: a day tour is free
  // until 48 hours out and a package until 30 days, and the deposits they are
  // charged against are 10% and 25%. Both come from the same authority as the
  // deposit the traveller sees two lines above, so the table cannot quote a
  // percentage the booking summary contradicts.
  // The bands come from the type; the PERCENTAGE comes from the booking summary
  // three lines above, not from the type default.
  //
  // They are not always the same number. `deposit_percent` is captured on the
  // departure, so a package published before the rate moved to 25% still quotes
  // 20% — correctly, because that is what its travellers were told. Deriving the
  // table from the type instead put "Deposit retained (25% of the Tour Price)"
  // directly beneath "Deposit at GoAhead (20%)", on one panel, in one glance.
  const bands = cancellationBandsFor(tour);
  return (
    <details className="bk-policy">
      <summary>Canceling: free before GoAhead</summary>
      <p>{CANCELLATION_BEFORE_GOAHEAD}</p>
      {/* The cap first. It is the good news, and it is what a reader needs
          before a table of dates: the exposure is the deposit, never the
          Tour Price. */}
      <p><b>{CANCELLATION_CAP}</b></p>
      <p>If you cancel <b>after</b> GoAhead:</p>
      <table>
        <thead>
          <tr><th>{CANCELLATION_COLUMNS.when}</th><th>{CANCELLATION_COLUMNS.charge}</th></tr>
        </thead>
        <tbody>
          {bands.map((b) => (
            <tr key={b.when}><td>{b.when}</td><td>{chargeText(b, depositPct)}</td></tr>
          ))}
        </tbody>
      </table>
      <p>{CANCELLATION_QUALIFIER} <a href="/terms">Full terms</a>.</p>
    </details>
  );
}

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
  if (isGoAheadDeparture(departure)) return "GoAhead";
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

const SUPPORT_AVAILABILITY = INTERIM_COPY["support-availability"];

export {
  SUPPORT_AVAILABILITY,
  articles, destinationCopy, routeStops, routeStopsFor, confidenceFor, pluralize, formingLabel, needsYear,
  formatDate, formatRange, rateFor, coverImage, departureFull, productFullyBooked, todayIso, departurePast,
  openDates, packagePriceFor, depositFor, balanceDueLabel, CancellationSchedule, PaymentTimeline,
  departureStatusLabel, BOOTSTRAP_TIMEOUT_MS, DetailPending,
};
