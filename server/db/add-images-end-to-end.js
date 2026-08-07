// Gives the 12-day "Egypt End to End" package a gallery. It was the last
// listing in the catalogue with zero photos, which left it rendering the
// site's fallback hero everywhere it appeared.
//
// No new photography was uploaded: every stop on this itinerary is already
// photographed for its sibling packages (the 9-day cruise covers the same
// Cairo → Aswan → Nile → Luxor ground, Nile Majesty covers Kom Ombo and Edfu),
// and those files are Sawa's own in the same bucket. The gallery follows the
// itinerary in order, so the cover is Giza and the last frame is the Islamic
// Cairo evening the trip ends on.
//
// Hurghada (days 9–10) is deliberately absent: there is no Red Sea photograph
// in the library, and standing in a temple shot for a beach day would
// misrepresent the trip. Add one through the portal when it exists.
//
// Re-runnable. Run: node server/db/add-images-end-to-end.js
import "dotenv/config";
import { pool } from "./index.js";

const PRODUCT_ID = "pkg_egypt_end_to_end_cairo_nile_crui_msj33v2z";
const NINE_DAY = "https://pajwixqdvedscleckxdx.supabase.co/storage/v1/object/public/tour-images/packages/egypt-nile-cruise-9d";
const MAJESTY = "https://pajwixqdvedscleckxdx.supabase.co/storage/v1/object/public/tour-images/packages/nile-majesty-luxor-5d";

// Order matters: images[0] is the cover everywhere it is read.
const IMAGES = [
  { url: `${NINE_DAY}/giza-dusk.jpg`, alt: "The Pyramids of Giza at dusk" },
  { url: `${NINE_DAY}/sphinx-giza.jpg`, alt: "The Great Sphinx before the pyramid of Khafre at Giza" },
  { url: `${NINE_DAY}/abu-simbel.jpg`, alt: "The Great Temple of Ramses II at Abu Simbel" },
  { url: `${NINE_DAY}/philae.jpg`, alt: "Philae Temple on its island at Aswan" },
  { url: `${NINE_DAY}/nile-cruise.jpg`, alt: "A Nile cruise ship between Aswan and Luxor" },
  { url: `${MAJESTY}/kom-ombo.jpg`, alt: "Kom Ombo Temple at sunset on the Nile" },
  { url: `${MAJESTY}/edfu.jpg`, alt: "The Temple of Horus at Edfu" },
  { url: `${NINE_DAY}/karnak.jpg`, alt: "The Great Hypostyle Hall at Karnak Temple, Luxor" },
  { url: `${NINE_DAY}/valley-of-the-kings.jpg`, alt: "Aerial view of the Valley of the Kings" },
  { url: `${NINE_DAY}/al-muizz-street.jpg`, alt: "Al-Muizz Street illuminated in Islamic Cairo" },
];

async function run() {
  const found = await pool.query("SELECT id, title, images FROM tour_products WHERE id = $1", [PRODUCT_ID]);
  if (!found.rows.length) { console.error("No product:", PRODUCT_ID); process.exit(1); }
  const before = (found.rows[0].images || []).length;

  await pool.query(
    "UPDATE tour_products SET images = $1::jsonb, updated_at = now() WHERE id = $2",
    [JSON.stringify(IMAGES), PRODUCT_ID]
  );

  console.log(`${found.rows[0].title}: ${before} → ${IMAGES.length} images.`);
  console.log(`Cover: ${IMAGES[0].alt}`);
}

run().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
