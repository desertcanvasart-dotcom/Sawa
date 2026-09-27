// The Tours & Packages CSV export: one row per product, every detail column
// present, and a file Excel opens cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toursCsv, htmlToText } from "./tour-export.js";

const fixture = JSON.parse(readFileSync(new URL("../site/_dev_bootstrap.json", import.meta.url), "utf8"));
const products = fixture.tourProducts;

// Minimal RFC 4180 parser — enough to prove the quoting round-trips.
function parse(text) {
  const rows = []; let row = []; let cur = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; }
    else cur += c;
  }
  row.push(cur); rows.push(row);
  return rows;
}

test("one row per product, with names and details", () => {
  const csv = toursCsv(products, "https://sawa.tours");
  assert.ok(csv.startsWith("﻿"), "without a BOM Excel mangles the arrows in package routes");
  const [head, ...rows] = parse(csv.slice(1));
  assert.equal(rows.length, products.length);
  for (const col of ["Name", "Type", "Cities", "Duration", "GoAhead price (EUR)", "Break price (EUR)", "Description", "Itinerary", "Included", "Page"]) {
    assert.ok(head.includes(col), `missing column ${col}`);
  }
  rows.forEach((r) => assert.equal(r.length, head.length, "a cell broke out of its quotes"));

  const at = (r, col) => r[head.indexOf(col)];
  const pkg = products.find((p) => p.type === "package");
  const row = rows[products.indexOf(pkg)];
  assert.equal(at(row, "Name"), pkg.title);
  assert.equal(at(row, "Type"), "Package");
  assert.equal(at(row, "Cities"), pkg.cities.join(" → "));
  assert.equal(at(row, "GoAhead price (EUR)"), String(pkg.publishedRate));
  assert.match(at(row, "Itinerary"), /^Day 1 \(Cairo\): Arrival in Cairo/);
  assert.match(at(row, "Page"), /^https:\/\/sawa\.tours\/package\//);
  assert.ok(!/<[a-z]/i.test(at(row, "Overview")), "HTML tags leaked into the overview");
});

test("quotes, commas and newlines survive; formulas are neutralized", () => {
  const p = { id: "tour_x", type: "day_tour", title: '=HYPERLINK("x"), "quoted"', city: "Cairo", description: "line one\nline two", minSeats: 4 };
  const [head, row] = parse(toursCsv([p]).slice(1));
  assert.equal(row[head.indexOf("Name")], `'=HYPERLINK("x"), "quoted"`);
  assert.equal(row[head.indexOf("Description")], "line one\nline two");
  assert.equal(row[head.indexOf("GoAhead (min travelers)")], "4");
});

test("an empty list still gives a header row", () => {
  assert.equal(parse(toursCsv([]).slice(1)).length, 1);
});

test("rich text becomes plain text", () => {
  assert.equal(htmlToText("<h3>About</h3><p>Sun &amp; sand<br/>all day</p><ul><li>Water</li></ul>"), "About\nSun & sand\nall day\n• Water");
});
