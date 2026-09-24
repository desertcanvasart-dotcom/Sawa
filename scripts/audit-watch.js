// PPP1.1 — audit production on a schedule, and report CHANGE as well as failure.
//
// Every gate in this project is triggered by touching the repository. On 10 Aug
// 2026 two products were added through the admin panel, adding two routes and
// the copy that came with them, and nothing ran. Claims live in database fields
// here — `blog_posts.tldr` and the FAQ JSON have both carried findings that
// source-reading missed — so a product added through the panel can introduce
// exactly the class the auditor exists to catch.
//
// The claims audit reached zero on 10 Aug 2026. **Zero is a state, not an
// achievement, and it decays.** A finding reappearing without a deploy is now
// the most likely way the gate goes quietly red.
//
// TWO SEVERITIES, deliberately — PPP1.2.
//
//   findings drift    FAILURE. A finding that was not there yesterday is a
//                     regression whether or not anyone deployed.
//
//   route count       ALERT, not failure. A new product is legitimate and
//                     expected; the client adds them. What matters is that it
//                     gets audited, which it now does. Failing on it would make
//                     this noisy within a week and then ignored — the same death
//                     as a rule that cannot pass (NNN1).
//
// The baseline is COMMITTED. A deploy that legitimately changes the numbers
// updates it in the same commit, the way check:constants works. A change against
// the committed baseline with no commit behind it is precisely the signal.
//
//   node scripts/audit-watch.js
//   node scripts/audit-watch.js --base=http://localhost:8795
//   node scripts/audit-watch.js --update      (rewrite the baseline, deliberately)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(ROOT, "docs", "audit", "claims-baseline.json");

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);

export const readBaseline = (path = BASELINE_PATH) => JSON.parse(readFileSync(path, "utf8"));

// findings -> { rule: count }, so a rule reappearing is visible even when the
// total happens to match.
export function countByRule(findings) {
  const out = {};
  for (const f of findings) out[f.rule] = (out[f.rule] || 0) + 1;
  return out;
}

export function compare(baseline, current) {
  const rules = [...new Set([...Object.keys(baseline.findings || {}), ...Object.keys(current.findings || {})])].sort();
  const drift = [];
  for (const rule of rules) {
    const was = baseline.findings?.[rule] || 0;
    const now = current.findings?.[rule] || 0;
    if (was !== now) drift.push({ rule, was, now });
  }
  return {
    drift,
    routeChange: baseline.routes === current.routes ? null : { was: baseline.routes, now: current.routes },
    // A regression is a finding that appeared. A finding that RESOLVED is drift
    // too — it is reported, and it does not fail, because the fix may simply not
    // have updated the baseline yet.
    regressed: drift.some((d) => d.now > d.was),
  };
}

// The audit and the comparison, callable in process. The scheduler imports this
// lazily — eagerly would pull the database pool into the scheduler's graph, and
// merely asking "is the scheduler enabled?" would then need a DATABASE_URL.
// Every page failing at once is the site not answering — a deploy switching
// over, a network blip — not every page's copy regressing together. Such a
// run read nothing, so it is retried before anyone is told. If the site is
// still silent after the retries, that IS worth an alert, and it is reported
// as what it is: availability, not claims.
export const UNREACHABLE_RETRY_DELAYS_MS = [2 * 60 * 1000, 5 * 60 * 1000];

export function allRoutesFailed(rendered) {
  const routes = rendered.routes.length;
  const failed = new Set(rendered.findings.filter((f) => f.rule === "fetch-failed").map((f) => f.where.split(" ")[0]));
  return routes > 0 && rendered.routes.every((r) => failed.has(r));
}

export async function renderWithRetry(render, { delays = UNREACHABLE_RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  let rendered = await render();
  let attempts = 1;
  for (const ms of delays) {
    if (!allRoutesFailed(rendered)) break;
    log(`site did not answer on any of ${rendered.routes.length} routes — retrying in ${Math.round(ms / 1000)}s`);
    await sleep(ms);
    rendered = await render();
    attempts += 1;
  }
  return { rendered, attempts, unreachable: allRoutesFailed(rendered) };
}

export async function runAuditWatch({ base, baseline = readBaseline(), retry = {} } = {}) {
  const { auditRendered, auditDatabase, auditEmailTemplates, auditBundles, metadataOwnership, coverage, setAuditBase } =
    await import("./audit-claims.js");
  setAuditBase(base);

  const { rendered, attempts, unreachable } = await renderWithRetry(auditRendered, retry);
  const db = await auditDatabase().catch((e) => ({ findings: [{ rule: "db-error", where: "database", match: e.message }], inventory: [] }));
  const emails = await auditEmailTemplates().catch((e) => ({ findings: [{ rule: "template-error", where: "email templates", match: e.message }], rendered: [] }));
  const ownership = await metadataOwnership();
  const dead = [...ownership.dead, ...ownership.orphan].map((r) => ({ rule: "dead-config", where: r, match: r }));
  const all = [...dead, ...rendered.findings, ...auditBundles(), ...emails.findings, ...db.findings];

  const current = { routes: rendered.routes.length, findings: countByRule(all) };
  return { base, current, all, degraded: coverage.degraded, attempts, unreachable, ...compare(baseline, current) };
}

const isCli = process.argv[1] && process.argv[1].endsWith("audit-watch.js");
if (isCli) {
  const BASE = arg("base", "https://sawa.tours").replace(/\/$/, "");

  if (process.argv.includes("--update")) {
    const { current, all } = await runAuditWatch({ base: BASE, baseline: { routes: 0, findings: {} } });
    writeFileSync(BASELINE_PATH, JSON.stringify({ ...current, base: BASE, updated: new Date().toISOString().slice(0, 10) }, null, 2) + "\n");
    console.log(`Baseline rewritten: ${current.routes} routes, ${all.length} finding(s).`);
    process.exit(0);
  }

  const r = await runAuditWatch({ base: BASE });
  console.log(`\nAUDIT WATCH — ${BASE}`);
  console.log(`  routes    ${r.current.routes}${r.routeChange ? `   (baseline ${r.routeChange.was})` : ""}`);
  console.log(`  findings  ${r.all.length}`);
  if (r.degraded) console.error(`  COVERAGE DEGRADED — ${r.degraded}`);
  if (r.unreachable) console.error(`  SITE DID NOT ANSWER — every route failed on all ${r.attempts} attempts`);

  // PPP1.2 — a new route is information even when the total is acceptable.
  // Route count 39 -> 41 was the signal production had moved, and nothing was
  // watching for it.
  if (r.routeChange) {
    console.log(`\nROUTE COUNT CHANGED: ${r.routeChange.was} -> ${r.routeChange.now}. Production data moved without a deploy.`);
    console.log(`  Audit the new pages individually: npm run audit:page -- --base=${BASE} <path>`);
  }
  for (const d of r.drift) {
    console[d.now > d.was ? "error" : "log"](`  ${d.now > d.was ? "WORSE" : "better"}  ${d.rule}: ${d.was} -> ${d.now}`);
  }

  if (r.regressed || r.degraded) {
    console.error("\nRED — a finding appeared without a deploy, or coverage was incomplete.\n");
    process.exit(1);
  }
  console.log(`\nGREEN — no finding appeared${r.routeChange ? ", and the route change is reported above" : ""}.\n`);
}
