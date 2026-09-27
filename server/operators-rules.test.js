// Model phase 2 — the operator rules with no database: the expected operator
// amount (the three worked examples in the brief), bands, rooms, the roster
// deadline, strikes in the window, and the rate card import from the real
// spreadsheet in docs/model/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedOperatorAmount, bandFor, roomsFor, rosterDeadline, datesInMonth, strikesInWindow, rateFieldsFor,
} from "../shared/operators.js";
import { readXlsx } from "./xlsx.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RATE = { perTraveler: 40, fee4_6: 150, fee7_9: 200, fee10_12: 260 };

test("worked example: 8 travelers at 40 plus the 7–9 fee of 200 is 520", () => {
  const r = expectedOperatorAmount({ type: "day_tour", rate: RATE, bandCount: 8, perHeadCount: 8 });
  assert.equal(r.total, 520);
  assert.equal(r.band, "7-9");
  assert.deepEqual(r.lines.map((l) => l.amount), [320, 200]);
});

test("worked example: two cancel before the cut-off, so 6 at 40 plus the 4–6 fee of 150 is 390", () => {
  const r = expectedOperatorAmount({ type: "day_tour", rate: RATE, bandCount: 6, perHeadCount: 6 });
  assert.equal(r.total, 390);
  assert.equal(r.band, "4-6");
});

test("worked example: two cancel after the cut-off, the frozen manifest still pays 520", () => {
  // After the cut-off the manifest is frozen at 8: late cancellations stay in
  // both the band count and the per-traveler count.
  const frozen = 8;
  const r = expectedOperatorAmount({ type: "day_tour", rate: RATE, bandCount: frozen, perHeadCount: frozen });
  assert.equal(r.total, 520);
});

test("a missing rate gives no total and names what's missing", () => {
  assert.deepEqual(expectedOperatorAmount({ type: "day_tour", rate: null, bandCount: 5 }).missing, ["rate version"]);
  const r = expectedOperatorAmount({ type: "day_tour", rate: { perTraveler: 40 }, bandCount: 5 });
  assert.equal(r.total, null);
  assert.deepEqual(r.missing, ["fee4_6"]);
});

test("cruises and multi-day pay land services per traveler plus rooms plus the band fee", () => {
  const rate = { landPerTraveler: 100, roomTwin: 500, roomSingle: 400, fee4_6: 50, fee7_9: 60, fee10_12: 70 };
  const rooms = roomsFor([{ seats: 2, roomingType: "double" }, { seats: 3, roomingType: "triple" }, { seats: 1, roomingType: "single" }]);
  assert.deepEqual(rooms, { twin: 2, single: 2 });
  const r = expectedOperatorAmount({ type: "cruise", rate, bandCount: 6, perHeadCount: 6, rooms });
  assert.equal(r.total, 6 * 100 + 2 * 500 + 2 * 400 + 50);
  assert.deepEqual(rateFieldsFor("cruise"), ["landPerTraveler", "roomTwin", "roomSingle", "fee4_6", "fee7_9", "fee10_12"]);
  assert.deepEqual(rateFieldsFor("day_tour"), ["perTraveler", "fee4_6", "fee7_9", "fee10_12"]);
});

test("bands: up to 6 (including a run below the minimum) is 4–6, 7–9, then 10–12", () => {
  assert.deepEqual([1, 3, 4, 6, 7, 9, 10, 12].map(bandFor), ["4-6", "4-6", "4-6", "4-6", "7-9", "7-9", "10-12", "10-12"]);
});

test("a month's roster is due by the 15th of the month before", () => {
  assert.equal(rosterDeadline("2026-11"), "2026-10-15");
  assert.equal(rosterDeadline("2027-01"), "2026-12-15");
  assert.equal(datesInMonth("2027-02").length, 28);
  assert.equal(datesInMonth("2028-02").length, 29);
});

test("strikes count for 90 days and not once voided", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const at = (days) => new Date(now - days * 86400000).toISOString();
  const strikes = [{ createdAt: at(1) }, { createdAt: at(89) }, { createdAt: at(91) }, { createdAt: at(2), voidedAt: at(1) }];
  assert.equal(strikesInWindow(strikes, now).length, 2);
});

test("the xlsx reader reads the rate card and the import skips its EXAMPLE rows", async () => {
  const buffer = readFileSync(join(ROOT, "docs", "model", "sawa-rate-card.xlsx"));
  const sheets = readXlsx(buffer);
  assert.ok(sheets.length >= 2, sheets.map((s) => s.name).join(", "));
  const { parseRateCard } = await import("./rates.js");
  const parsed = parseRateCard(buffer);
  assert.equal(parsed.skipped.filter((s) => s.reason === "EXAMPLE row").length, 2);
  assert.ok(parsed.rows.length >= 20, `rows: ${parsed.rows.length}`);
  assert.ok(parsed.rows.every((r) => Number.isInteger(r.catalogueNo) && r.catalogueNo > 0));
  assert.ok(!parsed.rows.some((r) => /EXAMPLE/i.test(r.product)));
  assert.ok(parsed.notes.some((n) => /currency is USD/.test(n)), parsed.notes.join("\n"));
});
