import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "db.json");
const port = Number(process.env.API_PORT || 8787);
const defaultGoAheadSeats = 4;
const defaultDayTourDeposit = 10;
const defaultPackageDeposit = 20;

function isPackage(item) {
  return item && item.type === "package";
}

function goAheadSeatsFor(item) {
  return Math.max(1, Number(item?.minSeats || defaultGoAheadSeats));
}

function defaultDepositFor(item) {
  return isPackage(item) ? defaultPackageDeposit : defaultDayTourDeposit;
}

function seatsTotal(pledges) {
  return pledges.reduce((sum, pledge) => sum + Number(pledge.seats || 0), 0);
}

function statusFor(departure) {
  if (departure.status === "supplier_confirmed" || departure.status === "closed" || departure.status === "cancelled") {
    return departure.status;
  }
  return seatsTotal(departure.pledges) >= goAheadSeatsFor(departure) ? "minimum_reached" : "open";
}

function clampPrice(value, fallback) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : fallback;
}

function livePriceFor(item, seats) {
  const goAhead = goAheadSeatsFor(item);
  const startPrice = clampPrice(item.publishedRate, 80);
  const breakPrice = Math.min(startPrice, clampPrice(item.breakPrice, Math.round(startPrice * 0.8)));
  const maxSeats = Math.max(Number(item.maxSeats || goAhead), goAhead);
  const effectiveSeats = Math.min(maxSeats, Math.max(goAhead, Number(seats || 0)));
  const steps = Math.max(1, maxSeats - goAhead);
  const progress = Math.min(1, Math.max(0, effectiveSeats - goAhead) / steps);
  return Math.round(startPrice - (startPrice - breakPrice) * progress);
}

function findTier(product, tierId) {
  const tiers = product?.accommodationTiers || [];
  return tiers.find((tier) => tier.id === tierId) || tiers[0] || null;
}

// Package price = (base shared rate × seats curve) + tier supplement (per person)
// Single supplement applies only if rooming === "single".
function packagePriceFor(product, departure, seats, { roomingType = "double", tierId } = {}) {
  const base = livePriceFor(departure || product, seats);
  const tier = findTier(product, tierId);
  const tierSupplement = Number(tier?.perPersonSupplement || 0);
  const singleSupplement = roomingType === "single" ? Number(tier?.singleSupplement || 0) : 0;
  return Math.round(base + tierSupplement + singleSupplement);
}

function balanceDueDate(date) {
  const departureDate = new Date(`${date}T12:00:00`);
  departureDate.setDate(departureDate.getDate() - 1);
  return departureDate.toISOString().slice(0, 10);
}

function enrichDeparture(departure) {
  const seats = seatsTotal(departure.pledges);
  const livePrice = livePriceFor(departure, seats);
  return {
    ...departure,
    type: departure.type || "day_tour",
    breakPrice: clampPrice(departure.breakPrice, Math.round(clampPrice(departure.publishedRate, 80) * 0.8)),
    depositPercent: Number(departure.depositPercent || defaultDepositFor(departure)),
    livePrice,
    status: statusFor(departure),
  };
}

async function readDb() {
  const raw = await readFile(dbPath, "utf8");
  const db = JSON.parse(raw);
  db.tourProducts = db.tourProducts.map((product) => ({
    ...product,
    type: product.type || "day_tour",
    breakPrice: clampPrice(product.breakPrice, Math.round(clampPrice(product.publishedRate, 80) * 0.8)),
    depositPercent: Number(product.depositPercent || defaultDepositFor(product)),
  }));
  db.departures = db.departures.map(enrichDeparture);
  return db;
}

async function writeDb(db) {
  const persisted = {
    ...db,
    departures: db.departures.map(({ livePrice, ...departure }) => departure),
  };
  await writeFile(dbPath, `${JSON.stringify(persisted, null, 2)}\n`);
}

async function parseJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  send(response, status, { error: message });
}

function nextDepartureId(departures) {
  return Math.max(100, ...departures.map((departure) => Number(departure.id))) + 1;
}

function nextPledgeId(departure) {
  return `pl_${departure.id}_${Date.now()}`;
}

