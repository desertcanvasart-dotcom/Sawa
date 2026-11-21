// Which link filled the date (071): the campaign labels kept with a booking.
//
// The values come from a URL a stranger can write, so two things are the whole
// of the feature's safety: what survives cleaning, and that keeping the labels
// can never cost a traveller their booking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanCampaignValue, cleanCampaign, campaignFromUrl } from "../shared/campaign.js";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
const { takeCampaign, rememberCampaign, forget071 } = await import("./campaign.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("a value is reduced to a short lower-case label", () => {
  assert.equal(cleanCampaignValue(" Instagram "), "instagram");
  assert.equal(cleanCampaignValue("Fayoum 2026-12-04"), "fayoum-2026-12-04");
  assert.equal(cleanCampaignValue("giza_gem.dec"), "giza_gem.dec");
  assert.equal(cleanCampaignValue("x".repeat(300)).length, 100);
  for (const bad of [undefined, null, 7, {}, "", "   ", "!!!"]) assert.equal(cleanCampaignValue(bad), "", JSON.stringify(bad));
});

test("an address or a script pasted into a link cannot be stored as written", () => {
  assert.equal(cleanCampaignValue("amina@example.com"), "aminaexample.com");
  assert.equal(cleanCampaignValue("<script>alert(1)</script>"), "scriptalert1script");
  assert.equal(cleanCampaignValue("a'; DROP TABLE pledges;--"), "a-drop-table-pledges--");
});

test("a campaign is only the labels that survive, or nothing", () => {
  assert.deepEqual(cleanCampaign({ utmSource: "Instagram", utmMedium: "social", utmCampaign: "fayoum-2026-12-04", customerEmail: "a@b.c" }),
    { utmSource: "instagram", utmMedium: "social", utmCampaign: "fayoum-2026-12-04" });
  assert.deepEqual(cleanCampaign({ utmSource: "blog", utmMedium: "", utmCampaign: "###" }), { utmSource: "blog" });
  for (const none of [null, undefined, {}, { utmSource: "" }, { utmCampaign: "???" }]) assert.equal(cleanCampaign(none), null);
});

test("a campaign is read from a page address, and from nothing else", () => {
  assert.deepEqual(
    campaignFromUrl("https://sawa.tours/tour/fayoum?date=12&utm_source=instagram&utm_medium=social&utm_campaign=fayoum-2026-12-04"),
    { utmSource: "instagram", utmMedium: "social", utmCampaign: "fayoum-2026-12-04" });
  assert.deepEqual(campaignFromUrl("https://nilegate.com/egypt-tours?utm_source=newsletter"), { utmSource: "newsletter" });
  for (const none of ["", null, undefined, 42, "https://sawa.tours/tour/fayoum", "https://sawa.tours/?ref=NILE01", "not a url at all"]) {
    assert.equal(campaignFromUrl(none), null, JSON.stringify(none));
  }
});

test("a booking request is reduced to its clean campaign: its own fields first, else the widget's page", () => {
  const direct = { seats: 2, utmSource: "Instagram", utmCampaign: "Fayoum 2026-12-04", pageUrl: "https://x.example/?utm_source=other" };
  takeCampaign(direct);
  assert.deepEqual(direct, { seats: 2, utmSource: "instagram", utmCampaign: "fayoum-2026-12-04", pageUrl: "https://x.example/?utm_source=other" });

  const widget = { seats: 1, pageUrl: "https://nilegate.com/tours?utm_source=newsletter&utm_medium=email" };
  takeCampaign(widget);
  assert.equal(widget.utmSource, "newsletter");
  assert.equal(widget.utmMedium, "email");
  assert.ok(!("utmCampaign" in widget));

  const none = { seats: 1, utmSource: "???", utmMedium: "" };
  assert.equal(takeCampaign(none), null);
  assert.deepEqual(none, { seats: 1 }, "fields that did not survive are removed, not kept raw");
});

const db = ({ fail = null } = {}) => {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); if (fail) throw fail; return { rowCount: 1 }; } };
};

test("the labels are written to the booking, by its code", async () => {
  forget071();
  const d = db();
  assert.equal(await rememberCampaign(d, "SAWA-ABCD2345", { utmSource: "instagram", utmCampaign: "fayoum-2026-12-04", customerName: "Amina" }), true);
  assert.equal(d.calls.length, 1);
  assert.match(d.calls[0].sql, /UPDATE pledges SET utm_source = \$2, utm_medium = \$3, utm_campaign = \$4/);
  assert.deepEqual(d.calls[0].params, ["SAWA-ABCD2345", "instagram", null, "fayoum-2026-12-04"]);
});

