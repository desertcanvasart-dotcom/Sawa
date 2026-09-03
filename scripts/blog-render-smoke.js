// Database-free regression for the soft-404 rendering failure. Uses the real
// built client and SEO builders, with a published fixture instead of live DB.
// npm run build, then: node scripts/blog-render-smoke.js
// --serve keeps the fixture at http://127.0.0.1:4175 for manual browser checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium } from "playwright-core";
import { mapPost } from "../server/blog-post.js";

process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
const { pool } = await import("../server/db/index.js");
const { buildHead, buildBody } = await import("../server/seo.js");
const fixture = {
  id: "blog_render_fixture", slug: "fayoum-in-a-day-from-cairo", status: "published",
  title: "Fayoum in a Day from Cairo", author: "Sawa Tours",
  published_at: "2026-08-15T00:00:00.000Z",
  body_html: "<p>Meidum, Hawara and Lake Qarun are spread across the Fayoum.</p><h2>Planning the journey</h2><p>This published test article must remain readable even when API requests are blocked.</p>",
  cover_image: "/images/blog/meidum-pyramid.jpg", cover_alt: "The Meidum pyramid",
};
pool.query = async (sql, params) => {
  assert.match(sql, /FROM blog_posts/);
  assert.match(sql, /status='published'/);
  return { rows: !params || params[0] === fixture.slug ? [fixture] : [] };
};
const root = fileURLToPath(new URL("../", import.meta.url));
const template = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const app = express();
app.get("/api/blog", (_req, res) => res.json({ posts: [mapPost(fixture)] }));
app.get("/api/blog/:slug", (req, res) => req.params.slug === fixture.slug
  ? res.json({ post: mapPost(fixture) }) : res.status(404).json({ error: "Post not found." }));
// A failed unrelated catalogue must not hide the article.
app.use("/api", (_req, res) => res.status(503).json({ error: "Fixture catalogue unavailable" }));
app.get(["/blog", "/blog/:slug"], async (req, res) => {
  const [{ title, head, notFound }, body] = await Promise.all([buildHead(req.path), buildBody(req.path)]);
  const pageHead = req.query["no-inline"]
    ? head.replace(/<script>window\.__SAWA_BLOG_POST__=.*?<\/script>/s, "") : head;
  const html = template.replace(/<title>.*?<\/title>/s, `<title>${title}</title>`)
    .replace("</head>", () => `${pageHead}</head>`)
    .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
  res.status(notFound ? 404 : 200).type("html").send(html);
});
app.use(express.static(`${root}/dist`));
app.use(express.static(`${root}/site`));
const serveOnly = process.argv.includes("--serve");
const server = app.listen(serveOnly ? 4175 : 0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const path = `/blog/${fixture.slug}`;

if (serveOnly) {
  console.log(`Fixture preview: ${base}${path}`);
} else {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let passed = 0;
  const check = async (name, fn, options = {}) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.request().url().startsWith(base)
      ? route.continue() : route.abort("blockedbyclient"));
    try {
      await fn(page);
      assert.deepEqual(errors, [], "unexpected client exception");
      console.log(`ok ${++passed} - ${name}`);
    } finally { await context.close(); }
  };
  const articleVisible = async (page) => {
    await page.getByRole("heading", { name: fixture.title, exact: true }).waitFor();
    await page.getByText("Meidum, Hawara and Lake Qarun are spread across the Fayoum.", { exact: true }).waitFor();
    assert.equal(await page.locator(".blog-post-body").count(), 1);
    assert.equal(await page.getByText("This page wandered off.", { exact: true }).count(), 0);
  };
  try {
    await check("article survives robots-disallowed API requests", async (page) => {
      await page.route("**/api/**", (route) => route.abort("blockedbyclient"));
      assert.equal((await page.goto(base + path, { waitUntil: "networkidle" })).status(), 200);
      await articleVisible(page);
      assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "index,follow");
    });
    await check("article survives a 503 refresh and missing catalogue", async (page) => {
      await page.route("**/api/blog/**", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
      await page.goto(base + path, { waitUntil: "networkidle" });
      await articleVisible(page);
    });
    await check("article is visible before a slow API responds", async (page) => {
      await page.route("**/api/blog/**", () => new Promise(() => {}));
      await page.goto(base + path, { waitUntil: "domcontentloaded" });
      await articleVisible(page);
    });
    for (const noJs of [false, true]) {
      await check(noJs ? "article is readable without JavaScript" : "article survives a failed application bundle", async (page) => {
        if (!noJs) await page.route("**/assets/*.js", (route) => route.abort("blockedbyclient"));
        await page.goto(base + path, { waitUntil: "networkidle" });
        assert.equal(await page.locator("[data-server-rendered]").isVisible(), true);
        await page.getByRole("heading", { name: fixture.title, exact: true }).waitFor();
      }, { javaScriptEnabled: !noJs });
    }
    await check("an API failure without inline data shows retry, not not-found", async (page) => {
      let fail = true;
      await page.route("**/api/blog/**", (route) => fail
        ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue());
      await page.goto(base + path + "?no-inline=1", { waitUntil: "networkidle" });
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("This page wandered off.", { exact: true }).count(), 0);
      fail = false;
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await articleVisible(page);
    });
    await check("genuinely missing articles retain HTTP 404 and not-found UI", async (page) => {
      assert.equal((await page.goto(base + "/blog/missing", { waitUntil: "networkidle" })).status(), 404);
      await page.getByRole("heading", { name: "This page wandered off.", exact: true }).waitFor();
      assert.equal(await page.locator(".blog-post-body").count(), 0);
    });
    await check("mobile article renders with blocked APIs", async (page) => {
      await page.route("**/api/**", (route) => route.abort("blockedbyclient"));
      await page.goto(base + path, { waitUntil: "networkidle" });
      await articleVisible(page);
    }, { viewport: { width: 390, height: 844 }, isMobile: true });
    console.log(`${passed} browser regressions passed (local fixture; no production credentials).`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
}
