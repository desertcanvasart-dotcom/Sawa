// 069 — customer reviews end to end: the real migrations on an empty Postgres,
// the real server, a signed-in admin, a stand-in for Supabase storage. A
// booking on a date that has run gets a review link; the traveler uploads a
// photo, sends the review; it is not public until the admin publishes it.
// Runs when TEST_DATABASE_URL is set (see test-db.js) and skips otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, dropDatabase, testDbSkip } from "./test-db.js";

const skip = testDbSkip;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "sawa_it_reviews";
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server, db, fake;
const storage = { buckets: new Map(), objects: new Map() };
const cairoDay = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(Date.now() + n * 86400000));

const TOUR = "tour_it_reviews";
const D = { past: 930001, future: 930002 };
const OPS = { id: "00000000-0000-4000-8000-000000000021", email: "ops@sawa.test", role: "super_admin" };

before(async () => {
  if (skip) return;
  // Stands in for Supabase: sign-in, and the storage calls reviews make.
  fake = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = req.url.split("?")[0];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.startsWith("/storage/v1/")) {
      const path = url.slice("/storage/v1".length);
      const json = () => JSON.parse(body.toString() || "{}");
      if (req.method === "GET" && path.startsWith("/bucket/")) {
        const id = path.slice("/bucket/".length);
        if (!storage.buckets.has(id)) { res.statusCode = 404; res.end(JSON.stringify({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" })); return; }
        res.end(JSON.stringify({ id, name: id, public: false })); return;
      }
      if (req.method === "POST" && path === "/bucket") {
        const b = json();
        storage.buckets.set(b.id || b.name, b);
        res.end(JSON.stringify({ name: b.name })); return;
      }
      if (req.method === "POST" && path.startsWith("/object/list/")) {
        const { prefix } = json();
        const names = [...storage.objects.keys()].filter((k) => k.startsWith(`review-media/${prefix}/`)).map((k) => k.slice(`review-media/${prefix}/`.length));
        res.end(JSON.stringify(names.map((name) => ({ name, id: name })))); return;
      }
      if (req.method === "POST" && path.startsWith("/object/upload/sign/")) {
        const key = decodeURIComponent(path.slice("/object/upload/sign/".length));
        res.end(JSON.stringify({ url: `/object/upload/sign/${key}?token=up` })); return;
      }
      if (req.method === "POST" && path.startsWith("/object/sign/")) {
        const rest = decodeURIComponent(path.slice("/object/sign/".length));
        if (!rest.includes("/")) {   // createSignedUrls: { paths }
          res.end(JSON.stringify(json().paths.map((p) => ({ path: p, signedURL: `/object/sign/${rest}/${p}?token=t`, error: null })))); return;
        }
        if (!storage.objects.has(rest)) { res.statusCode = 404; res.end(JSON.stringify({ message: "Object not found" })); return; }
        res.end(JSON.stringify({ signedURL: `/object/sign/${rest}?token=t` })); return;
      }
      res.statusCode = 404; res.end("{}"); return;
    }
    if ((req.headers.authorization || "") !== "Bearer ops-token") { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ id: OPS.id, email: OPS.email, aud: "authenticated" }));
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));

  const dbUrl = await freshDatabase(DB_NAME);
  const env = { ...process.env, DATABASE_URL: dbUrl, PGSSL: "false" };
  execFileSync(process.execPath, [join(ROOT, "server", "db", "migrate.js")], { env, stdio: "pipe" });
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  await db.query(`INSERT INTO app_users (id, email, role) VALUES ($1,$2,$3)`, [OPS.id, OPS.email, OPS.role]);
  await db.query(`INSERT INTO tour_products (id, type, title, city, min_seats, max_seats, published_rate, break_price, status, active)
                  VALUES ($1,'day_tour','Review Tour','Cairo',4,8,100,80,'approved',true)`, [TOUR]);
  const dep = (id, day) => db.query(
    `INSERT INTO departures (id, type, tour_product_id, route, date, time, city, min_seats, max_seats, published_rate, break_price, status)
     VALUES ($1,'day_tour',$2,'Review Tour',$3,'08:00','Cairo',4,8,100,80,'supplier_confirmed')`, [id, TOUR, day]);
  await dep(D.past, cairoDay(-3));
  await dep(D.future, cairoDay(10));
  await db.query(`INSERT INTO pledges (id, departure_id, agency_id, agency, seats, customers, customer_email, status) VALUES
    ('p_rv_ran', $1, 'direct_customer', 'Direct traveler', 2, 'Ann Smith', 'ann@example.com', 'confirmed'),
    ('p_rv_noemail', $1, 'direct_customer', 'Direct traveler', 1, 'Bo', NULL, 'confirmed'),
    ('p_rv_cancel', $1, 'direct_customer', 'Direct traveler', 1, 'Cy', 'cy@example.com', 'cancelled'),
    ('p_rv_future', $2, 'direct_customer', 'Direct traveler', 1, 'Di', 'di@example.com', 'confirmed')`, [D.past, D.future]);

  server = spawn(process.execPath, [join(ROOT, "server", "app.js")], {
    env: { ...env, PORT: String(PORT), NODE_ENV: "test", PAGE_WARM_INTERVAL_MS: "0",
      SUPABASE_URL: `http://127.0.0.1:${fake.address().port}`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x",
      RESEND_API_KEY: "", ENABLE_JOB_SCHEDULER: "", APP_URL: "https://sawa.test",
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => { out += d; });
  server.stderr.on("data", (d) => { out += d; });
  let lastError = "no response";
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${BASE}/bootstrap`);
      if (r.ok) return;
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;   // not listening yet — reported below if it never is
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start (${lastError}):\n${out}`);
});

