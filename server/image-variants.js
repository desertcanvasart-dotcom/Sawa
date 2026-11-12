// Smaller pictures for the same URLs (12 Nov 2026).
//
// Every photo on the site is a JPEG or PNG under /images, most of them 1200 to
// 1800 px wide. A tour card shows one at about 350 px; the home page shows a
// 1800 px hero at 191 px on a phone. Measured locally, a card list fetched
// ~750 kB of photos to show five cards.
//
// This answers /images/<path>.(jpg|jpeg|png) in two smaller forms, without
// changing any file or any URL that already works:
//
//   - WebP, for a browser that says it accepts it (Accept: image/webp). Same
//     picture, same size, typically a third of the bytes. `Vary: Accept`.
//   - ?w=480 | 800 | 1200: the picture scaled down to that width (never up).
//     Pages ask for this where they know how large a picture is shown.
//
// Anything else — no ?w and no WebP support, an unknown width, a file that
// isn't there, sharp failing to load — falls through to express.static, which
// serves the original exactly as before. A variant is made once, on first
// request, and kept on disk keyed by the source file's mtime and size, so a
// replaced photo is never served stale.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname } from "node:path";
import { IMAGE_WIDTHS as WIDTHS } from "../shared/image-size.js";

export { WIDTHS };
const SOURCE = /^\/[\w./-]+\.(jpe?g|png)$/i;

// Which form to send: { width, format } or null for "the original is right".
export function chooseVariant({ path, query = {}, accept = "" }) {
  if (!SOURCE.test(path) || path.includes("..")) return null;
  const w = query.w == null ? null : Number(query.w);
  if (w != null && !WIDTHS.includes(w)) return null;
  const webp = /\bimage\/webp\b/i.test(accept);
  if (w == null && !webp) return null;
  const original = extname(path).slice(1).toLowerCase() === "png" ? "png" : "jpeg";
  return { width: w, format: webp ? "webp" : original };
}

// The file a URL path names under one of the roots, or null. Never outside a root.
export function resolveSource(roots, path) {
  for (const root of roots) {
    const base = resolve(root);
    const file = resolve(base, "." + path);
    if (!file.startsWith(base + sep)) continue;
    if (!existsSync(file)) continue;
    const st = statSync(file);
    if (st.isFile()) return { file, st };
  }
  return null;
}

const CONTENT_TYPE = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };

export function imageVariants({ roots, cacheDir = join(tmpdir(), "sawa-image-variants"), loadSharp = () => import("sharp").then((m) => m.default), log = console } = {}) {
  let sharpPromise = null;
  let sharpBroken = false;
  const inFlight = new Map();
  mkdirSync(cacheDir, { recursive: true });

  const sharp = () => {
    sharpPromise ||= loadSharp().catch((e) => {
      sharpBroken = true;
      log.warn(`[images] sharp unavailable, serving originals only: ${e.message}`);
      return null;
    });
    return sharpPromise;
  };

  async function render(src, st, { width, format }) {
    const key = createHash("sha1").update(`${src}|${st.mtimeMs}|${st.size}|${width}|${format}`).digest("hex");
    const out = join(cacheDir, `${key}.${format}`);
    if (existsSync(out)) return out;
    if (inFlight.has(out)) return inFlight.get(out);
    const job = (async () => {
      const s = await sharp();
      if (!s) return null;
      let img = s(readFileSync(src)).rotate();
      if (width) img = img.resize({ width, withoutEnlargement: true });
      img = format === "webp" ? img.webp({ quality: 78 }) : format === "png" ? img.png({ compressionLevel: 9 }) : img.jpeg({ quality: 80, mozjpeg: true });
      const buf = await img.toBuffer();
      // Write then rename, so a request racing this one never reads half a file.
      const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, out);
      return out;
    })().finally(() => inFlight.delete(out));
    inFlight.set(out, job);
    return job;
  }

  return async function imageVariantMiddleware(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const variant = chooseVariant({ path: req.path, query: req.query, accept: req.get("accept") || "" });
    // Whatever is sent, a cache must not hand the WebP to a browser that
    // didn't ask for it.
    if (SOURCE.test(req.path)) res.vary("Accept");
    if (!variant || sharpBroken) return next();
    const source = resolveSource(roots, req.path);
    if (!source) return next();
    try {
      const file = await render(source.file, source.st, variant);
      if (!file) return next();
      res.set("Content-Type", CONTENT_TYPE[variant.format]);
      res.set("Cache-Control", "public, max-age=86400");
      return res.sendFile(file);
    } catch (e) {
      // A picture sharp can't read is still a picture the browser can: send
      // the original rather than an error.
      log.warn(`[images] ${req.path}: ${e.message} — serving the original`);
      return next();
    }
  };
}
