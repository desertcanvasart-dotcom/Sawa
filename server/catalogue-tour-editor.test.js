// "Edit day tour" for catalogue products (catalogue_v2, 29 Sep 2026): the three
// tiers come from the published rate card, rounded up; a tour with no published
// version says it can't be booked; catalogue products hide the legacy fields;
// legacy tours and flag-off are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tierPriceEur, tierPriceSummary } from "../shared/pool-model.js";
const tierPriceEurCheck = tierPriceEur;
import { catalogueTourView, isCatalogueTour, NO_RATE_CARD, NO_EXCHANGE_RATE } from "../shared/catalogue-tour-editor.js";

// The module reaches the DB layer, which only builds a pool (no connection) and wants the URL set.
process.env.DATABASE_URL ||= "postgres://unit:unit@127.0.0.1:1/unit";
const { catalogueTourInfo } = await import("./catalogue-tour-pricing.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const PRODUCT = { id: 1, catalogue_no: 1, code: "GIZA", slug: "giza", title: "Giza", type: "day_tour", base_city: "Cairo",
  status: "active", goahead_min: 4, max_group: 12, cutoff_hours: 48, legacy_product_id: "t1" };
// A catalogue_rate_cards row (066: one card per product).
const cardRow = (over = {}) => ({ product_id: 1, currency: "EGP",
  tiers: [{ from: 4, to: 6, priceEgp: 5192, operatorFeePct: 5 }, { from: 7, to: 9, priceEgp: 4307, operatorFeePct: 6 }, { from: 10, to: 12, priceEgp: 4071, operatorFeePct: 10 }],
  cost_lines: [], commission_pct: 10, ...over });
const info = (over = {}) => catalogueTourInfo({ enabled: true, productRow: PRODUCT, cardRow: cardRow(), eurRate: 97, ...over });

test("EUR prices are the EGP price over the rate, rounded up", () => {
  assert.equal(tierPriceEur(5192, 97), 54);   // 53.53
  assert.equal(tierPriceEur(4307, 97), 45);   // 44.40, up (nearest would say 44)
  assert.equal(tierPriceEur(4071, 97), 42);   // 41.97
  assert.equal(tierPriceEur(4850, 97), 50, "an exact division stays put");
  assert.equal(tierPriceEur(4851, 97), 51);
});

test("the three tiers render from the published rate card", () => {
  const view = catalogueTourView(info());
  assert.equal(view.hasRate, true);
  assert.equal(view.summary, "4–6 travelers €54 · 7–9 travelers €45 · 10–12 travelers €42");
  assert.deepEqual(view.rows.map((r) => [r.label, r.eur]), [["4–6", 54], ["7–9", 45], ["10–12", 42]]);
  assert.equal(view.rateCardLabel, "Edit prices in Rate card");
  assert.equal(view.warning, null);
  assert.equal(tierPriceSummary(cardRow().tiers, 97), view.summary, "the public page reads the same function");
});

test("one price: \"€X per person\", how it is worked out, and a link to the Rate card", () => {
  const one = info({ cardRow: cardRow({ tiers: [{ from: 4, to: 8, priceEgp: 5192, operatorFeePct: 5 }] }) });
  const view = catalogueTourView(one);
  assert.equal(view.summary, "€54 per person");
  assert.deepEqual(view.single, { eur: 54, egp: 5192, eurRate: 97, eurPriced: false });
  assert.equal(view.howWorked, "EGP 5,192 ÷ exchange rate 97, rounded up");
  assert.equal(view.rateCardLabel, "Edit price in Rate card");
  assert.equal(tierPriceEurCheck(4851, 97), 51, "rounded up, not to the nearest");
  const none = catalogueTourView(info({ cardRow: null }));
  assert.equal(none.single, null);
  assert.equal(none.warning, NO_RATE_CARD);
  assert.equal(none.rateCardLabel, "Edit price in Rate card", "the warning links to the rate card too");
});