test("a booking with no campaign, or no code, writes nothing", async () => {
  forget071();
  const d = db();
  assert.equal(await rememberCampaign(d, "SAWA-ABCD2345", { seats: 2 }), false);
  assert.equal(await rememberCampaign(d, "", { utmSource: "instagram" }), false);
  assert.equal(d.calls.length, 0);
});

test("before migration 071 the write is skipped, said once, and never thrown", async () => {
  forget071();
  const real = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(" "));
  try {
    const old = db({ fail: Object.assign(new Error('column "utm_source" does not exist'), { code: "42703" }) });
    assert.equal(await rememberCampaign(old, "SAWA-ABCD2345", { utmSource: "instagram" }), false);
    assert.equal(await rememberCampaign(old, "SAWA-EFGH6789", { utmSource: "instagram" }), false);
    assert.equal(old.calls.length, 1, "the missing column is remembered; the second booking does not ask again");
    assert.equal(said.length, 1);
  } finally { console.warn = real; forget071(); }
});

test("a database failure while keeping the labels does not fail the booking", async () => {
  forget071();
  const real = console.warn;
  console.warn = () => {};
  try {
    const down = db({ fail: Object.assign(new Error("connection terminated"), { code: "57P01" }) });
    assert.equal(await rememberCampaign(down, "SAWA-ABCD2345", { utmSource: "instagram" }), false);
    assert.equal(await rememberCampaign(down, "SAWA-ABCD2345", { utmSource: "instagram" }), false);
    assert.equal(down.calls.length, 2, "a passing failure is retried on the next booking");
  } finally { console.warn = real; forget071(); }
});

// The wiring, read from the source: these routes need a database to run.
test("both public booking routes read the campaign before the page address is narrowed, and keep it after the booking exists", () => {
  const bookings = read("server/routes/bookings.js");
  assert.ok(bookings.indexOf("takeCampaign(input)") > 0);
  assert.ok(bookings.indexOf("takeCampaign(input)") < bookings.indexOf("input.pageUrl = (await partnerPageFor("), "read from the address the browser sent");
  assert.ok(bookings.indexOf("rememberCampaign(pool, result.booking.bookingCode, input)") > bookings.indexOf("rememberPartnerPage(pool, result.booking.bookingCode"));

  const requests = read("server/routes/date-requests.js");
  assert.ok(requests.indexOf("takeCampaign(input)") > 0);
  assert.ok(requests.indexOf("takeCampaign(input)") < requests.indexOf("input.pageUrl = (await partnerPageFor("));
  assert.match(read("server/routes/date-request-create.js"), /rememberCampaign\(pool, result\.booking\.bookingCode, input\)/);
});

test("both booking schemas accept the three fields, and the migration is registered with its rollback", () => {
  const app = read("server/app.js");
  assert.equal((app.match(/utmCampaign: z\.string\(\)\.trim\(\)\.max\(200\)\.optional\(\)/g) || []).length, 2);
  assert.match(read("server/db/migrate.js"), /\{ name: "071_campaign_attribution", file: "schema_071_campaign_attribution\.sql" \}/);
  const up = read("server/db/schema_071_campaign_attribution.sql");
  const down = read("server/db/down/schema_071_campaign_attribution.down.sql");
  for (const col of ["utm_source", "utm_medium", "utm_campaign"]) {
    assert.match(up, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} TEXT;`));
    assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${col};`));
  }
});

test("the browser sends the campaign with a booking and a date request, and what it stores is disclosed and cleared", () => {
  assert.match(read("src/main.jsx"), /refCode: getStoredRef\(\), \.\.\.getCampaign\(\)/);
  assert.match(read("src/TourDetail.jsx"), /\.\.\.getCampaign\(\),/);
  assert.match(read("site/cookies.html"), /<code>sawa_utm<\/code><\/td><td>Sawa<\/td><td>Local storage<\/td><td>Functional<\/td>/);
  assert.match(read("site/assets/consent.js"), /localStorage\.removeItem\("sawa_utm"\)/);
  const referral = read("src/referral.js");
  const capture = referral.slice(referral.indexOf("function captureCampaign()"), referral.indexOf("function getCampaign()"));
  assert.match(capture, /if \(!choice\.functional\) return;/, "stored only after functional consent");
});
