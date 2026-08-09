// WW3.2 — say which Node this is, and stop if it is one the app cannot run on.
//
// The repository was in two minds and neither was written down:
//
//   the SERVER could not boot on Node 20 at all — @supabase/realtime-js throws
//   "Node.js 20 detected without native WebSocket support"
//
//   the TEST SCRIPT was `node --test server/ src/`, which only Node 20 resolves;
//   under Node 22 it reported two failing "tests" that were the directories
//
// So the tests ran on 20, the server ran on 22, `engines` said ">=20", and
// nothing said any of it. The pre-commit hook then blocked every commit for
// anyone on 22 — a gate failing closed on a toolchain difference, which is the
// version of a gate that gets removed rather than fixed.
//
// A check whose result depends on an unstated environmental condition is not a
// verdict. This states it.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const required = pkg.engines?.node ?? "";
const min = Number((required.match(/(\d+)/) || [])[1]);
const running = Number(process.versions.node.split(".")[0]);

if (!min) {
  console.error("package.json declares no engines.node, so nothing can be checked.");
  process.exit(1);
}

if (running < min) {
  console.error(
    `Node ${process.version} — this project needs >=${min}.\n\n`
    + "The server does not merely warn on an older major, it fails to start:\n"
    + '  "Node.js 20 detected without native WebSocket support" (@supabase/realtime-js)\n\n'
    + `  nvm use            # .nvmrc pins ${min}\n`
  );
  process.exit(1);
}

// YY3.3 — the environment of record, at the top of every preflight.
//
// Node was not the only unstated dimension. TZ matters as much and less
// visibly: this machine's is Africa/Cairo, the ONE zone in which a
// host-timezone bug in this application is invisible, because host-based code
// and Cairo-based code agree. Nothing would have failed; the deadlines would
// just have been wrong.
const timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const locale = process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
console.log(
  `Node ${process.version} (engines: ${required}) · TZ=${timeZone} · locale=${locale}`
);
if (!process.env.TZ && timeZone === "Africa/Cairo") {
  console.log(
    "  NOTE: this host is in Africa/Cairo. `npm test` pins TZ=UTC for exactly that\n"
    + "  reason — see server/tz-boundaries.test.js."
  );
}
