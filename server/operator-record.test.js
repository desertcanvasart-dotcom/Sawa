// The operator record: what Sawa checks, and the three fields a traveller sees.
//
// `/verify` promises every operator, in these words:
//
//   "We use your license number only to confirm your registration with the
//    Ministry of Tourism & Antiquities, and we don't share it outside Sawa."
//
// That sentence is the reason publicOperator() is a WHITELIST and not a
// redaction list — "remove these six" silently leaks the seventh column somebody
// adds next year, and the seventh could be the licence number.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publicOperator } from "./domain.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const FULL = {
  id: "ag_1", name: "Capital Travel Service", contactName: "A Person", phone: "+20 100 000 0000",
  status: "active", relationship: "operator",
  tourismLicenseNo: "SECRET-LICENCE-12345", tourismLicenseYear: 2011,
  etaaRegistrationNo: "2179", insuranceInsurer: "An Insurer", insurancePolicyNo: "POL-9",
  insuranceExpires: "2027-01-01", trackRecord: "internal notes",
  verificationState: "verified", verificationEvidence: "checked against the register",
  verifiedAt: "2026-08-14T10:00:00.000Z",
};

test("the licence number never reaches a traveller", () => {
  // The single most important assertion in this file.
  const out = JSON.stringify(publicOperator(FULL));
  assert.ok(!out.includes("SECRET-LICENCE-12345"), `licence number leaked: ${out}`);
});

test("nor does anything else given to Sawa to be checked", () => {
  const out = JSON.stringify(publicOperator(FULL));
  for (const secret of ["2179", "An Insurer", "POL-9", "internal notes",
                        "checked against the register", "+20 100 000 0000", "A Person"]) {
    assert.ok(!out.includes(secret), `"${secret}" reached the public payload`);
  }
});

test("it emits exactly four fields, and no more", () => {
  // A whitelist is only a whitelist if it is closed. If a field is added here
  // deliberately, this number changes with it — and somebody has to think.
  assert.deepEqual(Object.keys(publicOperator(FULL)).sort(),
    ["licensedSince", "name", "verified", "verifiedAt"]);
});

test("an operator record is not a verification", () => {
  // 029's point, which survives that migration's premise being wrong: a row
  // exists the moment somebody is added; `verification_state` says whether
  // anyone actually checked. The old product card put a "Verified operator"
  // badge above a row nobody had assessed, and was deleted for it.
  const unchecked = publicOperator({ ...FULL, verificationState: null });
  assert.equal(unchecked.verified, false);
  assert.equal(unchecked.verifiedAt, null, "a date without a state reads as a verification");

  const inReview = publicOperator({ ...FULL, verificationState: "in_review" });
  assert.equal(inReview.verified, false);

  const rejected = publicOperator({ ...FULL, verificationState: "rejected" });
  assert.equal(rejected.verified, false);
});

test("a verified record still carries its date", () => {
  const v = publicOperator(FULL);
  assert.equal(v.verified, true);
  assert.equal(v.verifiedAt, FULL.verifiedAt, "unfalsifiable without the date");
});

test("licensedSince is a year, never an expiry", () => {
  // An Egyptian tourism licence does not expire (035). A DATE here would invent
  // a day and a month nobody supplied.
  assert.equal(publicOperator(FULL).licensedSince, 2011);
  assert.equal(publicOperator({ ...FULL, tourismLicenseYear: null }).licensedSince, null);
});

test("no agency, no operator — never a placeholder", () => {
  for (const v of [null, undefined, {}, { name: "" }]) {
    assert.equal(publicOperator(v), null, `${JSON.stringify(v)} produced an operator`);
  }
});

// ---- the surfaces ----------------------------------------------------------

