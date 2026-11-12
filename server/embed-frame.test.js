// The partner widget (/embed/*) runs inside another company's page.
//
// 12 Nov 2026: with the site's scripts loaded there, Sawa's cookie banner
// opened inside the agency's site, over the booking form, and Sawa's analytics
// ran on a page that is not Sawa's. And the widget sent the visitor to
// sawa.tours to read the tour, which is the thing it exists to avoid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
const { buildHead } = await import("./seo.js");
const { keepLinksOutOfFrame } = await import("../src/embed-links.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = /assets\/(consent|analytics|gtm)\.js/;

test("the widget's head loads no consent banner and no analytics", async () => {
  for (const path of ["/embed", "/embed/book", "/embed/book/tour/some-tour", "/embed/tour/some-tour"]) {
    const { head } = await buildHead(path);
    assert.doesNotMatch(head, SCRIPTS, `${path} must not load the site's consent or analytics scripts`);
    assert.match(head, /noindex/, `${path} stays out of search`);
  }
});

test("every other page still loads them: the guard is for the frame only", async () => {
  for (const path of ["/", "/itineraries", "/faq"]) {
    const { head } = await buildHead(path);
    for (const name of ["consent", "analytics", "gtm"]) assert.match(head, new RegExp(`assets/${name}\\.js`), `${path} lost ${name}.js`);
  }
});

test("a link clicked inside the widget opens a new tab and never navigates the frame", () => {
  const opened = [];
  globalThis.window = { location: { origin: "https://sawa.tours" }, open: (url, target) => opened.push([url, target]) };
  const click = (href, target = "") => {
    let prevented = false;
    const a = { target, getAttribute: () => href };
    keepLinksOutOfFrame({ target: { closest: () => a }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  try {
    assert.equal(click("/terms"), true);
    assert.deepEqual(opened.pop(), ["https://sawa.tours/terms", "_blank"]);
    assert.equal(click("https://example.com/x"), true);
    assert.equal(click("https://example.com/x", "_blank"), false, "already a new tab: left alone");
    assert.equal(click("#reviews"), false);
    assert.equal(click("mailto:hello@sawa.tours"), false);
    assert.equal(opened.length, 1);
  } finally { delete globalThis.window; }
});

test("the booking view shows the tour and its terms, and no link to sawa.tours for the itinerary", () => {
  const src = readFileSync(join(ROOT, "src", "main.jsx"), "utf8");
  const view = src.slice(src.indexOf("function EmbedBookTour("), src.indexOf("function SectionHeading("));
  assert.ok(view.length > 2000, "EmbedBookTour not found");
  for (const part of ["<EmbedGallery", "<EmbedOverview", "<EmbedTourDetails", "<TourReviews", "<PaymentTimeline", "<CancellationSchedule", "onClickCapture={keepLinksOutOfFrame}"]) {
    assert.ok(view.includes(part), `the widget's booking view lost ${part}`);
  }
  assert.doesNotMatch(view, /Full itinerary/, "the itinerary is in the widget; a link out for it has come back");
});
