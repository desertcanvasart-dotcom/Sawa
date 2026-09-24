import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(ROOT, "server/db/schema_041_restore_cairo_luxor_package.sql"), "utf8");
const runner = readFileSync(join(ROOT, "server/db/migrate.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("Cairo-Luxor package repair restores the exact canonical slug inputs", () => {
  assert.match(sql, /'pkg_cairo_luxor_4d'/);
  assert.match(sql, /'Cairo and Luxor 4-day discovery'/);
  assert.match(sql, /'package'/);
  assert.match(sql, /'approved'/);
});

test("Cairo-Luxor package repair follows current package policy", () => {
  assert.match(sql, /\n\s*25,\n\s*'Cairo highlights/,
    "new package must use the current 25% deposit");
  assert.ok(!/Standard \(3★\)/.test(sql), "packages must not restore a three-star tier");
  assert.match(sql, /Four-star/);
});

test("Cairo-Luxor package repair never overwrites a live record", () => {
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.ok(!/DO UPDATE/i.test(sql));
});

test("the repair is registered and runs before the web process", () => {
  assert.match(runner, /041_restore_cairo_luxor_package/);
  assert.equal(pkg.scripts.start,
    "node server/db/apply-deploy-data-fixes.js && node server/app.js");
});
