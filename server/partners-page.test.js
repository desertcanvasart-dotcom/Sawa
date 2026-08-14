// The /partners directory — the first public surface that lists operators
// standalone rather than on a tour page.
//
// Everything here rides on one rule, publicOperator()'s whitelist: a partner
// row holds a licence number, an insurance policy and a contact phone, and the
// directory may show none of them. The rows are built the same way the
// buildBody branch builds them — row → mapAgency → publicOperator — so what
// this file proves about leakage is proved about the served page, not about a
// hand-made fixture shaped conveniently.
import test from "node:test";
import assert from "node:assert/strict";
import { partnersListHtml, STATIC } from "./seo.js";
import { publicOperator } from "./domain.js";
import { mapAgency } from "./db/mappers.js";
import { scan } from "../scripts/audit-claims.js";

// A db-shaped row with every secret 025 records, as the buildBody query
// returns it. The name is Sawa's real first partner; the secrets are fixtures.
const ROW = {
  id: "ag_7", name: "Capital Travel Service", contact_name: "A Person",
  phone: "+20 100 000 0000", status: "active", relationship: "operator",
  tourism_license_no: "SECRET-LICENCE-12345", tourism_license_year: 2011,
  etaa_registration_no: "9999", insurance_insurer: "An Insurer",
  insurance_policy_no: "POL-9", insurance_expires: "2027-01-01",
  track_record: "internal notes", verification_state: "verified",
  verification_evidence: "checked against the register",
  verified_at: "2026-08-14T16:48:40.111Z",
};

const partner = (row, itineraries = 1) =>
  ({ ...publicOperator(mapAgency(row)), itineraries });

test("a verified partner renders name, licence year, and the dated verified line", () => {
  const html = partnersListHtml([partner(ROW)]);
  assert.match(html, /<h2>Capital Travel Service<\/h2>/);
  assert.match(html, /since 2011/);
  assert.match(html, /Verified by Sawa · /);
  assert.match(html, /Operates one itinerary on Sawa/);
});

test("an unverified partner is listed by name, without the verified line", () => {
  // 029's rule: a record is a partner; verification is a separate claim. The
  // fabricated-operator-card defect was exactly a "Verified operator" heading
  // over a row nobody had assessed.
  const html = partnersListHtml([partner({ ...ROW, verification_state: null, verified_at: null }, 0)]);
  assert.match(html, /<h2>Capital Travel Service<\/h2>/);
  assert.doesNotMatch(html, /Verified/);
  assert.doesNotMatch(html, /Operates/, "zero approved listings must not be credited as operating");
});

test("nothing given to Sawa to be checked reaches the page", () => {
  const html = partnersListHtml([partner(ROW)]);
  for (const secret of ["SECRET-LICENCE-12345", "9999", "An Insurer", "POL-9",
    "internal notes", "checked against the register", "+20 100 000 0000", "A Person"]) {
    assert.ok(!html.includes(secret), `"${secret}" reached the directory`);
  }
});

test("the empty directory says so instead of looking broken", () => {
  const html = partnersListHtml([]);
  assert.match(html, /No operating partner is listed here yet/);
  // And a non-array is refused, not rendered as nothing (catalogueListHtml's rule).
  assert.throws(() => partnersListHtml({ rows: [] }), TypeError);
  assert.throws(() => partnersListHtml(undefined), TypeError);
});

test("the rendered copy passes the claims rules — including a future partner's name", () => {
  // The company-name rule flags any company-shaped name that is not a known
  // partner, and every real second partner WILL be company-shaped. The rule's
  // exception reads ±70 characters of context, and each directory row states
  // "licensed by the Ministry of Tourism" inside that window — so a genuine
  // partner rendered by this page is suppressed by sentence structure, not by
  // someone remembering to extend an allow-list. Proved here with a name that
  // is on nobody's list.
  const future = { ...ROW, id: "ag_9", name: "Horus Valley Travel", verification_state: null, verified_at: null };
  const html = partnersListHtml([partner(ROW), partner(future, 0)]);
  const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.deepEqual(scan(visible, "partners-fixture"), []);
  // The head copy is scanned too — it ships to every crawler on the route.
  assert.deepEqual(scan(`${STATIC["/partners"].title} ${STATIC["/partners"].description}`, "partners-head"), []);
});
