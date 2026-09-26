// One-off: give each seeded day tour a real photo gallery + a stop-by-stop
// itinerary. Copies curated images from the local "Journals images" library
// into public/images/tours/<key>/ and writes the images + itinerary JSONB.
// Re-runnable. Run: node server/db/add-tour-media.js
import { readdirSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = process.env.IMAGE_SRC || "E:/Journals images/raw";
const PUBLIC_DIR = join(__dirname, "..", "..", "public", "images", "tours");
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const MAX_TOTAL = 8;   // images per tour
const PER_FOLDER = 3;  // max taken from any one site folder

// idFragment -> { key, folders[], itinerary[] }
const MAP = [
  {
    frag: "giza_pyramids_sphinx", key: "giza",
    folders: ["cairo/giza-pyramids-and-sphinx", "cairo/grand-egyptian-museum", "cairo/egyptian-museum"],
    itinerary: [
      { title: "Giza Plateau & the Great Pyramids", description: "Stand before the pyramids of Khufu, Khafre and Menkaure — the only surviving wonder of the ancient world — with time for photos and an optional camel ride." },
      { title: "The Great Sphinx", description: "Walk down to the Valley Temple and the limestone guardian of the plateau." },
      { title: "The Grand Egyptian Museum", description: "Explore the new museum beside the plateau, home to the complete Tutankhamun collection." },
    ],
  },
  {
    frag: "memphis_saqqara_dahshur", key: "memphis-saqqara",
    folders: ["cairo/saqqara", "cairo/memphis", "cairo/dahshur"],
    itinerary: [
      { title: "Saqqara & the Step Pyramid", description: "See Djoser's Step Pyramid, the first stone monument in history, and the surrounding necropolis." },
      { title: "Memphis, the ancient capital", description: "Visit the open-air museum and the colossal recumbent statue of Ramses II." },
      { title: "Dahshur — Bent & Red Pyramids", description: "Finish at the pyramids where the smooth-sided form was perfected." },
    ],
  },
  {
    frag: "cairo_to_alexandria", key: "alexandria",
    folders: ["alexandria/catacombs-of-kom-el-shoqafa", "alexandria/pompeys-pillar", "alexandria/library-of-alexandria", "alexandria/alexandria-corniche", "alexandria/stanley-bridge", "alexandria/abu-al-abbas-mursi-mosque"],
    itinerary: [
      { title: "Catacombs of Kom el-Shoqafa", description: "Descend into the largest Roman-era burial site in Egypt, blending Egyptian and Greco-Roman art." },
      { title: "Pompey's Pillar & the Serapeum", description: "Stand beneath the towering granite column of the ancient acropolis." },
      { title: "The Bibliotheca Alexandrina", description: "Visit the modern library that revives the legendary center of learning." },
      { title: "The Corniche & Qaitbay", description: "Drive the Mediterranean seafront past the fort built on the site of the ancient lighthouse." },
    ],
  },
  {
    frag: "aswan_highlights", key: "aswan-highlights",
    folders: ["aswan/unfinished-obelisk", "aswan/philae-temple", "aswan/aswan-nile-river", "aswan/aswan-old-fortress"],
    itinerary: [
      { title: "The Unfinished Obelisk", description: "See the largest obelisk ever attempted, still lying in its ancient granite quarry." },
      { title: "The High Dam", description: "Take in the engineering that created Lake Nasser and reshaped modern Egypt." },
      { title: "Philae Temple", description: "Boat across to the island temple of Isis, rescued and relocated stone by stone." },
    ],
  },
  {
    frag: "aswan_to_abu_simbel", key: "abu-simbel",
    folders: ["abu-simbel/abu-simbel-temples", "aswan/aswan-nile-river", "aswan/philae-temple"],
    itinerary: [
      { title: "The Great Temple of Ramses II", description: "Stand before the four colossal statues guarding the facade of the rock-cut temple." },
      { title: "The Temple of Nefertari", description: "Visit the smaller temple Ramses dedicated to his queen, beside the great one." },
      { title: "The relocation story", description: "Learn how both temples were cut apart and lifted above the rising waters of Lake Nasser." },
    ],
  },
  {
    frag: "luxor_in_depth", key: "luxor-in-depth",
    folders: ["luxor/karnak-temple", "luxor/luxor-temple", "luxor/valley-of-the-kings", "luxor/hatshepsut-temple", "luxor/colossi-of-memnon"],
    itinerary: [
      { title: "Karnak Temple", description: "Walk the great hypostyle hall of 134 columns at Egypt's largest temple complex." },
      { title: "Luxor Temple", description: "See the riverside temple linked to Karnak by the avenue of sphinxes." },
      { title: "Valley of the Kings", description: "Cross to the west bank to enter the painted royal tombs cut into the cliffs." },
      { title: "Hatshepsut & the Colossi", description: "Finish at the terraced temple of Hatshepsut and the towering Colossi of Memnon." },
    ],
  },
  {
    frag: "the_grand_west_bank", key: "west-bank",
    folders: ["luxor/valley-of-the-kings", "luxor/valley-of-the-queens", "luxor/deir-el-medina", "luxor/medinet-habu", "luxor/hatshepsut-temple"],
    itinerary: [
      { title: "Valley of the Kings", description: "Enter the painted tombs of the New Kingdom pharaohs." },
      { title: "Valley of the Queens", description: "Visit the tombs of royal wives and princes, including the finest painted chambers." },
      { title: "Deir el-Medina", description: "Walk the village of the artisans who built the royal tombs." },
      { title: "Medinet Habu", description: "End at the vivid mortuary temple of Ramses III, still bright with color." },
    ],
  },
  {
    frag: "luxor_to_aswan_edfu_kom_ombo", key: "edfu-komombo",
    folders: ["edfu/edfu-temple", "kom-ombo/kom-ombo-temple", "aswan/aswan-nile-river"],
    itinerary: [
      { title: "Edfu — Temple of Horus", description: "Tour the best-preserved temple in Egypt, dedicated to the falcon god Horus." },
      { title: "Kom Ombo", description: "See the unique double temple shared by Sobek and Horus on a bend of the Nile." },
      { title: "The temple road to Aswan", description: "Travel the historic route between Luxor and Aswan along the river." },
    ],
  },
  {
    frag: "luxor_to_aswan_esna_edfu_kom_omb", key: "esna-edfu-komombo",
    folders: ["esna/esna-temple", "edfu/edfu-temple", "kom-ombo/kom-ombo-temple", "aswan/aswan-nile-river"],
    itinerary: [
      { title: "Esna — Temple of Khnum", description: "Visit the temple sunk below the modern town, its ceiling freshly cleaned to original color." },
      { title: "Edfu — Temple of Horus", description: "Continue to the great falcon temple, the best preserved in Egypt." },
      { title: "Kom Ombo", description: "Finish at the double temple of Sobek and Horus above the Nile." },
    ],
  },
  {
    frag: "dendera_abydos", key: "dendera-abydos",
    folders: ["dendera/dendera-temple", "abydos/abydos-temple"],
    itinerary: [
      { title: "Dendera — Temple of Hathor", description: "Explore the temple famous for its astronomical ceiling and well-preserved color." },
      { title: "Abydos — Temple of Seti I", description: "See the precise relief carving and the famous king list of Abydos." },
      { title: "The road north of Luxor", description: "Travel through the farmland of the Nile valley to these far temples." },
    ],
  },
];

const altFrom = (file) =>
  basename(file, extname(file)).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function collect(folders) {
  const picked = [];
  for (const rel of folders) {
    const abs = join(SRC_ROOT, rel);
    if (!existsSync(abs)) { console.warn("  ! missing folder:", rel); continue; }
    const files = readdirSync(abs).filter((f) => IMG_RE.test(f)).sort();
    for (const f of files.slice(0, PER_FOLDER)) {
      picked.push({ abs: join(abs, f), name: f });
      if (picked.length >= MAX_TOTAL) return picked;
    }
  }
  return picked;
}

async function run() {
  const { rows } = await pool.query("SELECT id, title FROM tour_products WHERE type = 'day_tour'");
  let updated = 0;

  for (const entry of MAP) {
    const tour = rows.find((r) => r.id.includes(entry.frag));
    if (!tour) { console.warn("No tour matches frag:", entry.frag); continue; }

    const dest = join(PUBLIC_DIR, entry.key);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });

    const picked = collect(entry.folders);
    if (!picked.length) { console.warn("No images for", entry.key); continue; }

    const images = picked.map((p, i) => {
      const ext = extname(p.name).toLowerCase();
      const out = `${String(i + 1).padStart(2, "0")}${ext}`;
      copyFileSync(p.abs, join(dest, out));
      return { url: `/images/tours/${entry.key}/${out}`, alt: altFrom(p.name) };
    });

    await pool.query(
      "UPDATE tour_products SET images = $1::jsonb, itinerary = $2::jsonb WHERE id = $3",
      [JSON.stringify(images), JSON.stringify(entry.itinerary), tour.id]
    );
    updated++;
    console.log(`✓ ${entry.key.padEnd(20)} ${images.length} imgs · ${entry.itinerary.length} stops · ${tour.title}`);
  }

  console.log(`\nUpdated ${updated}/${MAP.length} tours.`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
