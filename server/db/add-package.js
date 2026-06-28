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
    day: 1, city: "Cairo", title: "Arrival in Cairo",
    description: "Welcome to Egypt. You'll be met on arrival at Cairo International Airport and transferred to your hotel. Your adventure begins with an important welcome meeting at 6pm, followed by dinner together at a local restaurant. If you have time spare beforehand, explore the busy city streets or visit the Cairo Citadel, dating to 1176 and home to several museums and mosques.",
    accommodation: "Hotel (1 night)", meals: "Dinner at a local restaurant",
    included: ["Arrival transfer", "Welcome dinner at a local restaurant"],
    optional: [],
    special: "Please attend the welcome meeting — we collect insurance and next-of-kin details. Provide flight details at least 14 days before travel so we can confirm your arrival transfer.",
  },
  {
    day: 2, city: "Cairo → Overnight Train", title: "Pyramids, Memphis & Saqqara, then the sleeper train",
    description: "A full first day. See the Pyramids of Giza and the Sphinx, structures that have stood for over 4,500 years, then the Grand Egyptian Museum and its complete Tutankhamun collection. Continue to the ancient capital of Memphis and the Step Pyramid at Saqqara. After lunch, wander Old Cairo and the Khan el-Khalili bazaar before boarding an overnight sleeper train to Luxor.",
    accommodation: "Overnight sleeper train (1 night)", meals: "Breakfast, Lunch, Dinner",
    included: [
      "Pyramids of Giza & the Sphinx", "Grand Egyptian Museum", "Memphis & Saqqara",
      "Old Cairo", "Khan el-Khalili bazaar visit",
    ],
    optional: [],
    special: "The sleeper train departs Cairo around 8pm and takes about 10 hours. Cabins are two-berth, air-conditioned, with bedding and an included dinner and breakfast on board.",
  },
  {
    day: 3, city: "Luxor — Nile Cruise", title: "Karnak Temple & board your cruise",
    description: "Pull into Luxor around 6am and take advantage of the early-morning calm at Karnak Temple — a vast complex of temples, chapels and pylons developed over 1,000 years. Your leader walks you through highlights such as the Avenue of Sphinxes and the Great Temple of Amun. Board your Nile cruise, settle into your cabin, and join an optional afternoon walking tour of Luxor and its bazaar.",
    accommodation: "Nile River Cruise (1 night)", meals: "Breakfast, Lunch, Dinner",
    included: ["Karnak Temple"],
    optional: [],
    special: "Tonight your boat is docked in Luxor. Cruise boats are large and comfortable with private facilities and full air-conditioning; meals are included but drinks are extra.",
  },
  {
    day: 4, city: "Nile Cruise", title: "Valley of the Kings & the West Bank",
    description: "Discover ancient Thebes by private minivan. Begin at the Colossi of Memnon, then enter the Valley of the Kings, where over 60 pharaohs were interred. Visit three royal tombs, including the tomb of Tutankhamun, then continue to the Temple of Queen Hatshepsut, set against high cliffs. The afternoon is yours before the boat sails to Edfu.",
    accommodation: "Nile River Cruise (1 night)", meals: "Breakfast, Lunch, Dinner",
    included: ["Colossi of Memnon", "Valley of the Kings (3 tombs)", "Tomb of Tutankhamun", "Hatshepsut Temple"],
    optional: [
      "Hot air balloon over the Valley of the Kings — USD120",
    ],
    special: "Tonight your boat is docked in Edfu. The hot air balloon is weather-dependent; pickup is around 4:30–5am.",
  },
  {
    day: 5, city: "Nile Cruise", title: "Kom Ombo & sail to Aswan",
    description: "After breakfast, sail toward Kom Ombo — an unusual double temple right on the Nile, with a mirror-image design dedicated to Sobek, the crocodile god, and Haroeris (Horus the falcon). Explore the fascinating reliefs with your leader, then enjoy lunch aboard as the boat continues to Aswan.",
    accommodation: "Nile River Cruise (1 night)", meals: "Breakfast, Lunch, Dinner",
    included: ["Kom Ombo Temple"],
    optional: [],
    special: "Tonight your boat is docked in Aswan. We don't include Edfu Temple as the only local transport there is by horse and carriage, which breaches our animal-welfare guidelines.",
  },
  {
    day: 6, city: "Nile Cruise — Aswan", title: "Aswan at your pace & a felucca sail",
    description: "Time to explore Aswan at your own pace. Wander the bustling local market and souk for spices and crafts, take in views of the Nile, and relax by the water. Late afternoon, enjoy a leisurely felucca sail before dinner on the ship.",
    accommodation: "Nile River Cruise (1 night)", meals: "Breakfast, Lunch, Dinner",
    included: ["Local market visit", "Felucca sail on the Nile"],
    optional: [],
    special: "Tonight your boat is docked in Aswan. An Abu Simbel excursion by road or flight can be arranged on request.",
  },
  {
    day: 7, city: "Aswan → Cairo", title: "Philae Temple, fly to Cairo & a home-cooked dinner",
    description: "Say goodbye to the Nile. Visit Philae Temple, an island complex built under Ptolemy II, its walls carved with scenes of Isis, Osiris and Horus. Catch a short flight back to Cairo. To celebrate your time in Egypt, join a local Cairo family for a delicious home-cooked dinner — the food and conversation make for an evening to remember.",
    accommodation: "Hotel (1 night)", meals: "Breakfast, Dinner",
    included: ["Philae Temple", "Home-cooked dinner with a local family"],
    optional: [],
    special: "Today's flight is approximately 90 minutes.",
  },
  {
    day: 8, city: "Cairo", title: "Islamic Cairo & Al-Muizz Street",
    description: "A full day in medieval Cairo. Walk Al-Muizz Street, one of the oldest streets in the city and an open-air museum of Islamic architecture — mosques, madrasas and merchant houses lining a thousand-year-old thoroughfare. Lose yourself in the lanes of the surrounding old city, stopping for mint tea and a final round of bazaar browsing, before a farewell dinner together at a local restaurant.",
    accommodation: "Hotel (1 night)", meals: "Breakfast, Dinner at a local restaurant",
    included: ["Al-Muizz Street & Islamic Cairo walk", "Farewell dinner at a local restaurant"],
    optional: [],
    special: "An easy, walkable day — comfortable shoes recommended.",
  },
  {
    day: 9, city: "Cairo", title: "Departure",
    description: "There are no activities planned for the final day and you're free to depart at any time. If you'd like to extend your stay in Cairo, we're happy to arrange additional accommodation (subject to availability).",
    accommodation: "—", meals: "Breakfast",
    included: ["Departure transfer"],
    optional: [],
    special: "",
  },
];

