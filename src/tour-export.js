// CSV export of the Tours & Packages list — every field an operator needs to
// brief a partner or check the catalog in a spreadsheet, one row per product.
//
// Kept apart from the component so the output can be tested without a DOM.
import { tourPath } from "../shared/slug.js";
import { operatingDaysLabel, operatingDaysOf } from "../shared/operating-days.js";
import { CURRENCY } from "../shared/currency.js";

// Rich-text fields are stored as HTML; a spreadsheet wants the words.
export function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

const list = (a) => (Array.isArray(a) ? a.filter(Boolean).join("; ") : "");
const isPkg = (p) => p.type === "package";

const COLUMNS = [
  ["Name", (p) => p.title],
  ["Type", (p) => (isPkg(p) ? "Package" : "Day tour")],
  ["Cities", (p) => (isPkg(p) ? (p.cities?.length ? p.cities : [p.city]).join(" → ") : p.city)],
  ["Duration", (p) => p.duration],
  ["Nights", (p) => (isPkg(p) ? p.nights : "")],
  ["Start time", (p) => p.defaultTime],
  ["Runs on", (p) => operatingDaysLabel(operatingDaysOf(p)) || "Every day"],
  ["Guide", (p) => p.guide],
  ["Vehicle", (p) => p.vehicle],
  ["GoAhead (min travelers)", (p) => p.minSeats],
  ["Max travelers", (p) => p.maxSeats],
  [`GoAhead price (${CURRENCY})`, (p) => p.publishedRate],
  [`Break price (${CURRENCY})`, (p) => p.breakPrice],
  [`Base cost (${CURRENCY})`, (p) => p.baseCost],
  ["Price by group size", (p) => (p.priceTiers || []).map((t) => `${t.seats}: ${t.price}`).join("; ")],
  ["Deposit %", (p) => p.depositPercent],
  ["Booking cutoff (hours)", (p) => p.bookingCutoffHours],
  ["Accommodation", (p) => (p.accommodationTiers || []).map((t) => t.name).filter(Boolean).join("; ")],
  ["Description", (p) => p.description],
  ["Overview", (p) => htmlToText(p.overviewHtml)],
  ["Itinerary", (p) => (p.itinerary || [])
    .map((d) => `Day ${d.day}${d.city ? ` (${d.city})` : ""}: ${d.title || ""}`.trim()).join("\n")],
  ["Included", (p) => list(p.included)],
  ["Not included", (p) => list(p.notIncluded)],
  ["What to bring", (p) => list(p.whatToBring)],
  ["Meeting point", (p) => p.meetingPoint],
  ["Pickup note", (p) => p.pickupNote],
  ["Policies", (p) => htmlToText(p.policiesHtml)],
  ["Photos", (p) => (p.images || []).length],
  ["Page", (p, origin) => origin + tourPath(p)],
];

// Quote every cell. A text cell opening with = + - @ is read by Excel as a
// formula, so it is prefixed with an apostrophe; numbers are left alone.
function cell(v) {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toursCsv(products, origin = "") {
  const head = COLUMNS.map(([h]) => cell(h)).join(",");
  const rows = (products || []).map((p) => COLUMNS.map(([, get]) => cell(get(p, origin))).join(","));
  // CRLF and a byte-order mark so Excel opens it as UTF-8 — the arrows and
  // dashes in tour names otherwise arrive as mojibake.
  return "﻿" + [head, ...rows].join("\r\n");
}
