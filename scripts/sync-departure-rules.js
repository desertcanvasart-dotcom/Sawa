// NN2.1 — generate the browser copy of the board rules from the one authority.
//
// The three static pages are hand-written HTML with inline <script> blocks.
// They cannot `import`, which is exactly why each of them ended up carrying a
// hand-written copy of isForming/isGoAhead/seatsTotal with a comment saying
// "keep in sync". They did not stay in sync — three separate divergences, none
// of which any check could see.
//
// So the copy is no longer written by hand. site/assets/rules.js is GENERATED
// from shared/departure-state.js, and `--check` fails the build if it is stale.
// Same shape as check:constants, which is the model: one authority, one check,
// and drift becomes a failing build rather than a wrong board.
//
// The transform is deliberately dumb — strip `import`/`export`, concatenate,
// append the global — because a clever one would be a third implementation.
//
// Run:   node scripts/sync-departure-rules.js
// Check: node scripts/sync-departure-rules.js --check
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site", "assets", "rules.js");

const SOURCES = [
  join(ROOT, "shared", "group-size.js"),
  join(ROOT, "shared", "departure-state.js"),
];

// The names the pages are allowed to call. Anything else stays private, so the
// generated file is a deliberate surface rather than "whatever was exported".
const PUBLIC = [
  "DEFAULT_GO_AHEAD", "MAX_GROUP_SIZE", "numberWord",
  "goAheadSeatsFor", "seatsTotal", "statusFor",
  "isFormingDeparture", "isGoAheadDeparture", "isBookingOpen",
];

export function generate() {
  const body = SOURCES.map((file) => readFileSync(file, "utf8")
    // The modules import only from each other, and both are concatenated here.
    .replace(/^import .*?;\s*$/gm, "")
    // `export const X` -> `const X`; `export function f` -> `function f`;
    // and the re-export lines, which have no meaning inside one scope.
    .replace(/^export \{[\s\S]*?\} from .*?;\s*$/gm, "")
    .replace(/^export /gm, "")
    .trimEnd()
  ).join("\n\n");

  return `// GENERATED — do not edit. Run \`npm run sync:rules\`.
//
// Source: shared/group-size.js + shared/departure-state.js
//
// The static pages used to hand-write these rules, once each, with a comment
// asking the next person to keep them in sync. They did not stay in sync. This
// file exists so there is nothing left to keep in sync.
(function (global) {
  "use strict";

${body.split("\n").map((l) => (l ? "  " + l : l)).join("\n")}

  global.SawaRules = {
${PUBLIC.map((n) => `    ${n},`).join("\n")}
  };
})(typeof window !== "undefined" ? window : globalThis);
`;
}

const isCli = process.argv[1] && process.argv[1].endsWith("sync-departure-rules.js");
if (isCli) {
  const wanted = generate();
  const check = process.argv.includes("--check");
  let current = "";
  // AAA1.3 — a missing file is the expected first-run case and "" is the right
  // substitute for it, so the substitution is written in the code rather than
  // described in a comment. A permissions or I/O error is NOT that case and
  // would otherwise be reported as "stale", sending the reader to regenerate a
  // file they cannot write.
  try {
    current = readFileSync(OUT, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    current = "";
  }

  if (current === wanted) {
    console.log("site/assets/rules.js matches shared/departure-state.js.");
    process.exit(0);
  }
  if (check) {
    console.error("\nsite/assets/rules.js is stale.\n");
    console.error("The board rules changed in shared/ and the browser copy was not regenerated,");
    console.error("which is precisely how the three static pages drifted from the server before.");
    console.error("\n  npm run sync:rules\n");
    process.exit(1);
  }
  writeFileSync(OUT, wanted, "utf8");
  console.log(`wrote ${OUT.replace(ROOT + "/", "")} (${wanted.split("\n").length} lines)`);
}
