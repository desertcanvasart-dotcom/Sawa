// Pure business rules: pricing, status, deposits. No DB, no HTTP — easy to test.
export const DEFAULT_GO_AHEAD = 4;
export const DEFAULT_DAY_TOUR_DEPOSIT = 10;
export const DEFAULT_PACKAGE_DEPOSIT = 20;

export function isPackage(item) {
  return item && item.type === "package";
}

export function goAheadSeatsFor(item) {
  return Math.max(1, Number(item?.minSeats || item?.min_seats || DEFAULT_GO_AHEAD));
}

export function defaultDepositFor(item) {
  return isPackage(item) ? DEFAULT_PACKAGE_DEPOSIT : DEFAULT_DAY_TOUR_DEPOSIT;
}

export function seatsTotal(pledges = []) {
  // Cancelled pledges no longer hold their seats, so they must not count toward
  // capacity, live pricing, or the go-ahead threshold.
  return pledges.reduce((sum, p) => (p?.status === "cancelled" ? sum : sum + Number(p.seats || 0)), 0);
}

function clampPrice(value, fallback) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

export function livePriceFor(item, seats) {
  const goAhead = goAheadSeatsFor(item);
  const startPrice = clampPrice(item.publishedRate, 80);
  const breakPrice = Math.min(startPrice, clampPrice(item.breakPrice, Math.round(startPrice * 0.8)));
  const maxSeats = Math.max(Number(item.maxSeats || goAhead), goAhead);
  const effectiveSeats = Math.min(maxSeats, Math.max(goAhead, Number(seats || 0)));
  const steps = Math.max(1, maxSeats - goAhead);
  const progress = Math.min(1, Math.max(0, effectiveSeats - goAhead) / steps);
  return Math.round(startPrice - (startPrice - breakPrice) * progress);
}

export function statusFor(departure, pledges) {
  if (["supplier_confirmed", "closed", "cancelled"].includes(departure.status)) {
    return departure.status;
  }
  return seatsTotal(pledges) >= goAheadSeatsFor(departure) ? "minimum_reached" : "open";
}

export function findTier(product, tierId) {
  const tiers = product?.accommodationTiers || [];
  return tiers.find((t) => t.id === tierId) || tiers[0] || null;
}

// Package price = seat-based shared rate + per-person tier supplement
// + single supplement (only when rooming is "single").
export function packagePriceFor(product, departure, seats, { roomingType = "double", tierId } = {}) {
  const base = livePriceFor(departure || product, seats);
  const tier = findTier(product, tierId);
  const tierSupplement = Number(tier?.perPersonSupplement || 0);
  const singleSupplement = roomingType === "single" ? Number(tier?.singleSupplement || 0) : 0;
  return Math.round(base + tierSupplement + singleSupplement);
}

export function balanceDueDate(date) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Adds the computed livePrice + normalised fields to a departure for responses.
export function enrichDeparture(departure) {
  const seats = seatsTotal(departure.pledges);
  return {
    ...departure,
    type: departure.type || "day_tour",
    breakPrice: clampPrice(departure.breakPrice, Math.round(clampPrice(departure.publishedRate, 80) * 0.8)),
    depositPercent: Number(departure.depositPercent || defaultDepositFor(departure)),
    livePrice: livePriceFor(departure, seats),
    status: statusFor(departure, departure.pledges),
  };
}

// Booking cutoff: returns true if bookings are CLOSED for this departure now.
// cutoffHours comes from the tour product (default 24). nowMs lets tests inject time.
export function bookingClosed(departure, product, nowMs = Date.now()) {
  const startStr = departure.startDate || departure.date;
  if (!startStr) return false;
  const cutoffHours = Number(product?.bookingCutoffHours ?? 24);
  const time = departure.time && /^\d{2}:\d{2}/.test(departure.time) ? departure.time : "08:00";
  const start = new Date(`${startStr}T${time}:00`);
  if (isNaN(start)) return false;
  const deadline = start.getTime() - cutoffHours * 3600 * 1000;
  return nowMs > deadline;
}

// Compute the pricing block for a new pledge.
export function computePledgePricing(departure, product, { seats, roomingType, accommodationTier }) {
  const projectedSeats = seatsTotal(departure.pledges) + Number(seats || 1);
  const depositPercent = Number(departure.depositPercent || defaultDepositFor(departure));
  let pricePerPerson;
  let extra = {};
  if (isPackage(departure)) {
    const rooming = ["single", "double", "triple"].includes(roomingType) ? roomingType : "double";
    const tier = findTier(product, accommodationTier);
    pricePerPerson = packagePriceFor(product, departure, projectedSeats, { roomingType: rooming, tierId: tier?.id });
    extra = { roomingType: rooming, accommodationTier: tier?.id || null, accommodationTierName: tier?.name || null };
  } else {
    pricePerPerson = livePriceFor(departure, projectedSeats);
  }
  const bookingTotal = pricePerPerson * Number(seats);
  const depositDue = Math.ceil(bookingTotal * (depositPercent / 100));
  return {
    pricePerPerson,
    bookingTotal,
    depositPercent,
    depositDue,
    balanceDue: bookingTotal - depositDue,
    balanceDueDate: balanceDueDate(departure.startDate || departure.date),
    ...extra,
  };
}
