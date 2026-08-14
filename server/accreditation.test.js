// The two marks in the hero, and the graph that has to agree with them.
//
// The homepage asserts two credentials visually — the Ministry of Tourism &
// Antiquities seal and the ETAA wordmark. `accreditations` was empty, so a human
// saw the claim and a search engine saw nothing. Confirmed held by the client on
// 14 August 2026 and now stated in both places.
//
// The danger this file guards is the OTHER direction. ETAA 2179 is Capital
// Travel Service's number, not the operating entity's; it sat in the footer for
// months because CTS was presented as the platform's operator. A credential is
// exactly the kind of claim that gets restored from memory by someone tidying
// up. (The entity is deliberately not named here — entity-disclosure.test.js
// registers every file that writes it, and each one is an edit when the
// registered name arrives.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, travelAgencySchema } from "./brand.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const graph = travelAgencySchema();

test("both credentials reach the graph", () => {
  assert.equal(BRAND.accreditations.length, 2);
  assert.ok(Array.isArray(graph.hasCredential), "hasCredential is not emitted");
  assert.equal(graph.hasCredential.length, 2);
  for (const c of graph.hasCredential) {
    assert.equal(c["@type"], "EducationalOccupationalCredential");
    assert.ok(c.recognizedBy?.name, `${c.name} names no recognising body`);
    assert.ok(["license", "membership"].includes(c.credentialCategory), c.credentialCategory);
  }
});

test("the graph names the same two bodies the hero shows", () => {
  // The point of populating this: a logo a human can see and a graph that says
  // nothing is a claim with no evidence in the only place a machine looks.
  const html = read("site/index.html");
  const row = /<div class="hero-accred">[\s\S]*?<\/div>/.exec(html);
  assert.ok(row, "the hero no longer carries the accreditation row");
  const alts = [...row[0].matchAll(/alt="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(alts.length, 2);

  const bodies = graph.hasCredential.map((c) => c.recognizedBy.name + " " + (c.recognizedBy.alternateName || ""));
  assert.ok(bodies.some((b) => /Ministry of Tourism/i.test(b)), "the ministry credential is missing");
  assert.ok(bodies.some((b) => /ETAA|Egyptian Travel Agents/i.test(b)), "the ETAA credential is missing");
  // and the images assert the same two
  assert.ok(alts.some((a) => /Ministry of Tourism/i.test(a)));
  assert.ok(alts.some((a) => /Egyptian Travel Agents|ETAA/i.test(a)));
});

test("no licence number is asserted, because none was supplied", () => {
  // A number is the specific, checkable half of a credential and must come from
  // the holder. The client confirmed the credentials, not their identifiers.
  const json = JSON.stringify(graph.hasCredential);
  assert.ok(!/\d{3,}/.test(json), `a numeric identifier appeared: ${json.match(/\d{3,}/)}`);
  assert.equal(graph.hasCredential.length, 2);   // DIR-14 — an empty list proves nothing
  for (const c of graph.hasCredential) {
    assert.equal(c.identifier, undefined, "add an identifier only when the real number arrives");
  }
});

test("Capital Travel Service's ETAA number is still nowhere near this", () => {
  // The regression that would matter most: restoring 2179 as though it were
  // the operating entity's. server/entity-disclosure.test.js sweeps for the
  // string; this asserts it specifically cannot enter through the credential.
  assert.ok(!/2179/.test(JSON.stringify(BRAND)));
  assert.ok(!/2179/.test(read("server/brand.js").replace(/^\s*\/\/.*$/gm, "")));
});

test("the registration number stays the entity's, not a credential's", () => {
  // 148500 is the operating entity's company registration and is emitted as `identifier`
  // on the organisation. It is not a tourism licence and must not migrate into
  // hasCredential, where it would read as one.
  assert.equal(graph.identifier.value, "148500");
  assert.ok(!JSON.stringify(graph.hasCredential).includes("148500"));
});