const product = {
  id: ID, type: "package", title: "Egypt in Depth — 9-Day Nile Cruise & Cairo",
  city: "Cairo", cities: ["Cairo", "Luxor", "Aswan"], nights: 8,
  duration: "9 days · 8 nights", defaultTime: "18:00",
  guide: "Licensed Egyptologist", vehicle: "Private vehicle, domestic flight, Nile cruise & sleeper train",
  minSeats: 6, maxSeats: 16, baseCost: 2100, publishedRate: 1690, breakPrice: 1390,
  quality: 4.9, depositPercent: 20,
  description: "Cairo's pyramids, an overnight sleeper train, a 4-night Nile cruise from Luxor to Aswan, and Islamic Cairo — flights and train included.",
  included: [
    "Arrival and departure airport transfers",
    "All internal Egypt flights and the overnight sleeper train Cairo → Luxor",
    "3 nights Cairo hotel, 4 nights Nile cruise (full board), 1 night sleeper train",
    "8 breakfasts, 5 lunches, 8 dinners — including 3 dinners out (welcome, home-cooked family & farewell)",
    "Licensed Egyptologist guide throughout",
    "Pyramids of Giza & the Sphinx, Grand Egyptian Museum, Memphis & Saqqara",
    "Karnak, Valley of the Kings (3 tombs), Tomb of Tutankhamun, Hatshepsut Temple",
    "Kom Ombo Temple, Aswan felucca sail, Philae Temple",
    "Old Cairo, Khan el-Khalili & Al-Muizz Street",
    "Home-cooked dinner with a local Cairo family",
  ],
  notIncluded: [
    "International flights",
    "Egypt entry visa",
    "Travel insurance",
    "Entrance fees at sites (see optional activities)",
    "Drinks on the cruise and personal expenses",
    "Tipping and gratuities",
  ],
  accommodationTiers: [
    { id: "standard", name: "Standard (3★ / 5★ cruise)", perPersonSupplement: 0, singleSupplement: 150 },
    { id: "superior", name: "Superior (4★ / deluxe cruise)", perPersonSupplement: 180, singleSupplement: 240 },
    { id: "luxury", name: "Luxury (5★ / luxury cruise)", perPersonSupplement: 390, singleSupplement: 420 },
  ],
  overviewHtml:
    "<p>This is Egypt's greatest hits in one shared, fully guided trip — and you only pay once the group is confirmed. Stand beneath the Pyramids of Giza, ride an overnight sleeper train to Luxor, then drift down the Nile on a four-night cruise calling at Karnak, the Valley of the Kings, Kom Ombo and Aswan. Internal flights and the sleeper train are included, so the logistics are handled end to end.</p>" +
    "<p>You travel with a licensed Egyptologist throughout, sleep in hand-picked hotels and cruise boats across three comfort tiers, and finish with a home-cooked dinner and a day exploring Islamic Cairo's Al-Muizz Street.</p>",
  meetingPoint: "Cairo International Airport — arrival transfer included. Welcome meeting at your hotel, 6pm on Day 1.",
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

  console.log(`✓ ${p.title}\n  ${images.length} images · ${itinerary.length} days · ${starts.length} departures`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
