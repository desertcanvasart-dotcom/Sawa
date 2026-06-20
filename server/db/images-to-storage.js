// Uploads the local tour/package gallery images to the Supabase Storage
// bucket the app already uses ("tour-images"), then repoints each product's
// images[].url to the public Supabase URL. This lets Railway deploy code-only
// while images are served from Supabase's CDN. Re-runnable (upsert).
// Run: node server/db/images-to-storage.js
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { pool } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BUCKET = "tour-images";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing"); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

const TYPE = (ext) => ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "image/jpeg");

async function run() {
  const { rows } = await pool.query(
    "SELECT id, images FROM tour_products WHERE images IS NOT NULL AND jsonb_array_length(images) > 0"
  );
  let uploaded = 0, updatedProducts = 0;

  for (const row of rows) {
    const images = row.images;
    let changed = false;
    for (const img of images) {
      if (!img?.url || !img.url.startsWith("/images/")) continue; // already remote
      const storageKey = img.url.replace(/^\/images\//, "");      // tours/giza/01.jpg
      const localPath = join(ROOT, "public", "images", storageKey.split("/").join("/"));
      if (!existsSync(localPath)) { console.warn("  ! missing local file:", localPath); continue; }
      const ext = storageKey.split(".").pop().toLowerCase();
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storageKey, readFileSync(localPath), { contentType: TYPE(ext), upsert: true });
      if (error) { console.error("  upload failed:", storageKey, error.message); continue; }
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(storageKey);
      img.url = data.publicUrl;
      changed = true;
      uploaded++;
    }
    if (changed) {
      await pool.query("UPDATE tour_products SET images = $1::jsonb WHERE id = $2", [JSON.stringify(images), row.id]);
      updatedProducts++;
      console.log(`✓ ${row.id} (${images.length} images)`);
    }
  }

  console.log(`\nUploaded ${uploaded} files · repointed ${updatedProducts} products.`);
  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
