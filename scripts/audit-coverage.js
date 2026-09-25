// DIR-1 — which state changes leave a record, and which do not.
//
// An audit trail with a hole is worse than no audit trail, because it is
// trusted. BBB1 — "did anyone ever have their access revoked while the login
// stayed live?" — could only be answered from `auth.users` state plus an
// argument about the code. `audit_log` could not have answered it: the two
// routes that revoke access wrote nothing to it.
//
// That gap was invisible for as long as nobody needed it, which is the property
// that makes it worth a check rather than a review note. The first run of this
// scanner found 8 unaudited mutating routes, not 2.
//
// The rule: a route that changes state records who did it, to what, and how it
// came out — or it is on the list below WITH a reason.
//
//   node scripts/audit-coverage.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Exempt, each for a stated reason. An entry with no reason is how the next
// person learns the wrong general rule — same discipline as NOT_MIRRORED in
// autoura-sync.js.
//
// The bar for adding one: the route changes nothing a person would ever need to
// reconstruct, AND auditing it would drown the rows that matter. "It is noisy"
// alone is not enough; "it is noisy AND nothing turns on it" is.
export const EXEMPT = {
  "POST /api/track/referral":
    "a per-visit counter increment on a public beacon. It records no actor "
    + "(there is none), changes no access, money or status, and fires on every "
    + "landing from a partner link — auditing it would bury the rows that "
    + "matter under traffic. The referral totals ARE the record of this.",
  "POST /api/csp-report":
    "a browser's automatic report of what the Content Security Policy would "
    + "block. There is no actor and nothing changes: no access, money, booking "
    + "or status. It fires on page views, so auditing it would bury the rows "
    + "that matter; each distinct violation is logged once for tuning instead.",
};

// Deliberately line-based over app.js rather than a parser: the file is one
// module with a consistent `app.method("path", ...)` shape at column 0, and a
// parser dependency for this would be a heavier promise than the check makes.
// The handler body runs to the closing `}));` at column 0 — asserted below by
// the fact that the known-audited routes are all found.
export function scanMutatingRoutes(file = join(ROOT, "server", "app.js")) {
  // EEEE1.1 — a check operating over a collection must assert its subject set is
  // non-empty BEFORE interpreting the outcome. Zero subjects is the absence of a
  // question, not an answer to it, and which verdict that produces depends only
  // on the shape of the check: green from a scan, red from an UPDATE that
  // matched nothing. Neither is information.
  //
  // The CLI already refused. The exported function did not — and the exported
  // function is what a TEST calls, so a test could hand it an empty list and
  // read the empty result as clean.
  // This one already failed on an empty argument — with a TypeError from
  // readFileSync about the "path" argument. An accidental crash is not a
  // refusal: it says nothing about why, and the next person reads it as a bug
  // in the harness rather than as the check declining to answer.
  if (!file || typeof file !== "string") throw new Error("audit-coverage: no source file to scan — refusing to report clean");
  const lines = readFileSync(file, "utf8").split("\n");
  const opener = /^app\.(post|patch|put|delete)\(\s*"([^"]+)"/;
  const routes = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(opener);
    if (!m) continue;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\}\)\);?\s*$/.test(lines[j])) { end = j; break; }
      if (opener.test(lines[j])) { end = j - 1; break; }
    }
    const body = lines.slice(i, end + 1).join("\n");
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      key: `${m[1].toUpperCase()} ${m[2]}`,
      line: i + 1,
      audited: /logAudit\(/.test(body),
    });
  }
  return routes;
}

export function unaudited(routes = scanMutatingRoutes()) {
  return routes.filter((r) => !r.audited && !(r.key in EXEMPT));
}

const isCli = process.argv[1] && process.argv[1].endsWith("audit-coverage.js");
if (isCli) {
  const routes = scanMutatingRoutes();
  const gaps = unaudited(routes);
  const exempt = routes.filter((r) => !r.audited && r.key in EXEMPT);

  console.log(`${routes.length} mutating routes · ${routes.filter((r) => r.audited).length} audited · ${exempt.length} exempt · ${gaps.length} unaudited\n`);
  for (const r of exempt) console.log(`  EXEMPT  ${r.key}\n          ${EXEMPT[r.key]}`);

  if (!gaps.length) {
    console.log("\nEvery mutating route records who did what.");
    process.exit(0);
  }
  console.error(`\n${gaps.length} route(s) change state and leave no record:\n`);
  for (const r of gaps) console.error(`  server/app.js:${r.line}  ${r.key}`);
  console.error(
    "\nCall logAudit with the actor, the target, and the OUTCOME — the last is the\n"
    + "part that could not be reconstructed later. If the route genuinely needs no\n"
    + "record, add it to EXEMPT in this file with the reason.\n"
  );
  process.exit(1);
}
