// Live tours and packages: the price section shows the fields of one mode only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gridRows, listingPrices } from "../shared/price-mode.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const editor = readFileSync(join(ROOT, "src", "AdminDashboard.jsx"), "utf8");

test("sliding mode: the GoAhead price and the break price are the listing's prices", () => {
  assert.deepEqual(listingPrices({ useTiers: false, rows: [], publishedRate: "540", breakPrice: "460" }), { publishedRate: 540, breakPrice: 460 });
  assert.deepEqual(listingPrices({ useTiers: false, rows: [], publishedRate: "540", breakPrice: "" }), { publishedRate: 540, breakPrice: 432 }, "auto = 80%");
  assert.match(listingPrices({ useTiers: false, rows: [], publishedRate: "", breakPrice: "" }).error, /GoAhead price must be a positive number/);
  assert.match(listingPrices({ useTiers: false, rows: [], publishedRate: "500", breakPrice: "600" }).error, /can't exceed/);
});

test("grid mode: the two prices come from the grid, so nothing else has to be entered", () => {
  const rows = [{ seats: 5, price: 530 }, { seats: 4, price: 540 }, { seats: 8, price: 500 }, { seats: 6, price: "" }];
  assert.deepEqual(gridRows(rows).map((r) => r.seats), [4, 5, 8], "priced rows only, lowest group first");
  assert.deepEqual(listingPrices({ useTiers: true, rows, publishedRate: "", breakPrice: "" }), { publishedRate: 540, breakPrice: 500 });
  assert.match(listingPrices({ useTiers: true, rows: [], publishedRate: "540", breakPrice: "460" }).error, /price for each group size/, "an empty grid is not silently saved");
});

test("the editor shows GoAhead and break price only in sliding mode, the grid only in grid mode", () => {
  assert.match(editor, /\{!useTiers && \(<>\s*<Field label=\{pkg \? "GoAhead price \/person" : "GoAhead price"\}>/);
  assert.match(editor, /<Field label="Break price \(full group\)">[\s\S]{0,200}<\/>\)\}/);
  // The grid component renders its cells only when the mode is on; off, it shows the slide sentence and a button.
  const grid = editor.slice(editor.indexOf("function PriceTierEditor"));
  assert.match(grid, /\{!on \? \(\s*<div className="tier-off">[\s\S]*?\) : \(\s*<div className="tier-grid-wrap">/);
  // A catalogue product's fields are the rate card's: the listing prices are not re-validated from hidden inputs.
  assert.match(editor, /const prices = catalogueOwned \? null : listingPrices\(/);
});