after(async () => {
  if (skip) return;
  server?.kill();
  fake?.close();
  await db?.end();
  await dropDatabase(DB_NAME);
});

const call = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, {
    method, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => ({})) };
};
const ops = (m, p, b) => call(m, p, b, "ops-token");
const tokenOf = (url) => decodeURIComponent(url.split("/review/")[1]);
const review = { rating: 5, body: "Our guide made the pyramids come alive. Highly recommended.", displayName: "Ann S.", country: "UK", consent: true };

test("only a booking whose tour has run, and wasn't cancelled, gets a review link", { skip }, async () => {
  assert.match((await ops("POST", "/admin/bookings/p_rv_future/review-link", {})).body.error, /hasn't run yet/);
  assert.match((await ops("POST", "/admin/bookings/p_rv_cancel/review-link", {})).body.error, /cancelled/);
  assert.equal((await ops("POST", "/admin/bookings/nope/review-link", {})).status, 404);
  assert.equal((await call("POST", "/admin/bookings/p_rv_ran/review-link", {})).status, 401, "staff only");
  assert.match((await ops("POST", "/admin/bookings/p_rv_noemail/review-link", { send: true })).body.error, /no email address/);
  const copy = await ops("POST", "/admin/bookings/p_rv_noemail/review-link", {});
  assert.equal(copy.status, 201, "without an email the link can still be copied");
  assert.equal(copy.body.emailed, false);
});

test("the traveler uploads a photo and sends a review; it waits for the admin", { skip }, async () => {
  const first = await ops("POST", "/admin/bookings/p_rv_ran/review-link", { send: true });
  assert.equal(first.status, 201);
  assert.match(first.body.url, /^https:\/\/sawa\.test\/review\//);
  assert.equal(first.body.emailed, true, "log mode counts as sent");
  // A new link replaces the old one.
  const link = await ops("POST", "/admin/bookings/p_rv_ran/review-link", {});
  assert.equal((await call("GET", `/public/reviews/${encodeURIComponent(tokenOf(first.body.url))}`)).status, 404);
  const token = encodeURIComponent(tokenOf(link.body.url));

  const page = await call("GET", `/public/reviews/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.state, "open");
  assert.equal(page.body.route, "Review Tour");
  assert.equal(page.body.firstName, "Ann");

  assert.equal((await call("POST", `/public/reviews/${token}/uploads`, { contentType: "application/pdf", size: 10 })).status, 422);
  const up = await call("POST", `/public/reviews/${token}/uploads`, { contentType: "image/jpeg", size: 2000 });
  assert.equal(up.status, 201);
  assert.equal(storage.buckets.get("review-media")?.public, false, "a private bucket, created on first use");
  assert.match(up.body.uploadUrl, /\/storage\/v1\/object\/upload\/sign\/review-media\/reviews\/\d+\//);

  // Sent before the file is there: refused, so no review points at nothing.
  assert.match((await call("POST", `/public/reviews/${token}`, { ...review, media: [up.body.key] })).body.error, /didn't finish uploading/);
  storage.objects.set(`review-media/${up.body.key}`, { body: Buffer.from("jpg") });
  assert.match((await call("POST", `/public/reviews/${token}`, { ...review, media: ["reviews/1/1-ab.jpg"] })).body.error, /can't be attached/);
  assert.match((await call("POST", `/public/reviews/${token}`, { ...review, consent: false })).body.error, /publish/);

  const sent = await call("POST", `/public/reviews/${token}`, { ...review, media: [up.body.key] });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await call("POST", `/public/reviews/${token}`, review)).status, 409, "sent once");
  assert.equal((await call("GET", `/public/reviews/${token}`)).body.state, "sent");
  assert.equal((await ops("POST", "/admin/bookings/p_rv_ran/review-link", {})).status, 409, "no new link once it is sent");

  const pub = await call("GET", `/public/tours/${TOUR}/reviews`);
  assert.deepEqual(pub.body, { count: 0, average: null, reviews: [] }, "not public before the admin publishes it");
});

test("the admin publishes it; the tour page shows it, its photo, and the real average", { skip }, async () => {
  const list = await ops("GET", "/admin/reviews");
  assert.equal(list.status, 200);
  assert.equal(list.body.reviews.length, 1);
  const r = list.body.reviews[0];
  assert.equal(r.status, "submitted");
  assert.equal(r.email, "ann@example.com");
  assert.equal(r.media.length, 1);
  assert.match(r.media[0].url, /\/object\/sign\/review-media\/reviews\//, "the admin sees the photo through a signed link");
  assert.equal(list.body.invited, 1, "Bo's link is still waiting");

  const mediaUrl = `/public/review-media/${r.id}/0`;
  assert.equal((await call("GET", mediaUrl)).status, 404, "an unpublished review's photo isn't public");

  assert.equal((await ops("PATCH", `/admin/reviews/${r.id}`, { status: "published" })).status, 200);
  const pub = await call("GET", `/public/tours/${TOUR}/reviews`);
  assert.equal(pub.body.count, 1);
  assert.equal(pub.body.average, 5);
  const shown = pub.body.reviews[0];
  assert.equal(shown.displayName, "Ann S.");
  assert.equal(shown.email, undefined, "never the email");
  assert.deepEqual(shown.media, [{ kind: "image", url: `/api${mediaUrl}` }]);
  const media = await call("GET", mediaUrl);
  assert.equal(media.status, 302);
  assert.match(media.location, /\/object\/sign\/review-media\/reviews\//);

  assert.equal((await ops("PATCH", `/admin/reviews/${r.id}`, { status: "hidden" })).status, 200);
  assert.equal((await call("GET", `/public/tours/${TOUR}/reviews`)).body.count, 0, "hidden is gone from the page");
  assert.equal((await call("GET", mediaUrl)).status, 404);
  const audit = await db.query(`SELECT action FROM audit_log WHERE action LIKE 'review.%' ORDER BY id`);
  assert.deepEqual(audit.rows.map((a) => a.action),
    ["review.link_created", "review.link_emailed", "review.link_created", "review.submit", "review.published", "review.hidden"]);
});
