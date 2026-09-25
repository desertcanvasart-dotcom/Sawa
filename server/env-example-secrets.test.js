// S01 — .env.example once carried the live database connection string,
// password included, in a public repository. The example must only ever hold
// placeholders; this fails the moment a real-looking credential lands in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = readFileSync(join(ROOT, ".env.example"), "utf8");

// A value counts as a placeholder when it is empty or plainly says so.
const PLACEHOLDER = /^(|YOUR[-_A-Z]*|your[-_a-z]*|<[^>]*>|changeme|xxx+|password)$/;

test("no connection string in .env.example carries a real password", () => {
  const urls = [...example.matchAll(/:\/\/([^:/@\s]+):([^@\s]+)@/g)];
  assert.ok(urls.length >= 1, "the DATABASE_URL example is gone — this test would check nothing");
  for (const m of urls) {
    assert.match(m[2], PLACEHOLDER, `a real-looking password is in .env.example (user ${m[1].replace(/\..*/, ".…")})`);
  }
});

test("key-shaped values are placeholders too", () => {
  const keys = example.split("\n")
    .map((line) => /^([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD))=(.*)$/.exec(line.trim()))
    .filter(Boolean);
  assert.ok(keys.length >= 1, "no key-shaped variables found — this test would check nothing");
  for (const m of keys) {
    assert.match(m[3].trim(), PLACEHOLDER, `${m[1]} in .env.example must be a placeholder`);
  }
});
