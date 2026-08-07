// Zero-database preview of the public site. The real server (server/app.js)
// refuses to boot without DATABASE_URL, which makes "just look at the pages"
// impossible on a fresh clone. This serves the same three surfaces the way
// production does — static pages with clean, extensionless URLs, the built SPA
// for /itineraries and tour detail routes, and the catalogue redirects — with
// /api/bootstrap answered from the checked-in dev fixture instead of Postgres.
//
// Run: node scripts/dev-site.js   (build the SPA first: npm run build)
import express from "express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(root, "site");
const distDir = join(root, "dist");

const app = express();

// The fixture is the same file the page scripts fall back to when the API is
// down; serving it here as the API keeps the SPA (which has no fallback) alive.
app.get("/api/bootstrap", (_req, res) => res.sendFile(join(siteDir, "_dev_bootstrap.json")));

// Mirror the production 301s so the nav behaves the same here.
app.get(["/tours", "/packages"], (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(301, `/itineraries${qs}`);
});
app.get("/trust", (_req, res) => res.redirect(301, "/goahead-promise"));

// extensions:["html"] is what gives /departures, /goahead etc. without .html —
// the same option production passes.
app.use(express.static(siteDir, { extensions: ["html"] }));

if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  // Anything left that wants HTML is an SPA route (/itineraries, /tour/<slug>,
  // /package/<slug>, /blog…) — hand it the shell and let the client route.
  app.use((req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html")) return next();
    res.sendFile(join(distDir, "index.html"));
  });
}

const port = Number(process.env.PORT || 4173);
app.listen(port, () => {
  console.log(`Sawa static preview on http://localhost:${port} (no database — /api/bootstrap serves the dev fixture)`);
  if (!existsSync(distDir)) console.log("dist/ not found — run `npm run build` to preview /itineraries and tour pages.");
});