function publicBookingCode() {
  return `SAWA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function pledgeFromBody(departure, product, body, { isPublic = false } = {}) {
  const projectedSeats = seatsTotal(departure.pledges) + Number(body.seats || 1);
  const seats = Number(body.seats || 1);
  const depositPercent = Number(departure.depositPercent || defaultDepositFor(departure));

  let pricePerPerson;
  let extra = {};
  if (isPackage(departure)) {
    const roomingType = ["single", "double", "triple"].includes(body.roomingType) ? body.roomingType : "double";
    const tier = findTier(product, body.accommodationTier);
    pricePerPerson = packagePriceFor(product, departure, projectedSeats, {
      roomingType,
      tierId: tier?.id,
    });
    extra = {
      roomingType,
      accommodationTier: tier?.id || null,
      accommodationTierName: tier?.name || null,
    };
  } else {
    pricePerPerson = livePriceFor(departure, projectedSeats);
  }
  const bookingTotal = pricePerPerson * seats;
  const depositDue = Math.ceil(bookingTotal * (depositPercent / 100));
  return {
    pricePerPerson,
    bookingTotal,
    depositDue,
    balanceDue: bookingTotal - depositDue,
    depositPercent,
    balanceDueDate: balanceDueDate(departure.startDate || departure.date),
    ...extra,
  };
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      const db = await readDb();
      send(response, 200, db);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/departures") {
      const body = await parseJson(request);
      const db = await readDb();
      const agency = db.agencies.find((item) => item.id === body.agencyId) || db.agencies[0];
      const minSeats = Number(body.minSeats || 4);
      const departure = {
        id: nextDepartureId(db.departures),
        type: "day_tour",
        tourProductId: body.tourProductId || null,
        route: String(body.route || "").trim(),
        date: body.date || "2026-05-25",
        time: body.time || "09:00",
        city: body.city || "Cairo",
        guide: "Verified guide",
        vehicle: "Shared vehicle",
        minSeats,
        maxSeats: Number(body.maxSeats || 12),
        baseCost: Number(body.baseCost || 280),
        publishedRate: Number(body.publishedRate || 80),
        breakPrice: Number(body.breakPrice || Math.round(Number(body.publishedRate || 80) * 0.8)),
        depositPercent: defaultDayTourDeposit,
        quality: 4.6,
        cutoff: body.cutoff || "Open until 18:00",
        status: "open",
        notes: "New pooling request. Agencies can add seats before supplier confirmation.",
        pledges: [
          {
            id: `pl_new_${Date.now()}`,
            agencyId: agency.id,
            agency: agency.name,
            seats: 1,
            customers: body.customers || "Lead request",
            createdAt: new Date().toISOString(),
          },
        ],
      };

      if (!departure.route) {
        sendError(response, 422, "Route is required.");
        return;
      }

      db.departures.unshift(departure);
      await writeDb(db);
      send(response, 201, { departure: enrichDeparture(departure) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/departures") {
      const body = await parseJson(request);
      const db = await readDb();
      const product = db.tourProducts.find((item) => item.id === body.tourProductId);
      if (!product) {
        sendError(response, 404, "Tour product not found.");
        return;
      }

      const productIsPackage = isPackage(product);
      const startDate = body.startDate || body.date || "2026-05-25";
      let endDate = body.endDate || null;
      if (productIsPackage) {
        if (!endDate && product.nights) {
          const end = new Date(`${startDate}T12:00:00`);
          end.setDate(end.getDate() + Number(product.nights));
          endDate = end.toISOString().slice(0, 10);
        }
      }

      const departure = {
        id: nextDepartureId(db.departures),
        type: product.type || "day_tour",
        tourProductId: product.id,
        route: product.title,
        date: startDate,
        startDate: productIsPackage ? startDate : undefined,
        endDate: productIsPackage ? endDate : undefined,
        nights: productIsPackage ? product.nights : undefined,
        cities: productIsPackage ? product.cities : undefined,
        time: body.time || product.defaultTime,
        city: product.city,
        guide: product.guide,
        vehicle: product.vehicle,
        minSeats: Number(body.minSeats || product.minSeats),
        maxSeats: Number(body.maxSeats || product.maxSeats),
        baseCost: Number(body.baseCost || product.baseCost),
        publishedRate: Number(body.publishedRate || product.publishedRate),
        breakPrice: Number(body.breakPrice || product.breakPrice || Math.round(product.publishedRate * 0.8)),
        depositPercent: Number(product.depositPercent || defaultDepositFor(product)),
        quality: product.quality,
        cutoff: body.cutoff || "Open until 18:00",
        status: "open",
        notes: product.description,
        pledges: [],
      };

      // Strip undefined fields
      Object.keys(departure).forEach((key) => departure[key] === undefined && delete departure[key]);

      db.departures.unshift(departure);
      await writeDb(db);
      send(response, 201, { departure: enrichDeparture(departure) });
      return;
    }

    // Admin: create or update a tour product (used by package editor)
    if (request.method === "POST" && url.pathname === "/api/admin/tour-products") {
      const body = await parseJson(request);
      const db = await readDb();
      const title = String(body.title || "").trim();
      if (!title) {
        sendError(response, 422, "Title is required.");
        return;
      }
      const type = body.type === "package" ? "package" : "day_tour";
      const id = body.id || `${type === "package" ? "pkg" : "tour"}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}_${Date.now().toString(36)}`;
      const product = {
        id,
        type,
        title,
        city: body.city || "Cairo",
        cities: type === "package" ? (body.cities || [body.city || "Cairo"]) : undefined,
        nights: type === "package" ? Number(body.nights || 3) : undefined,
        duration: body.duration || (type === "package" ? `${Number(body.nights || 3) + 1} days · ${body.nights || 3} nights` : "4 hours"),
        defaultTime: body.defaultTime || "08:00",
        guide: body.guide || "Licensed Egyptologist",
        vehicle: body.vehicle || (type === "package" ? "Private van + flights" : "Van, 10 seats"),
        minSeats: Number(body.minSeats || (type === "package" ? 4 : 4)),
        maxSeats: Number(body.maxSeats || (type === "package" ? 12 : 10)),
        baseCost: Number(body.baseCost || 0),
        publishedRate: Number(body.publishedRate || 0),
        breakPrice: Number(body.breakPrice || Math.round(Number(body.publishedRate || 0) * 0.8)),
        quality: Number(body.quality || 4.7),
        depositPercent: Number(body.depositPercent || (type === "package" ? defaultPackageDeposit : defaultDayTourDeposit)),
        description: body.description || "",
        included: body.included || [],
        notIncluded: body.notIncluded || [],
        itinerary: type === "package" ? (body.itinerary || []) : undefined,
        accommodationTiers: type === "package" ? (body.accommodationTiers || []) : undefined,
      };
      Object.keys(product).forEach((key) => product[key] === undefined && delete product[key]);

      const existingIndex = db.tourProducts.findIndex((p) => p.id === id);
      if (existingIndex >= 0) {
        db.tourProducts[existingIndex] = { ...db.tourProducts[existingIndex], ...product };
      } else {
        db.tourProducts.push(product);
      }
      await writeDb(db);
      send(response, 201, { product });
      return;
    }

    const pricingMatch = url.pathname.match(/^\/api\/admin\/tour-products\/([^/]+)\/pricing$/);
    if (request.method === "POST" && pricingMatch) {
      const body = await parseJson(request);
      const db = await readDb();
      const product = db.tourProducts.find((item) => item.id === pricingMatch[1]);
      if (!product) {
        sendError(response, 404, "Tour product not found.");
        return;
      }

      const publishedRate = Number(body.publishedRate || product.publishedRate);
      const breakPrice = Number(body.breakPrice || product.breakPrice);
      if (!Number.isFinite(publishedRate) || publishedRate <= 0 || !Number.isFinite(breakPrice) || breakPrice <= 0) {
        sendError(response, 422, "Prices must be positive numbers.");
        return;
      }
      if (breakPrice > publishedRate) {
        sendError(response, 422, "Break price cannot be higher than the GoAhead price.");
        return;
      }

      product.publishedRate = publishedRate;
      product.breakPrice = breakPrice;

      db.departures = db.departures.map((departure) => {
        if (departure.tourProductId !== product.id) return departure;
        return {
          ...departure,
          publishedRate,
          breakPrice,
        };
      });

      await writeDb(db);
      send(response, 200, {
        product,
        departures: db.departures.filter((departure) => departure.tourProductId === product.id).map(enrichDeparture),
      });
      return;
    }

    const confirmMatch = url.pathname.match(/^\/api\/admin\/departures\/(\d+)\/confirm$/);
    if (request.method === "POST" && confirmMatch) {
      const db = await readDb();
      const departure = db.departures.find((item) => Number(item.id) === Number(confirmMatch[1]));
      if (!departure) {
        sendError(response, 404, "Departure not found.");
        return;
      }
      const required = goAheadSeatsFor(departure);
      if (seatsTotal(departure.pledges) < required) {
        sendError(response, 409, `${required} booked seats are required for go-ahead.`);
        return;
      }
      departure.status = "supplier_confirmed";
      await writeDb(db);
      send(response, 200, { departure: enrichDeparture(departure) });
      return;
    }

    const pledgeMatch = url.pathname.match(/^\/api\/departures\/(\d+)\/pledges$/);
    if (request.method === "POST" && pledgeMatch) {
      const body = await parseJson(request);
      const db = await readDb();
      const departure = db.departures.find((item) => Number(item.id) === Number(pledgeMatch[1]));
      if (!departure) {
        sendError(response, 404, "Departure not found.");
        return;
      }
      const product = db.tourProducts.find((item) => item.id === departure.tourProductId) || null;

      const agency = db.agencies.find((item) => item.id === body.agencyId) || db.agencies[0];
      const seats = Number(body.seats || 1);
      if (seats < 1) {
        sendError(response, 422, "Seats must be at least 1.");
        return;
      }
      if (seatsTotal(departure.pledges) + seats > departure.maxSeats) {
        sendError(response, 409, "This pledge exceeds capacity.");
        return;
      }

      const pricing = pledgeFromBody(departure, product, body);
      departure.pledges.push({
        id: nextPledgeId(departure),
        agencyId: agency.id,
        agency: agency.name,
        seats,
        customers: String(body.customers || "Customer details pending").trim(),
        ...pricing,
        createdAt: new Date().toISOString(),
      });
      departure.status = statusFor(departure);
      await writeDb(db);
      send(response, 201, { departure: enrichDeparture(departure) });
      return;
    }

    const publicBookingMatch = url.pathname.match(/^\/api\/public\/departures\/(\d+)\/bookings$/);
    if (request.method === "POST" && publicBookingMatch) {
      const body = await parseJson(request);
      const db = await readDb();
      const departure = db.departures.find((item) => Number(item.id) === Number(publicBookingMatch[1]));
      if (!departure) {
        sendError(response, 404, "Departure not found.");
        return;
      }
      const product = db.tourProducts.find((item) => item.id === departure.tourProductId) || null;

      const seats = Number(body.seats || 1);
      const customerName = String(body.customerName || "").trim();
      if (!customerName) {
        sendError(response, 422, "Customer name is required.");
        return;
      }
      if (seats < 1) {
        sendError(response, 422, "Seats must be at least 1.");
        return;
      }
      if (seatsTotal(departure.pledges) + seats > departure.maxSeats) {
        sendError(response, 409, "This booking exceeds the remaining seats.");
        return;
      }

      const pricing = pledgeFromBody(departure, product, body, { isPublic: true });
      const pledge = {
        id: nextPledgeId(departure),
        agencyId: "direct_customer",
        agency: "Direct traveler",
        seats,
        customers: customerName,
        source: "public",
        bookingCode: publicBookingCode(),
        ...pricing,
        createdAt: new Date().toISOString(),
      };
      departure.pledges.push(pledge);
      departure.status = statusFor(departure);
      await writeDb(db);
      send(response, 201, { departure: enrichDeparture(departure), booking: pledge });
      return;
    }

    const cancelPledgeMatch = url.pathname.match(/^\/api\/departures\/(\d+)\/pledges\/([^/]+)$/);
    if (request.method === "DELETE" && cancelPledgeMatch) {
      const db = await readDb();
      const departure = db.departures.find((item) => Number(item.id) === Number(cancelPledgeMatch[1]));
      if (!departure) {
        sendError(response, 404, "Departure not found.");
        return;
      }

      const pledgeIndex = departure.pledges.findIndex((pledge) => pledge.id === cancelPledgeMatch[2]);
      if (pledgeIndex === -1) {
        sendError(response, 404, "Pledge not found.");
        return;
      }
      if (departure.status === "supplier_confirmed") {
        sendError(response, 409, "Supplier-confirmed departures need admin cancellation.");
        return;
      }

      departure.pledges.splice(pledgeIndex, 1);
      departure.status = statusFor({ ...departure, status: "open" });
      await writeDb(db);
      send(response, 200, { departure: enrichDeparture(departure) });
      return;
    }

    const cancelPublicMatch = url.pathname.match(/^\/api\/public\/departures\/(\d+)\/bookings\/([^/]+)$/);
    if (request.method === "DELETE" && cancelPublicMatch) {
      const db = await readDb();
      const departure = db.departures.find((item) => Number(item.id) === Number(cancelPublicMatch[1]));
      if (!departure) {
        sendError(response, 404, "Departure not found.");
        return;
      }
      if (departure.status === "supplier_confirmed") {
        sendError(response, 409, "Supplier-confirmed departures need support cancellation.");
        return;
      }

      const pledgeIndex = departure.pledges.findIndex((pledge) => {
        return pledge.id === cancelPublicMatch[2] && pledge.source === "public";
      });
      if (pledgeIndex === -1) {
        sendError(response, 404, "Public booking not found.");
        return;
      }

      departure.pledges.splice(pledgeIndex, 1);
      departure.status = statusFor({ ...departure, status: "open" });
      await writeDb(db);
      send(response, 200, { departure: enrichDeparture(departure) });
      return;
    }

    sendError(response, 404, "Not found.");
  } catch (error) {
    sendError(response, 500, error.message || "Server error.");
  }
});

server.listen(port, () => {
  console.log(`Sawa API listening on http://localhost:${port}`);
});
