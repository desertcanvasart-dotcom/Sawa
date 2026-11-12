// Smaller photos for the same URLs (server/image-variants.js, shared/image-size.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import sharp from "sharp";
import { imageVariants, chooseVariant, resolveSource } from "./image-variants.js";
import { sizedImage, imageSrcSet, IMAGE_WIDTHS } from "../shared/image-size.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let server, base, rootA, rootB, cache;
const WEBP = "image/avif,image/webp,image/apng,*/*;q=0.8";
const OLD = "image/png,image/*;q=0.8,*/*;q=0.5";

before(async () => {
  rootA = mkdtempSync(join(tmpdir(), "imgA-"));
  rootB = mkdtempSync(join(tmpdir(), "imgB-"));
  cache = mkdtempSync(join(tmpdir(), "imgC-"));
  const photo = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#c96" } }).jpeg({ quality: 92 }).toBuffer();
  writeFileSync(join(rootA, "wide.jpg"), photo);
  writeFileSync(join(rootB, "only-in-b.jpg"), photo);
  writeFileSync(join(rootA, "small.jpg"), await sharp({ create: { width: 300, height: 200, channels: 3, background: "#369" } }).jpeg().toBuffer());
  writeFileSync(join(rootA, "secret.txt"), "not a picture");
  const app = express();
  app.use("/images", imageVariants({ roots: [rootA, rootB], cacheDir: cache, log: { warn() {} } }));
  app.use("/images", express.static(rootA), express.static(rootB));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/images`;
});
after(() => server?.close());

const get = async (path, accept = WEBP) => {
  const r = await fetch(base + path, { headers: { accept } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), vary: r.headers.get("vary") || "", buf, meta: r.ok && /image/.test(r.headers.get("content-type")) ? await sharp(buf).metadata() : null };
};

test("a browser that takes WebP gets WebP, same picture, fewer bytes", async () => {
  const original = readFileSync(join(rootA, "wide.jpg"));
  const r = await get("/wide.jpg");
  assert.equal(r.type, "image/webp");
  assert.equal(r.meta.width, 1600);
  assert.ok(r.buf.length < original.length, `${r.buf.length} >= ${original.length}`);
  assert.match(r.vary, /Accept/i, "a shared cache must not hand WebP to everyone");
});

test("a browser that doesn't is sent the original file, byte for byte", async () => {
  const r = await get("/wide.jpg", OLD);
  assert.equal(r.type, "image/jpeg");
  assert.ok(r.buf.equals(readFileSync(join(rootA, "wide.jpg"))));
  assert.match(r.vary, /Accept/i);
});

test("?w scales down to an allowed width, never up, and never to a width it doesn't make", async () => {
  assert.equal((await get("/wide.jpg?w=480")).meta.width, 480);
  assert.equal((await get("/wide.jpg?w=800", OLD)).meta.width, 800);
  assert.equal((await get("/wide.jpg?w=800", OLD)).type, "image/jpeg", "no WebP for a browser that didn't ask");
  assert.equal((await get("/small.jpg?w=1200")).meta.width, 300, "enlarged");
  // An arbitrary width would let anyone fill the disk with variants.
  const odd = await get("/wide.jpg?w=999", OLD);
  assert.ok(odd.buf.equals(readFileSync(join(rootA, "wide.jpg"))), "?w=999 was resized");
});

test("the second root is searched, in order, and nothing outside the roots is reachable", async () => {
  assert.equal((await get("/only-in-b.jpg?w=480")).meta.width, 480);
  assert.equal((await get("/missing.jpg?w=480")).status, 404);
  assert.equal((await get("/secret.txt")).type?.startsWith("image/") ?? false, false);
  assert.equal(chooseVariant({ path: "/../../etc/passwd.jpg", query: { w: "480" }, accept: WEBP }), null);
  assert.equal(resolveSource([rootA], "/../outside.jpg"), null);
});

test("a variant is made once and remade when the photo is replaced", async () => {
  await get("/wide.jpg?w=1200");
  const before = readdirSync(cache).length;
  await get("/wide.jpg?w=1200");
  assert.equal(readdirSync(cache).length, before, "the same variant was rendered twice");
  writeFileSync(join(rootA, "wide.jpg"), await sharp({ create: { width: 1000, height: 500, channels: 3, background: "#123" } }).jpeg().toBuffer());
  const t = new Date(Date.now() + 5000); utimesSync(join(rootA, "wide.jpg"), t, t);
  assert.equal((await get("/wide.jpg?w=1200")).meta.width, 1000, "served the variant of the old photo");
});

test("without sharp, every request falls through to the original", async () => {
  const app = express();
  app.use("/images", imageVariants({ roots: [rootA], cacheDir: cache, loadSharp: async () => { throw new Error("no binary"); }, log: { warn() {} } }));
  app.use("/images", express.static(rootA));
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/images/small.jpg?w=480`, { headers: { accept: WEBP } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
  } finally { s.close(); }
});

test("pages ask only for widths the server makes", () => {
  assert.equal(sizedImage("/images/tours/giza/01.jpg", 800), "/images/tours/giza/01.jpg?w=800");
  assert.equal(sizedImage("https://x.supabase.co/storage/v1/object/public/a.jpg", 800), "https://x.supabase.co/storage/v1/object/public/a.jpg");
  assert.equal(sizedImage("/images/a.jpg", 999), "/images/a.jpg");
  assert.equal(imageSrcSet("https://elsewhere/a.jpg"), undefined);
  assert.match(imageSrcSet("/images/a.jpg"), /\?w=480 480w, .*\?w=1200 1200w$/);
  // The static pages build their own URLs; every width they name must be one
  // the server makes, or the request silently gets the full-size original.
  const pages = readdirSync(join(ROOT, "site")).filter((f) => f.endsWith(".html"));
  const asked = pages.flatMap((f) => [...readFileSync(join(ROOT, "site", f), "utf8").matchAll(/\?w=(\d+)/g)].map((m) => Number(m[1])));
  assert.ok(asked.length >= 6, "the pages ask for no widths: this check is looking at nothing");
  assert.deepEqual([...new Set(asked.filter((w) => !IMAGE_WIDTHS.includes(w)))], []);
});

test("the favicon every page loads is a small file", () => {
  const size = statSync(join(ROOT, "site", "images", "favicon.png")).size;
  assert.ok(size < 40_000, `favicon.png is ${Math.round(size / 1024)} kB — it was 214 kB, fetched by every page`);
});
