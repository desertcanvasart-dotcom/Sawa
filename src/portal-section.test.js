// The dashboard's sections are URLs, so Back returns to the previous section
// instead of leaving the site. See portal-section.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionFromPath, pathForSection } from "./portal-section.js";

const IDS = ["overview", "bookings", "book"];

test("a section path opens that section", () => {
  assert.equal(sectionFromPath("/portal/bookings", IDS, "overview"), "bookings");
  assert.equal(sectionFromPath("/portal", IDS, "overview"), "overview");
});

test("an unknown or stale section falls back rather than rendering nothing", () => {
  assert.equal(sectionFromPath("/portal/team", IDS, "overview"), "overview");
  assert.equal(sectionFromPath("/portal/", IDS, "overview"), "overview");
});

test("each section gets its own URL; the default is the bare root", () => {
  assert.equal(pathForSection("/portal", "bookings", "overview"), "/portal/bookings");
  assert.equal(pathForSection("/portal/bookings", "book", "overview"), "/portal/book");
  assert.equal(pathForSection("/portal/bookings", "overview", "overview"), "/portal");
  assert.equal(pathForSection("/agency/bookings", "book", "overview"), "/agency/book");
});
