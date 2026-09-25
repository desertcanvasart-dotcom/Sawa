// F06 + F07, from the 25 Sep 2026 audit.
//
// F06: every date card linked to the bare tour URL, and the tour page opened on
//      its earliest date — a traveller who clicked 17 Nov landed on 5 Oct.
// F07: in "start your own date" mode the seat limit came from whichever
//      EXISTING date was selected (1 when the tour had none), the typed value
//      was never checked, and the price/deposit/terms summary disappeared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computePledgePricing } from "./domain.js";
import { livePriceFor } from "../shared/pricing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const main = read("src", "main.jsx");

test("F06: every date card links to its own date", () => {
  for (const page of ["departures.html", "goahead.html", "index.html"]) {
    assert.match(read("site", page), /tourSlug\(p\)\+'\?date='\+encodeURIComponent\(d\.id\)/, `site/${page}`);
  }
});

test("F06: the tour page opens on the linked date and keeps the choice in the address", () => {
  assert.match(main, /useState\(\(\) => requestedDate\(tour\)\?\.id \?\? lead\?\.id \?\? ""\)/);
  const fn = main.slice(main.indexOf("function requestedDate(tour)"), main.indexOf("function PhoneCodeStep("));
  assert.match(fn, /\(tour\.dates \|\| \[\]\)\.find\(\(d\) => String\(d\.id\) === want\)/,
    "only one of this tour's own bookable dates is honoured");
  assert.match(main, /u\.searchParams\.set\("date", String\(id\)\);/);
  assert.doesNotMatch(main, /onClick=\{\(\) => setDepId\(/, "every date pick goes through pickDate");
});

test("F06: redirects that move a tour URL keep its query", () => {
  const app = read("server", "app.js");
  assert.match(app, /return res\.redirect\(301, canonical \+ queryOf\(req\)\);/);
  assert.match(app, /return res\.redirect\(301, target \+ queryOf\(req\)\);/);
});

test("F07: the new-date quote is the price the server records for the request", () => {
  const product = {
    type: "day_tour", minSeats: 4, maxSeats: 12, publishedRate: 90, breakPrice: 70, depositPercent: 10,
    priceTiers: null,
  };
  const tiered = { ...product, priceTiers: [{ minSeats: 1, price: 95 }, { minSeats: 6, price: 80 }, { minSeats: 10, price: 72 }] };
  const sizes = [1, 2, 4, 5, 8, 12];
  assert.ok(sizes.length > 0);
  for (const p of [product, tiered]) {
    // What createDateRequest inserts: an empty date carrying the tour's rates.
    const newDate = { type: "day_tour", date: "2026-11-20", minSeats: p.minSeats, maxSeats: p.maxSeats,
      publishedRate: p.publishedRate, breakPrice: p.breakPrice, depositPercent: p.depositPercent, pledges: [] };
    for (const seats of sizes) {
      const server = computePledgePricing(newDate, p, { seats }).pricePerPerson;
      assert.equal(livePriceFor(p, seats), server, `${seats} traveler(s): page and server disagree`);
    }
  }
  assert.match(main, /: livePriceFor\(tour, nSeats\);/, "the page quotes livePriceFor(tour, party size)");
});

test("F07: the seat limit is the tour's capacity, checked on submit; the summary stays", () => {
  assert.match(main, /max=\{reqMode \? requestCapacity : Math\.max\(1, remaining\)\}/);
  const submit = main.slice(main.indexOf("async function submitDateRequest("), main.indexOf("setReqBusy(true);", main.indexOf("async function submitDateRequest(")));
  assert.match(submit, /Number\(seats\) > requestCapacity/);
  assert.doesNotMatch(main, /\{!reqMode && <div className="bk-sum">/, "the price summary is shown in request mode too");
});
