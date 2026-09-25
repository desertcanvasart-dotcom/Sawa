// P01 — the Supabase auth library (~200 kB minified) loaded on every public
// page although anonymous visitors never sign in. It now lives in
// supabaseAuth.js, imported only by the lazy-loaded sign-in screen and loaded
// on demand by apiFetch when a saved session exists. Main bundle 541 → 334 kB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");

test("nothing on the public path imports the Supabase library up front", () => {
  assert.doesNotMatch(read("supabaseClient.js"), /^import .*@supabase\/supabase-js/m);
  assert.doesNotMatch(read("main.jsx"), /^import .*supabaseAuth/m);
  assert.doesNotMatch(read("main.jsx"), /import \{[^}]*\bsupabase\b[^}]*\} from "\.\/supabaseClient"/);
  assert.match(read("supabaseClient.js"), /await import\("\.\/supabaseAuth\.js"\)/, "loaded on demand");
  assert.match(read("main.jsx"), /const LoginGate = lazy\(/, "the one static importer stays lazy");
});

test("a saved session is detected from Supabase's own storage key", async () => {
  const { mayHaveSession } = await import("./session-hint.js");
  const store = (keys) => ({ length: keys.length, key: (i) => keys[i] });
  assert.equal(mayHaveSession(store([])), false);
  assert.equal(mayHaveSession(store(["theme", "sawa-ref"])), false);
  assert.equal(mayHaveSession(store(["sb-pajwixqdvedscleckxdx-auth-token"])), true);
  assert.equal(mayHaveSession({ get length() { throw new Error("blocked"); } }), true, "unreadable storage: assume a session");
  assert.match(read("supabaseClient.js"), /if \(mayHaveSession\(\)\) \{/);
});

test("a login chunk that fails to load doesn't take the request down", () => {
  const src = read("supabaseClient.js");
  const fn = src.slice(src.indexOf("export async function apiFetch("));
  assert.match(fn, /try \{\s*const \{ supabase \} = await import\("\.\/supabaseAuth\.js"\);/);
  assert.match(fn, /catch \(e\) \{\s*warnOnce\("auth-load"/);
});
