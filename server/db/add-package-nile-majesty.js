// Creates the "Nile Majesty — 5-Day River Cruise from Luxor" package:
// product + accommodation tier + faithful 5-day itinerary + future departures,
// and copies a web-optimised hero gallery from the local image library.
// Itinerary follows travel2egypt.org/5-day-river-cruise-from-luxor. Re-runnable.
// Run: node server/db/add-package-nile-majesty.js   (via `railway run` for DB env)
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = process.env.IMAGE_SRC || "E:/Luxurious Egypt website/raw-20260614T201358Z-3-001/raw";
const PUBLIC_DIR = join(__dirname, "..", "..", "public", "images", "packages");

const KEY = "nile-majesty-luxor-5d";
const ID = "pkg_nile_majesty_luxor_5d";

// Curated, itinerary-relevant gallery (cover first).
const GALLERY = [
  { src: "nile-river/nile-cruise/nile-cruise-ship-egypt.jpg", name: "nile-cruise.jpg", alt: "A five-star cruiser on the Nile between Luxor and Aswan" },
  { src: "luxor/karnak-temple/karnak-temple-luxor-egypt.jpg", name: "karnak.jpg", alt: "The temple complex of Karnak at Luxor" },
  { src: "luxor/luxor-temple/luxor-temple-illuminated-at-night.jpg", name: "luxor-temple-night.jpg", alt: "Luxor Temple illuminated at night" },
  { src: "luxor/valley-of-the-kings/aerial-view-valley-of-kings-luxor.jpg", name: "valley-of-the-kings.jpg", alt: "Aerial view of the Valley of the Kings" },
  { src: "luxor/hatshepsut-temple/hatshepsut-temple-deir-el-bahari-luxor.jpg", name: "hatshepsut.jpg", alt: "The Temple of Queen Hatshepsut at Deir el-Bahari" },
  { src: "edfu/edfu-temple/ancient-egyptian-architecture-ruins-hieroglyphs-columns-temple-horus-edfu-egypt.jpg", name: "edfu.jpg", alt: "The Temple of Horus at Edfu" },
  { src: "kom-ombo/kom-ombo-temple/magnificent-temple-sobek-horus-kom-ombo-sun-sets-over-river-nile.jpg", name: "kom-ombo.jpg", alt: "Kom Ombo Temple at sunset on the Nile" },
  { src: "nile-river/felucca/felucca-cruising-nile.jpg", name: "felucca.jpg", alt: "A felucca sailing the Nile at Aswan" },
  { src: "aswan/philae-temple/egypt-temple-philae-nile.jpg", name: "philae.jpg", alt: "Philae Temple on its island in Aswan" },
  { src: "aswan/aswan-nile-river/aswan-egypt-view-panorama-mountain-west-coast-nile-sunny-day.jpg", name: "aswan-nile.jpg", alt: "The Nile at Aswan" },
];

const itinerary = [
  {
    day: 1, city: "Luxor", title: "Arrival in Luxor — Karnak & Luxor Temple by night", overnight: "Nile Cruise · Luxor",
    description: "Arrive at Luxor International Airport, where you're met and escorted to your five-star Nile cruiser. Enjoy lunch on board before an afternoon at the vast Karnak Temple complex, dedicated to the pantheon of ancient gods. As the sun sets, a horse-drawn carriage carries you on an enchanting night tour of Luxor Temple, beautifully illuminated against the night sky.",
    accommodation: "Nile Cruise · Luxor", meals: "Lunch, Dinner",
    included: ["Meet & assist at Luxor International Airport", "Karnak Temple complex", "Horse-drawn carriage ride", "Night tour of the illuminated Luxor Temple"],
    optional: [],
    special: "Share your flight details at least 14 days before travel so we can confirm your arrival transfer.",
  },
  {
    day: 2, city: "Luxor — West Bank", title: "Valley of the Kings, Hatshepsut & the Colossi of Memnon", overnight: "Nile Cruise",
    description: "Awaken to the flow of the Nile and cross to Luxor's legendary West Bank. Explore the Valley of the Kings, the burial ground of pharaohs including Tutankhamun, stand before the terraced mortuary Temple of Queen Hatshepsut set against the cliffs, and pause at the towering Colossi of Memnon. Return to your cruiser for lunch and a leisurely afternoon sailing the timeless Nile.",
    accommodation: "Nile Cruise", meals: "Breakfast, Lunch, Dinner",
    included: ["Valley of the Kings", "Temple of Queen Hatshepsut", "Colossi of Memnon"],
    optional: [],
    special: "",
  },
  {
    day: 3, city: "Edfu & Kom Ombo", title: "Edfu & Kom Ombo Temples, felucca in Aswan", overnight: "Nile Cruise · Aswan",
    description: "Today brings you to the Temple of Edfu, the exquisitely preserved shrine to the falcon god Horus. After lunch, sail to the Temple of Kom Ombo, uniquely dedicated to both Sobek the crocodile god and Horus the elder. The day closes with a serene felucca sail around Kitchener's Island, followed by another peaceful night aboard your cruiser.",
    accommodation: "Nile Cruise · Aswan", meals: "Breakfast, Lunch, Dinner",
    included: ["Temple of Horus at Edfu", "Kom Ombo Temple", "Felucca sail around Kitchener's Island"],
    optional: [],
    special: "",
  },
  {
    day: 4, city: "Aswan", title: "Philae Temple, the High Dam & the Unfinished Obelisk", overnight: "Nile Cruise · Aswan",
    description: "After breakfast, set off to explore Aswan's treasures. Visit the captivating Philae Temple, dedicated to the goddess Isis and rescued from the rising waters, marvel at the Aswan High Dam that created Lake Nasser, and see the colossal Unfinished Obelisk still lying in its ancient granite quarry.",
    accommodation: "Nile Cruise · Aswan", meals: "Breakfast, Lunch, Dinner",
    included: ["Philae Temple", "Aswan High Dam", "Unfinished Obelisk"],
    optional: [],
    special: "",
  },
  {
    day: 5, city: "Aswan", title: "Departure from Aswan", overnight: null,
    description: "Enjoy your final breakfast on the Nile before disembarking. Our representative transfers you to Aswan International Airport for your onward flight; if you depart later in the day, special arrangements ensure your comfort until you leave, closing a memorable journey through the land of the pharaohs.",
    accommodation: "—", meals: "Breakfast",
    included: ["Meet & assist at Aswan International Airport", "Departure transfer"],
    optional: [],
    special: "",
  },
];

