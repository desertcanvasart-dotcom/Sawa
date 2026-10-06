// There is no Vite config and no React plugin, so JSX compiles to
// React.createElement: a .jsx file that renders JSX without importing React
// builds fine and crashes on first render with "React is not defined". The
// booking drawer went blank in production that way (6 Oct 2026, the Review
// box), and the Group requests screen and form had the same gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const jsx = readdirSync(here).filter((f) => f.endsWith(".jsx"));
const rendersJsx = (src) => /return\s*\(?\s*<|=>\s*\(?\s*<[A-Za-z>]/.test(src);
const importsReact = (src) => /^import React\b/m.test(src);

test("every .jsx file that renders JSX imports React", () => {
  const rendering = jsx.filter((f) => rendersJsx(readFileSync(join(here, f), "utf8")));
  assert.ok(rendering.length > 10, `only ${rendering.length} JSX files found — refusing to report clean`);
  assert.deepEqual(rendering.filter((f) => !importsReact(readFileSync(join(here, f), "utf8"))), [],
    "these render JSX without importing React, so they crash on first render");
});

test("it fires — a component without the import is caught", () => {
  const src = 'import { useState } from "react";\nexport function X() { return <div />; }';
  assert.ok(rendersJsx(src) && !importsReact(src));
});
