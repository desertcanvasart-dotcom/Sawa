import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("server content remains visible when JavaScript or its dependencies fail", () => {
  const css = [...shell.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (selector.includes("data-server-rendered")) {
      assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden|opacity:\s*0\b/);
    }
  }
  assert.doesNotMatch(shell, /classList\.add\(["']js["']\)/);
  assert.ok(shell.includes('<div id="root"></div>'), "server injection slot must remain intact");
});

test("fallback images fit the readable article width before React loads", () => {
  assert.match(shell, /\[data-server-rendered\] img\s*\{[^}]*max-width:\s*100%/);
});