const product = {
  id: ID, type: "package", title: "Nile Majesty — 5-Day River Cruise from Luxor",
  city: "Luxor", cities: ["Luxor", "Edfu", "Kom Ombo", "Aswan"], nights: 4,
  duration: "5 days · 4 nights", defaultTime: "09:00",
  guide: "Licensed Egyptologist", vehicle: "Five-star Nile cruiser & private transfers",
  minSeats: 4, maxSeats: 12, baseCost: 540, publishedRate: 750, breakPrice: 675,
  quality: 4.9, depositPercent: 20,
  description: "A five-star Nile cruise from Luxor to Aswan — Karnak and Luxor Temple by night, the Valley of the Kings, Edfu, Kom Ombo, Philae and the High Dam, with full board and a licensed Egyptologist.",
  included: [
    "Meet & assist at Luxor and Aswan airports with all transfers",
    "4 nights aboard a five-star Nile cruiser (full board)",
    "4 breakfasts, 4 lunches and 4 dinners on board",
    "Licensed Egyptologist guide throughout",
    "All guided sightseeing and entrance fees in the itinerary",
    "Karnak & Luxor Temples, including the Luxor Temple night tour",
    "Valley of the Kings, Hatshepsut Temple & the Colossi of Memnon",
    "Edfu & Kom Ombo temples and a felucca sail in Aswan",
    "Philae Temple, the Aswan High Dam & the Unfinished Obelisk",
    "Horse-drawn carriage ride in Luxor",
  ],
  notIncluded: [
    "International flights",
    "Egypt entry visa",
    "Travel insurance",
    "Drinks and personal expenses",
    "Optional excursions outside the itinerary",
    "Tipping and gratuities",
  ],
  accommodationTiers: [
    { id: "standard", name: "Five-star Nile cruiser", perPersonSupplement: 0, singleSupplement: 150 },
  ],
  overviewHtml:
    "<p>Sail through the heart of ancient Egypt on a five-star cruiser from Luxor to Aswan — and you only pay once the group is confirmed. Begin in Luxor with the vast temple complex of Karnak and an after-dark carriage ride to the illuminated Luxor Temple, then cross to the West Bank for the Valley of the Kings, the Temple of Queen Hatshepsut and the Colossi of Memnon.</p>" +
    "<p>As you sail south the temples keep coming — Horus at Edfu, the double temple of Kom Ombo, and a felucca in Aswan — finishing with Philae Temple, the Aswan High Dam and the Unfinished Obelisk. Full board and a licensed Egyptologist are included throughout, so every day is handled end to end.</p>",
  meetingPoint: "Luxor International Airport — you'll be met on arrival and transferred to your Nile cruiser.",
};

function collectImages() {
  const dest = join(PUBLIC_DIR, KEY);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const images = [];
  for (const g of GALLERY) {
    const abs = join(SRC_ROOT, g.src);
    if (!existsSync(abs)) { console.warn("  ! missing file:", g.src); continue; }
    const out = join(dest, g.name);
    // Web-optimise: cap width at 1600px, quality 3 (~200-400KB JPEG).
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", abs, "-vf", "scale='min(1600,iw)':-2", "-q:v", "3", out]);
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
        overview_html, meeting_point, images, status, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'approved',true)`,
    [
      p.id, p.type, p.title, p.city, J(p.cities), p.nights, p.duration, p.defaultTime, p.guide, p.vehicle,
      p.minSeats, p.maxSeats, p.baseCost, p.publishedRate, p.breakPrice, p.quality, p.depositPercent,
      p.description, J(p.included), J(p.notIncluded), J(itinerary), J(p.accommodationTiers),
      p.overviewHtml, p.meetingPoint, J(images),
    ]
  );

  // Published departures (DD/MM given by the operator, resolved to seasons).
  const starts = ["2026-10-26", "2026-11-23", "2026-12-14", "2027-01-18", "2027-02-22", "2027-03-22", "2027-04-19"];
  const { rows } = await pool.query("SELECT COALESCE(MAX(id), 1000) AS m FROM departures");
  let nextId = Number(rows[0].m) + 1;
  for (const start of starts) {
    const end = new Date(`${start}T12:00:00`);
    end.setDate(end.getDate() + p.nights);
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

  await pool.query("SELECT setval('departures_id_seq', (SELECT MAX(id) FROM departures), true)");

  console.log(`✓ ${p.title}\n  ${images.length} images · ${itinerary.length} days · ${starts.length} departures`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
