// DOM smoke — the one gap every other check accepts, closed.
//
// The check register is explicit: bundle text is a superset of what the DOM
// can show, the SPA's client-rendered DOM is never executed, and 176 tests
// once passed while 19 routes served a raw shell. smoke-routes.js proves the
// server SERVES a page; nothing until now proved a browser can RUN it.
//
// This drives real Chromium (playwright-core, channel:"chrome" — the system
// Chrome locally and on GitHub's runners, no browser download) through five
// traveller journeys and fails on the first thing a visitor would see broken:
// a console error, a missing element, an image that did not actually load.
//
//   node scripts/dom-smoke.js                       (local preview, port 4173)
//   node scripts/dom-smoke.js --base=https://sawa.tours
//
// Exits non-zero on any failure, so it can gate a deploy or fail a schedule.
import { chromium } from "playwright-core";

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const BASE = arg("base", "http://localhost:4173").replace(/\/$/, "");

// Console errors that are NOT a finding. Keep this list empty until a real
// benign entry earns its place with a comment — a growing allowlist is how
// this check dies (NNN1).
const CONSOLE_ALLOW = [];

const failures = [];
const ok = (name) => console.log(`  ok    ${name}`);
const fail = (name, why) => { failures.push(`${name}: ${why}`); console.error(`  FAIL  ${name} — ${why}`); };

async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e.message.split("\n")[0]); }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

async function openPage(path) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !CONSOLE_ALLOW.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 });
  return { page, errors };
}

console.log(`DOM smoke against ${BASE}\n`);

// 1 — The home page runs: hero rendered, nav carries the current items.
await check("home renders with hero and nav", async () => {
  const { page, errors } = await openPage("/");
  if (!(await page.locator("h1").first().textContent())?.trim()) throw new Error("no h1 text");
  const nav = await page.locator(".nav-links").first().innerText();
  if (!/Blog/.test(nav)) throw new Error(`nav is missing Blog — got: ${nav.replace(/\s+/g, " ")}`);
  if (errors.length) throw new Error(`console: ${errors[0]}`);
  await page.close();
});

// 2 — The catalogue → tour page journey: the SPA boots, cards render from
// live data, and a detail page reachable from a card offers the booking rail.
await check("itineraries → tour detail journey", async () => {
  const { page, errors } = await openPage("/itineraries");
  const cards = page.locator('a[href^="/tour/"], a[href^="/package/"]');
  const n = await cards.count();
  if (n < 5) throw new Error(`only ${n} tour links rendered — SPA likely failed to boot`);
  const href = await cards.first().getAttribute("href");
  await page.goto(`${BASE}${href}`, { waitUntil: "networkidle", timeout: 30_000 });
  if (!(await page.locator("h1").first().textContent())?.trim()) throw new Error(`no h1 on ${href}`);
  const body = await page.locator("body").innerText();
  if (!/Reserve|Join|GoAhead|Start your own/i.test(body)) throw new Error(`no booking affordance visible on ${href}`);
  if (errors.length) throw new Error(`console: ${errors[0]}`);
  await page.close();
});

// 3 — The partners directory: both operators named, registry links present.
await check("partners directory lists the operators", async () => {
  const { page, errors } = await openPage("/partners");
  const text = await page.locator("body").innerText();
  for (const name of ["Capital Travel Service", "El Agamy Travel"]) {
    if (!text.includes(name)) throw new Error(`"${name}" not rendered`);
  }
  const etaa = await page.locator('a[href*="etaa-egypt.org"]').count();
  if (etaa < 2) throw new Error(`expected 2 ETAA registry links, found ${etaa}`);
  if (errors.length) throw new Error(`console: ${errors[0]}`);
  await page.close();
});

// 4 — The blog article: images ACTUALLY LOADED (naturalWidth > 0), captions
// rendered. loading=lazy means scrolling to the bottom first.
await check("blog article renders its images", async () => {
  const { page, errors } = await openPage("/blog/fayoum-in-a-day-from-cairo");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  const imgs = await page.locator('img[src^="/images/blog/"]').evaluateAll(
    (els) => els.map((el) => ({ src: el.getAttribute("src"), loaded: el.complete && el.naturalWidth > 0 })));
  if (imgs.length < 3) throw new Error(`expected 3 article images, found ${imgs.length}`);
  const broken = imgs.filter((i) => !i.loaded);
  if (broken.length) throw new Error(`image did not load: ${broken[0].src}`);
  const captions = await page.locator("figcaption").count();
  if (captions < 3) throw new Error(`expected 3 captions, found ${captions}`);
  if (errors.length) throw new Error(`console: ${errors[0]}`);
  await page.close();
});

// 5 — The booking lookup: the one page a paying traveller returns to.
await check("booking lookup renders its form", async () => {
  const { page, errors } = await openPage("/booking");
  if (!(await page.locator("input").count())) throw new Error("no input rendered");
  if (errors.length) throw new Error(`console: ${errors[0]}`);
  await page.close();
});

await browser.close();

if (failures.length) {
  console.error(`\nRED — ${failures.length} of 5 journeys failed.`);
  process.exit(1);
}
console.log(`\nGREEN — all 5 journeys passed against ${BASE}.`);
