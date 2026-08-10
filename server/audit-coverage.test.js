// DIR-1 — the audit trail, and proof it covers what it claims to.
//
// BBB1 asked whether anyone had ever had their access revoked while their login
// stayed live. The answer had to be assembled from `auth.users` state plus an
// argument about what the code can and cannot do, because `audit_log` could not
// answer it: the two routes that revoke access wrote nothing to it.
//
// An audit gap is invisible until the day it is needed, and on that day it is
// too late to add. So it is a test rather than a habit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanMutatingRoutes, unaudited, EXEMPT } from "../scripts/audit-coverage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "server", "app.js"), "utf8");
const routes = scanMutatingRoutes();

test("the scanner finds the routes it is meant to judge", () => {
  // A scanner that matches nothing reports a clean repository. Same lesson as
  // the empty test run and the glob that found no files: vacuous passes render
  // identically to real ones.
  assert.ok(routes.length >= 30, `found only ${routes.length} mutating routes — the matcher is broken, not the code`);
  assert.ok(routes.some((r) => r.key === "DELETE /api/agency/staff/:id"), "the BBB1 route is not being scanned");
  assert.ok(routes.some((r) => r.audited), "no route reads as audited — the body extraction is wrong");
});

test("every mutating route records who did what", () => {
  const gaps = unaudited(routes).map((r) => `server/app.js:${r.line} ${r.key}`);
  assert.deepEqual(gaps, [], "these change state and leave no record");
});

test("every exemption carries a reason", () => {
  // An entry with no reason is how the next person learns the wrong general
  // rule — the NOT_MIRRORED discipline, applied here.
  for (const [key, why] of Object.entries(EXEMPT)) {
    assert.ok(typeof why === "string" && why.length > 40, `${key} is exempt with no real reason`);
  }
});

test("nothing that touches ACCESS is exempt", () => {
  // The bar is different for these. A noisy counter can be exempt; a route that
  // grants or removes the ability to sign in cannot, whatever the volume.
  for (const key of Object.keys(EXEMPT)) {
    assert.ok(!/staff|user|agenc(y|ies)|auth|role/i.test(key), `${key} changes access and must not be exempt`);
  }
});

test("the access routes record the OUTCOME, not just the intent", () => {
  // The specific thing BBB1 needed and could not get. `UPDATE app_users` and
  // "the login was actually revoked" are two different facts, and the second is
  // the one that was missing — the row said `disabled` while the session lived.
  for (const marker of [
    /action: "staff\.disable"[\s\S]{0,220}login/,
    /action: "staff\.update"[\s\S]{0,320}login/,
  ]) {
    assert.match(app, marker, "an access change is audited without whether it took effect");
  }
});

test("setLoginAccess opens both ways", () => {
  // DIR-1.2 — 'active' was a permitted status on both staff PATCH routes and
  // nothing lifted the ban, so re-enabling somebody wrote the row, returned
  // 200, and left them locked out. A failure printing what success prints.
  assert.match(app, /ban_duration: allowed \? "none" : "876000h"/,
    "re-enabling an account must actually restore the login");
  assert.ok(!/revokeLogin\(/.test(app), "the one-way helper is still in use");
});

test("a login change is reported in three states", () => {
  // revoked / restored / failed / no-auth-provider. Collapsing "there is no
  // auth provider" into either of the others is how `autoura: on` came to mean
  // "working".
  for (const state of ['"no-auth-provider"', '"restored"', '"revoked"', '"failed"']) {
    assert.ok(app.includes(state), `setLoginAccess cannot report ${state}`);
  }
});

test("a failed audit write is recorded, not just printed", () => {
  // DIR-1.3 — the catch was written so a failed audit does not break a booking,
  // which is right. It also made a failed audit indistinguishable from one that
  // never happened.
  const audit = readFileSync(join(ROOT, "server", "audit.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  assert.match(audit, /recordFailure\("audit"/, "a lost audit row leaves no trace anywhere");
  assert.match(audit, /recordSuccess\("audit"\)/, "without a success count, 'never worked' cannot be told from 'quiet'");
  assert.ok(!/console\.error\("audit log failed/.test(audit), "still reporting at console level only");
});

test("logAudit still never throws on an operational failure", () => {
  // The property the original comment promised and the callers rely on: an
  // audit write must not break the action it describes.
  const audit = readFileSync(join(ROOT, "server", "audit.js"), "utf8");
  assert.match(audit, /catch \(e\)/);
  assert.ok(!/throw e;/.test(audit.split("catch (e)")[1] || ""), "logAudit must not rethrow an operational failure");
});