test("no site-wide traveler rate: \"Exchange rate not set\", no euro prices", () => {
  const view = catalogueTourView(info({ eurRate: null }));
  assert.equal(view.hasRate, false);
  assert.equal(view.warning, NO_EXCHANGE_RATE);
  assert.equal(view.summary, null);
  assert.deepEqual(view.rows, []);
  assert.equal(view.single, null);
});

test("GoAhead minimum, maximum group and cut-off show read-only from the catalogue product", () => {
  const facts = Object.fromEntries(catalogueTourView(info()).facts.map((f) => [f.label, f.value]));
  assert.equal(facts["GoAhead minimum"], "4 travelers");
  assert.equal(facts["Maximum group"], "12 travelers");
  assert.match(facts["Booking cut-off"], /48/);
});

test("no rate card: the warning, no tiers", () => {
  const view = catalogueTourView(info({ cardRow: null }));
  assert.equal(view.hasRate, false);
  assert.equal(view.warning, NO_RATE_CARD);
  assert.equal(view.warning, "No rate card: this tour can't be booked");
  assert.deepEqual(view.rows, []);
  assert.equal(view.rateCardLabel, "Edit price in Rate card", "still links to the rate card");
});

test("the one rate card is what shows, at the site-wide rate", () => {
  assert.equal(catalogueTourView(info({ eurRate: 100 })).summary, "4–6 travelers €52 · 7–9 travelers €44 · 10–12 travelers €41");
});

test("catalogue products hide the legacy fields; legacy tours and flag-off show them", () => {
  assert.equal(isCatalogueTour(info()), true);
  assert.equal(isCatalogueTour({ enabled: true, catalogue: null }), false, "a legacy tour");
  assert.equal(isCatalogueTour({ enabled: false }), false, "flag off");
  assert.equal(catalogueTourView({ enabled: false }), null);
  assert.equal(catalogueTourView({ enabled: true, catalogue: null }), null);
  assert.deepEqual(catalogueTourInfo({ enabled: false, productRow: PRODUCT }), { enabled: false });
  assert.deepEqual(catalogueTourInfo({ enabled: true, productRow: undefined }), { enabled: true, catalogue: null });

  // The editor: every legacy field sits behind the catalogue check, and the
  // legacy markup is otherwise the same as before.
  const src = read("src", "AdminDashboard.jsx");
  const ed = src.slice(src.indexOf("export function ProductEditor"), src.indexOf("function PriceTierEditor"));
  assert.match(ed, /\{catView \? \(\s*<Field label="Pricing and group size"/);
  const legacyStart = ed.indexOf(") : (<>");
  const legacyEnd = ed.indexOf("</>)}", ed.indexOf("Deposit %", legacyStart)); // past the sliding-mode fragment inside it
  const legacy = ed.slice(legacyStart, legacyEnd);
  for (const label of ["Min seats (GoAhead)", "Max seats (cap)", "GoAhead price", "Break price (full group)", "<PriceTierEditor", "Deposit %"]) {
    assert.ok(legacy.includes(label), `${label} is inside the legacy-only branch`);
  }
  assert.match(ed, /\{!catalogueOwned && \(\s*<Field label="Booking cutoff \(before departure\)">/);
  assert.match(ed, /\{!agencyMode && !catalogueOwned && \(\s*<Field label="Operating company"/);
  assert.match(src, /Use the sliding price instead/, "the sliding-price control is still in PriceTierEditor, which only the legacy branch renders");
});

test("the public tour page and the widget read the same summary", () => {
  assert.match(read("server", "catalogue-public.js"), /summary: tierPriceSummary\(rate\.tiers, eurRate\)/);
  assert.match(read("server", "catalogue-public.js"), /priceSummary: entry\.pricing\?\.summary/);
  const main = read("src", "main.jsx");
  assert.equal((main.match(/catalogue\?\.priceSummary/g) || []).length >= 3, true, "tour page, widget card, widget booking panel");
});
