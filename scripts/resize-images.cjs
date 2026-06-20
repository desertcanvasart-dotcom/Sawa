// Re-encode/resize all .jpg files under a directory, in place, using the
// Chromium that ships with playwright-core (no native image deps needed).
// Usage: node scripts/resize-images.cjs <dir> [maxWidth=1600] [quality=0.82]
const { chromium } = require("playwright-core");
const fs = require("fs"), os = require("os"), path = require("path");

const TARGET = process.argv[2] || "public/images/tours";
const MAX_W = Number(process.argv[3] || 1600);
const QUALITY = Number(process.argv[4] || 0.82);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : (/\.jpe?g$/i.test(d.name) ? [p] : []);
  });
}

(async () => {
  if (!fs.existsSync(TARGET)) { console.error("No such dir:", TARGET); process.exit(1); }
  const dir = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const build = fs.readdirSync(dir).filter((d) => d.startsWith("chromium-")).sort().pop();
  const exe = path.join(dir, build, "chrome-win64", "chrome.exe");
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  const files = walk(TARGET);
  let before = 0, after = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f); before += buf.length;
    const out = await page.evaluate(async ({ b64, maxW, q }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/jpeg;base64," + b64; });
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c.toDataURL("image/jpeg", q);
    }, { b64: buf.toString("base64"), maxW: MAX_W, q: QUALITY });
    const data = Buffer.from(out.split(",")[1], "base64");
    fs.writeFileSync(f, data); after += data.length;
  }
  await browser.close();
  console.log(`${files.length} files in ${TARGET} · ${(before / 1048576).toFixed(0)}MB -> ${(after / 1048576).toFixed(1)}MB`);
})().catch((e) => { console.error(e.message); process.exit(1); });