test("the public payload sends the whitelist, not the agency rows", () => {
  const app = read("server/app.js");
  assert.match(app, /operatorsByProduct: Object\.fromEntries\(/);
  assert.match(app, /\.map\(\(a\) => \[a\.id, publicOperator\(a\)\]\)/,
    "the payload must go through the whitelist");
  // The full rows stay staff-only, as they were.
  assert.match(app, /agencies: isPlatform\(user\) \? agencies\.rows\.map\(mapAgency\) : \[\]/);
});

test("the product page names an operator only when there is one", () => {
  const src = read("src/main.jsx");
  assert.match(src, /\{operator \? \(/, "the card must be conditional on the record");
  assert.match(src, /\{operator\.verified && \(/, "the badge must be conditional on the verification");
  // and it must not fall back to the guide field, which is a job description
  const card = /\{operator \? \([\s\S]*?\) : null\}/.exec(src);
  assert.ok(card, "the operator card is gone");
  assert.ok(!/tour\.guide/.test(card[0]), "the card fell back to tour.guide again");
});

test("the write path is admin-only and rate-limited", () => {
  const app = read("server/app.js");
  const route = /app\.patch\("\/api\/admin\/agencies\/:id"[^\n]*/.exec(app);
  assert.ok(route);
  for (const guard of ["requireAuth", "requireAdmin()", "writeLimiter"]) {
    assert.ok(route[0].includes(guard), `the route is missing ${guard}`);
  }
});

test("saving an operator record clears the page cache", () => {
  // The catalogue caches an operator's name into every product page; without
  // this the site keeps serving the previous record after a correction.
  const app = read("server/app.js");
  const route = app.slice(app.indexOf('app.patch("/api/admin/agencies/:id"'));
  assert.match(route.slice(0, 3000), /clearSeoCaches\(\)/);
});

// ---- assigning the operator to a listing ------------------------------------

test("an admin can assign the operating company; an agency cannot choose one", () => {
  // Only the agency self-submission path used to set agency_id, from the
  // session. There was no way for staff to attach an operator to an existing
  // listing at all — which is why 0 of 16 products had one.
  const app = read("server/app.js");
  assert.match(app, /agencyId: body\.agencyId \|\| null,/,
    "the admin route must accept an operator");
  // The agency route still takes it from the session, never the body.
  assert.match(app, /agencyId: req\.user\.agencyId/,
    "an agency must not be able to submit a listing as another company");

  const ui = read("src/AdminDashboard.jsx");
  assert.match(ui, /\{!agencyMode && \(\s*<Field label="Operating company" full>/,
    "the picker must be hidden from an agency editing its own listing");
  assert.match(ui, /\.\.\.\(agencyMode \? \{\} : \{ agencyId: f\.agencyId \|\| null \}\)/,
    "an agency's save must not carry an agencyId field at all");
});

test("an edit that says nothing about the operator does not wipe it", () => {
  // The upsert's COALESCE order is the whole rule. New-value-wins so a product
  // can be reassigned; NULL falls back so an unrelated edit leaves it alone.
  const app = read("server/app.js");
  assert.match(app, /agency_id=COALESCE\(EXCLUDED\.agency_id, tour_products\.agency_id\)/);
  assert.ok(!/agency_id=COALESCE\(tour_products\.agency_id, EXCLUDED\.agency_id\)/.test(app),
    "existing-wins means a listing can never be reassigned");
});

test("a failed operator-list fetch is shown, not swallowed", () => {
  // AAA1. An empty <select> after a failed fetch reads as "no operators exist",
  // and the admin concludes there is nobody to assign.
  const ui = read("src/AdminDashboard.jsx");
  const block = /const \[agenciesError, setAgenciesError\][\s\S]{0,900}?\}, \[agencyMode\]\);/.exec(ui);
  assert.ok(block, "the operator-list fetch is gone");
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(block[0]), "the failure is discarded");
  assert.match(block[0], /setAgenciesError/);
  assert.match(ui, /\{agenciesError\s*\n?\s*\? <small className="form-error">/,
    "the failure must reach the admin's screen");
});
