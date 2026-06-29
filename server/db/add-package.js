// Creates the "Egypt in Depth — 9-Day Nile Cruise & Cairo" package:
// product + accommodation tiers + rich 9-day itinerary + future departures,
// and copies a hero gallery from the local image library. Re-runnable.
// Run: node server/db/add-package.js
import { readdirSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = process.env.IMAGE_SRC || "E:/Journals images/raw";
const PUBLIC_DIR = join(__dirname, "..", "..", "public", "images", "packages");
const IMG_RE = /\.(jpe?g|png|webp)$/i;

const KEY = "egypt-nile-cruise-9d";
const ID = "pkg_egypt_nile_cruise_9d";

// Curated, itinerary-relevant gallery (cover first). Output names double as
// cache-busting storage keys.
const GALLERY = [
  { src: "cairo/giza-pyramids-and-sphinx/culmination-journey-through-egypt-giza-shpinx-second-pyramid.jpg", name: "sphinx-giza.jpg", alt: "The Great Sphinx before the pyramid of Khafre at Giza" },
  { src: "cairo/giza-pyramids-and-sphinx/giza-pyramids-at-dusk-cairo-egypt.jpg", name: "giza-dusk.jpg", alt: "Pyramids of Giza at dusk" },
  { src: "nile-river/nile-cruise/nile-cruise-ship-egypt.jpg", name: "nile-cruise.jpg", alt: "Nile cruise ship" },
  { src: "aswan/aswan-nile-river/egypt-nile-valley-boat-cruising-nile-between-luxor-aswan.jpg", name: "nile-cruising.jpg", alt: "Cruising the Nile between Luxor and Aswan" },
  { src: "luxor/karnak-temple/luxor-egypt-great-hypostyle-hall-temple-amun-karnak-luxor-egypt.jpg", name: "karnak.jpg", alt: "The Great Hypostyle Hall at Karnak Temple" },
  { src: "luxor/valley-of-the-kings/aerial-view-valley-of-kings-luxor.jpg", name: "valley-of-the-kings.jpg", alt: "Aerial view of the Valley of the Kings" },
  { src: "aswan/philae-temple/egypt-temple-philae-nile.jpg", name: "philae.jpg", alt: "Philae Temple on the Nile" },
  { src: "nile-river/felucca/felucca-cruising-nile.jpg", name: "felucca.jpg", alt: "A felucca sailing on the Nile at Aswan" },
  { src: "abu-simbel/abu-simbel-temples/abu-simbel-great-temple-egypt.jpg", name: "abu-simbel.jpg", alt: "The Great Temple of Ramses II at Abu Simbel" },
  { src: "cairo/islamic-cairo/cairo-egypt-december-20-after-dusk-al-muizz-street-wakings-up-building-s-illumination.jpg", name: "al-muizz-street.jpg", alt: "Al-Muizz Street illuminated in Islamic Cairo" },
];

const itinerary = [
  {
    day: 1, city: "Cairo", title: "Arrival in Cairo", overnight: "Cairo",
    description: "Welcome to Egypt. On arrival at Cairo International Airport you'll be met by our representative, who assists with immigration formalities and luggage before transferring you to your hotel. The rest of the day is yours to settle in, with a welcome dinner together at a local restaurant in the evening.",
    accommodation: "Hotel · Cairo", meals: "Dinner at a local restaurant",
    included: ["Arrival transfer", "Welcome dinner at a local restaurant"],
    optional: [],
    special: "Share your flight details at least 14 days before travel so we can confirm your arrival transfer.",
  },
  {
    day: 2, city: "Cairo", title: "Memphis, Saqqara & Old Cairo", overnight: "Cairo",
    description: "After breakfast, explore the cradle of ancient Egypt. Stand in Memphis, the country's first capital, then walk among the tombs of Saqqara and the Step Pyramid of Djoser — the oldest stone monument in the world. After a traditional local lunch, wander Old Cairo, including the Hanging Church and the historic Coptic district.",
    accommodation: "Hotel · Cairo", meals: "Breakfast, Local lunch",
    included: ["Memphis", "Saqqara — Step Pyramid of Djoser", "Traditional local lunch", "Old Cairo — Hanging Church & Coptic district"],
    optional: [],
    special: "",
  },
  {
    day: 3, city: "Cairo", title: "Egyptian Museum & the Giza Pyramids", overnight: "Cairo",
    description: "After breakfast, discover Egypt's most famous landmarks. Begin at the Egyptian Museum among the treasures of the pharaohs, then drive to the Giza plateau for the Great Pyramids, the Sphinx and the Valley Temple. In the evening, gather for dinner at a local restaurant.",
    accommodation: "Hotel · Cairo", meals: "Breakfast, Dinner at a local restaurant",
    included: ["Egyptian Museum", "Great Pyramids of Giza", "The Great Sphinx", "Valley Temple", "Dinner at a local restaurant"],
    optional: [],
    special: "",
  },
  {
    day: 4, city: "Cairo → Luxor", title: "Fly to Luxor & the East Bank", overnight: "Nile Cruise · Luxor",
    description: "An early-morning flight brings you to Luxor. On arrival, explore the East Bank's great temples — the vast complex of Karnak with its avenue of sphinxes, and the elegant riverside Luxor Temple. Board your Nile cruise before lunch and settle into your cabin as the river slips by.",
    accommodation: "Nile Cruise · Luxor", meals: "Breakfast, Lunch, Dinner",
    included: ["Domestic flight Cairo → Luxor", "Karnak Temple", "Luxor Temple", "Board the Nile cruise"],
    optional: [],
    special: "Cruise boats are spacious and fully air-conditioned with private facilities; all meals are on board, drinks are extra.",
  },
  {
    day: 5, city: "Luxor — Nile Cruise", title: "Luxor's West Bank", overnight: "Nile Cruise",
    description: "After breakfast, cross to Luxor's legendary West Bank. Enter the painted royal tombs of the Valley of the Kings, stand before the terraced Temple of Queen Hatshepsut set against the cliffs, and pause at the towering Colossi of Memnon. Return to the cruise and begin sailing south.",
    accommodation: "Nile Cruise", meals: "Breakfast, Lunch, Dinner",
    included: ["Valley of the Kings", "Temple of Queen Hatshepsut", "Colossi of Memnon"],
    optional: ["Hot air balloon over the Valley of the Kings — USD120"],
    special: "The hot air balloon is weather-dependent; pickup is around 4:30–5am.",
  },
  {
    day: 6, city: "Edfu & Kom Ombo", title: "Edfu & Kom Ombo Temples", overnight: "Nile Cruise · Aswan",
    description: "After breakfast, visit the Temple of Horus at Edfu — the best-preserved temple in Egypt — then return to the cruise and continue sailing. In the afternoon, step ashore at Kom Ombo, the unusual double temple shared by the gods Sobek and Horus on a bend of the Nile, before sailing on toward Aswan.",
    accommodation: "Nile Cruise · Aswan", meals: "Breakfast, Lunch, Dinner",
    included: ["Temple of Horus at Edfu", "Kom Ombo Temple"],
    optional: [],
    special: "",
  },
  {
    day: 7, city: "Aswan", title: "Leisure in Aswan", overnight: "Nile Cruise · Aswan",
    description: "A relaxed day in beautiful Aswan. Set sail on a traditional felucca, the lateen-rigged boat that has plied the Nile for centuries, and gliding past Elephantine Island and the Aga Khan Mausoleum. The rest of the day is free to explore the colourful Aswan market and souq at your own pace.",
    accommodation: "Nile Cruise · Aswan", meals: "Breakfast, Lunch, Dinner",
    included: ["Felucca sail on the Nile", "Free time at the Aswan market (souq)"],
    optional: [],
    special: "",
  },
  {
    day: 8, city: "Aswan → Cairo", title: "Philae Temple, the High Dam & fly to Cairo", overnight: "Cairo",
    description: "Disembark after breakfast. Boat across to Philae Temple, the island sanctuary of Isis rescued from the rising waters, then take in the Aswan High Dam that created Lake Nasser. Transfer to Aswan airport for your flight to Cairo, where the evening brings a visit to the lively lanes of the Khan El Khalili bazaar.",
    accommodation: "Hotel · Cairo", meals: "Breakfast, Dinner at a local restaurant",
    included: ["Philae Temple", "Aswan High Dam", "Domestic flight Aswan → Cairo", "Khan El Khalili bazaar"],
    optional: [],
    special: "",
  },
  {
    day: 9, city: "Cairo", title: "Departure", overnight: null,
    description: "After breakfast, transfer to Cairo International Airport for your departure flight. We hope you leave Egypt with unforgettable memories — and look forward to welcoming you back.",
    accommodation: "—", meals: "Breakfast",
    included: ["Departure transfer"],
    optional: [],
    special: "",
  },
];

const product = {
  id: ID, type: "package", title: "Egypt in Depth — 9-Day Nile Cruise & Cairo",
  city: "Cairo", cities: ["Cairo", "Luxor", "Aswan"], nights: 8,
  duration: "9 days · 8 nights", defaultTime: "09:00",
  guide: "Licensed Egyptologist", vehicle: "Private vehicle, domestic flights & Nile cruise",
  minSeats: 6, maxSeats: 16, baseCost: 2100, publishedRate: 1690, breakPrice: 1390,
  quality: 4.9, depositPercent: 20,
  description: "Cairo's pyramids, the Egyptian Museum, a 4-night Nile cruise from Luxor to Aswan, and the temples in between — domestic flights and full sightseeing included.",
  included: [
    "Arrival and departure airport transfers",
    "Domestic flights Cairo → Luxor and Aswan → Cairo",
    "4 nights Cairo hotel and 4 nights Nile cruise (full board)",
    "8 breakfasts, 5 lunches, 7 dinners — including 3 dinners at local restaurants",
    "Licensed Egyptologist guide throughout",
    "Guided sightseeing and entrance fees to every site in the itinerary",
    "Memphis, Saqqara, Old Cairo, the Egyptian Museum, Giza Pyramids & Sphinx",
    "Karnak & Luxor Temples, Valley of the Kings, Hatshepsut, Colossi of Memnon",
    "Edfu & Kom Ombo temples, Philae Temple & the Aswan High Dam",
    "Felucca sail in Aswan and a Khan El Khalili bazaar visit",
  ],
  notIncluded: [
    "International flights",
    "Egypt entry visa",
    "Travel insurance",
    "Drinks and personal expenses",
    "Optional activities (e.g. hot air balloon)",
    "Tipping and gratuities",
  ],
  accommodationTiers: [
    { id: "standard", name: "Standard (3★ / 5★ cruise)", perPersonSupplement: 0, singleSupplement: 150 },
    { id: "superior", name: "Superior (4★ / deluxe cruise)", perPersonSupplement: 180, singleSupplement: 240 },
    { id: "luxury", name: "Luxury (5★ / luxury cruise)", perPersonSupplement: 390, singleSupplement: 420 },
  ],
  overviewHtml:
    "<p>Egypt's greatest hits in one shared, fully guided trip — and you only pay once the group is confirmed. Begin in Cairo with Memphis, Saqqara and Old Cairo, the Egyptian Museum and the Pyramids of Giza, then fly south to Luxor to board a four-night Nile cruise calling at Karnak, the Valley of the Kings, Edfu, Kom Ombo and Aswan. Domestic flights and all sightseeing are included, so the logistics are handled end to end.</p>" +
    "<p>You travel with a licensed Egyptologist throughout and stay in hand-picked hotels and cruise boats across three comfort tiers, finishing with Philae Temple, the High Dam and a final evening in the lanes of Khan El Khalili.</p>",
  meetingPoint: "Cairo International Airport — you'll be met on arrival and transferred to your hotel.",
};

const altFrom = (file) =>
  basename(file, extname(file)).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function collectImages() {
  const dest = join(PUBLIC_DIR, KEY);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const images = [];
  for (const g of GALLERY) {
    const abs = join(SRC_ROOT, g.src);
    if (!existsSync(abs)) { console.warn("  ! missing file:", g.src); continue; }
    copyFileSync(abs, join(dest, g.name));
    images.push({ url: `/images/packages/${KEY}/${g.name}`, alt: g.alt });
  }
  return images;
}

async function run() {
  const p = product;
  const J = (v) => JSON.stringify(v);
  const images = collectImages();

  await pool.query("DELETE FROM departures WHERE tour_product_id = $1", [p.id]);
  await pool.query("DELETE FROM tour_products WHERE id = $1", [p.id]);

  await pool.query(
    `INSERT INTO tour_products
       (id, type, title, city, cities, nights, duration, default_time, guide, vehicle,
        min_seats, max_seats, base_cost, published_rate, break_price, quality, deposit_percent,
        description, included, not_included, itinerary, accommodation_tiers,
        overview_html, meeting_point, images)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [
      p.id, p.type, p.title, p.city, J(p.cities), p.nights, p.duration, p.defaultTime, p.guide, p.vehicle,
      p.minSeats, p.maxSeats, p.baseCost, p.publishedRate, p.breakPrice, p.quality, p.depositPercent,
      p.description, J(p.included), J(p.notIncluded), J(itinerary), J(p.accommodationTiers),
      p.overviewHtml, p.meetingPoint, J(images),
    ]
  );

  // Published departures.
  const starts = ["2026-11-13", "2026-12-11", "2027-01-15", "2027-02-19", "2027-03-12", "2027-04-16"];
  const { rows } = await pool.query("SELECT COALESCE(MAX(id), 1000) AS m FROM departures");
  let nextId = Number(rows[0].m) + 1;
  for (const start of starts) {
    const end = new Date(`${start}T12:00:00`);
    end.setDate(end.getDate() + 8);
    const endStr = end.toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO departures
         (id, type, tour_product_id, route, date, start_date, end_date, nights, cities, time,
          city, guide, vehicle, min_seats, max_seats, base_cost, published_rate, break_price,
          quality, status, deposit_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        nextId++, "package", p.id, p.title, start, start, endStr, p.nights, J(p.cities), p.defaultTime,
        p.city, p.guide, p.vehicle, p.minSeats, p.maxSeats, p.baseCost, p.publishedRate, p.breakPrice,
        p.quality, "open", p.depositPercent,
      ]
    );
  }

  // Keep the sequence ahead of our manually-assigned ids, otherwise the admin
  // dashboard's nextval() collides with these rows and POST /departures 500s.
  await pool.query("SELECT setval('departures_id_seq', (SELECT MAX(id) FROM departures), true)");

  console.log(`✓ ${p.title}\n  ${images.length} images · ${itinerary.length} days · ${starts.length} departures`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
