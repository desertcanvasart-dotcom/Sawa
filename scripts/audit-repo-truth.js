// Collects internal statements about what this build actually does, and fails
// if one appears that nobody has reviewed against the public claims.
//
// Every previous sweep started from a public claim and asked whether it was
// true. That method missed four times. This inverts it: the people who built
// the system already wrote down what it does — in code comments, migration
// notes, docs/STATUS.md, .env.example — and nobody had read those against the
// site. Two that surfaced incidentally were both live contradictions:
//
//   site/terms.html  "no card is requested, no processor is integrated and no
//                     authorisation hold is placed"  (six public claims said one was)
//   docs/STATUS.md   "Online payments (deposits shown, not collected)"
//
// A third turned out to be STALE rather than contradicted — STATUS.md still
// said email was in log mode, while production had been sending since 6 Aug.
// That is the caveat this script exists to enforce: an internal statement is a
// LEAD, not ground truth. It gets verified against runtime or database evidence
// and then recorded here with its verdict. Trusting one blindly produces a
// confident false report, which is the same failure as trusting the source.
//
//   node scripts/audit-repo-truth.js            fail on unregistered statements
//   node scripts/audit-repo-truth.js --list     print everything found
//   node scripts/audit-repo-truth.js --update   record current findings as reviewed
//
// The register is docs/audit/repo-truth-register.json: a reviewed statement is
// stored by a hash of its text, so re-wording it forces a fresh review rather
// than inheriting the old verdict.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = join(root, "docs", "audit", "repo-truth-register.json");

// Phrases people use when writing down what the build really does. Deliberately
// narrow: "TODO: rename this" is noise, "TODO: no processor is integrated" is a
// statement about the product.
const SIGNAL = /\b(TODO|FIXME|HACK)\b|\b(not yet|for now|currently|in the current build|does not (?:yet )?(?:exist|work|run|apply)|no processor|not collected|not implemented|log[- ]mode|stubbed?|mocked?|placeholder|one env var away|once .{0,30}(?:go(?:es)? live|is live)|until .{0,30}(?:live|exists|lands))/i;

// …and only when the statement touches something the public site claims.
const TOPIC = /\b(payment|pay|deposit|charge|card|processor|gateway|refund|money|escrow|verif\w+|licen[cs]e|review|rating|operator|agency|email|send|deliver|support|availability|24\/7|hour|count|traveller|traveler|booking|price|live|launch|production|schema|address|founder)\b/i;

// Directories walked, and the extensions that can carry a statement. Walked
// with readdirSync rather than fs.globSync: globSync does not exist on Node 20,
// which is what `npm test` runs, and the version of this that used it returned
// ZERO findings there while exiting 0 — a check that silently passes is the
// exact failure this project keeps finding.
const SOURCE_DIRS = ["server", "src", "scripts", "docs", "site"];
const SOURCE_FILES = [".env.example"];
const EXTS = new Set([".js", ".jsx", ".sql", ".md", ".html"]);
const SKIP = /node_modules|[/\\]dist[/\\]|\.test\.|docs[/\\]audit|audit-repo-truth\.js|_dev_bootstrap/;

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(join(root, dir)); } catch { return acc; }
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    if (SKIP.test(rel)) continue;
    let st;
    try { st = statSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) walk(rel, acc);
    else if (EXTS.has(rel.slice(rel.lastIndexOf(".")))) acc.push(rel);
  }
  return acc;
}

export function sourceFiles() {
  return [...SOURCE_DIRS.flatMap((d) => walk(d)), ...SOURCE_FILES.filter((f) => existsSync(join(root, f)))];
}

// DIR-13 — `files` and `read` are injectable so a test can put a statement this
// scanner MUST catch in front of it. Without that, the only thing assertable is
// that the real repository is currently clean, which is also what a scanner that
// matched nothing at all would report.
export function collect(files = sourceFiles(), read = (rel) => readFileSync(join(root, rel), "utf8")) {
  const out = [];
  if (!files.length) throw new Error("no source files found — refusing to report clean");
  for (const rel of files) {
    let lines;
    try { lines = read(rel).split("\n"); } catch { continue; }
    lines.forEach((line, i) => {
      const text = line.trim();
      if (text.length < 25 || text.length > 400) return;
      const isComment = /^\s*(\/\/|\/\*|\*|--|#|<!--|\|)/.test(text) || rel.endsWith(".md") || rel === ".env.example";
      if (!isComment) return;
      if (!SIGNAL.test(text) || !TOPIC.test(text)) return;
      const clean = text.replace(/^[\s/*<!#|-]+/, "").replace(/-->\s*$/, "").trim();
      out.push({
        id: createHash("sha256").update(clean).digest("hex").slice(0, 12),
        where: `${rel}:${i + 1}`,
        text: clean.slice(0, 300),
      });
    });
  }
  return out;
}

const loadRegister = () => (existsSync(REGISTER) ? JSON.parse(readFileSync(REGISTER, "utf8")) : { reviewed: {} });

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = collect();
  const register = loadRegister();
  const unreviewed = found.filter((f) => !register.reviewed[f.id]);

  if (process.argv.includes("--list")) {
    for (const f of found) {
      const v = register.reviewed[f.id];
      console.log(`${v ? v.verdict : "UNREVIEWED"}  ${f.where}\n    ${f.text}`);
    }
    process.exit(0);
  }

  if (process.argv.includes("--update")) {
    for (const f of unreviewed) {
      register.reviewed[f.id] = { where: f.where, text: f.text, verdict: "NEEDS-REVIEW", contradicts: null };
    }
    writeFileSync(REGISTER, JSON.stringify(register, null, 2) + "\n");
    console.log(`Recorded ${unreviewed.length} new statement(s) as NEEDS-REVIEW in ${relative(root, REGISTER)}.`);
    process.exit(0);
  }

  const needsReview = found.filter((f) => register.reviewed[f.id]?.verdict === "NEEDS-REVIEW");
  if (unreviewed.length || needsReview.length) {
    for (const f of unreviewed) console.error(`UNREGISTERED  ${f.where}\n    ${f.text}`);
    for (const f of needsReview) console.error(`NEEDS-REVIEW  ${f.where}\n    ${f.text}`);
    console.error(`\n${unreviewed.length} unregistered and ${needsReview.length} unreviewed internal statement(s).`);
    console.error(`Each describes what the build does. Read it against the public claims, then record a verdict in docs/audit/repo-truth-register.json.`);
    console.error(`\`node scripts/audit-repo-truth.js --update\` records new ones as NEEDS-REVIEW.`);
    process.exit(1);
  }
  console.log(`All ${found.length} internal build-truth statements are reviewed.`);
}
