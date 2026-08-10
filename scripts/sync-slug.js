// DIR-8 — generate site/assets/slug.js from shared/slug.js.
//
// Nine hand copies of `tourSlug` existed: the server, the React bundle, and
// eight static pages in two naming conventions. Five of them carried a version
// predating a 301-redirect-loop fix, and the only thing holding that closed was
// every live product title happening to slugify to something.
//
// The static pages are hand-written documents served off disk and cannot import
// a module, which is why they had copies at all. Same answer as the board rules
// (NN2.1): generate the copy, and check that it is current.
//
//   npm run sync:slug      write site/assets/slug.js
//   npm run check:slug     fail if it is stale
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "shared", "slug.js");
const OUT = join(ROOT, "site", "assets", "slug.js");

// The names a page may call. Anything else stays private, so the generated file
// is a deliberate surface rather than "whatever happened to be exported".
const PUBLIC = ["slugify", "tourSlug", "tourPath"];

export function generate() {
  const body = readFileSync(SOURCE, "utf8")
    .replace(/^import .*?;\s*$/gm, "")
    .replace(/^export \{[\s\S]*?\} from .*?;\s*$/gm, "")
    .replace(/^export /gm, "")
    .trimEnd();

  return `// GENERATED — do not edit. Run \`npm run sync:slug\`.
//
// Source: shared/slug.js
//
// There were eight hand-written copies of this across the static pages, in two
// naming conventions, and five of them predated a 301-loop fix. This file exists
// so there is nothing left to keep in sync.
(function (global) {
  "use strict";

${body.split("\n").map((l) => (l ? "  " + l : l)).join("\n")}

  global.SawaSlug = {
${PUBLIC.map((n) => `    ${n},`).join("\n")}
  };
})(typeof window !== "undefined" ? window : globalThis);
`;
}

const isCli = process.argv[1] && process.argv[1].endsWith("sync-slug.js");
if (isCli) {
  const wanted = generate();
  const check = process.argv.includes("--check");
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch (e) {
    // A missing file is the expected first-run case; anything else is not, and
    // would otherwise be reported as "stale".
    if (e.code !== "ENOENT") throw e;
  }

  if (current === wanted) {
    console.log("site/assets/slug.js matches shared/slug.js.");
    process.exit(0);
  }
  if (check) {
    console.error("\nsite/assets/slug.js is stale.\n");
    console.error("The slug rule changed in shared/ and the browser copy was not regenerated.");
    console.error("Every static page builds tour URLs from that copy, so they would disagree");
    console.error("with the server about where a tour lives.\n");
    console.error("  npm run sync:slug\n");
    process.exit(1);
  }
  writeFileSync(OUT, wanted);
  console.log("Wrote site/assets/slug.js from shared/slug.js.");
}
