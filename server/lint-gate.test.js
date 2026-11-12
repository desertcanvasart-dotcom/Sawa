// The lint step (scripts/lint.js), proven to fire: each defect it exists to
// stop is planted, and the step must fail on it. A linter that is configured
// but never fails anything reads exactly like a clean codebase.
import test from "node:test";
import assert from "node:assert/strict";
import { lintSource, verdict } from "../scripts/lint.js";

const errorsOf = async (code, file) => (await lintSource(code, file)).filter((m) => m.severity === 2).map((m) => m.ruleId);

test("an undefined name on the server is an error", async () => {
  assert.deepEqual(await errorsOf("export const total = (rows) => rows.length + loadEnriched();\n", "server/planted.js"), ["no-undef"]);
});

test("a component used in JSX but never imported is an error; one that is imported is not reported unused", async () => {
  assert.deepEqual(await errorsOf("import React from \"react\";\nexport const A = () => <Missing />;\n", "src/planted.jsx"), ["react/jsx-no-undef"]);
  const ok = await lintSource("import React from \"react\";\nimport { B } from \"./b.jsx\";\nexport const A = () => <B />;\n", "src/planted.jsx");
  assert.deepEqual(ok, []);
});

test("a hook called conditionally is an error", async () => {
  const code = "import React, { useState } from \"react\";\nexport function A({ on }) {\n  if (on) { const [x] = useState(0); return <i>{x}</i>; }\n  return null;\n}\n";
  assert.deepEqual(await errorsOf(code, "src/planted.jsx"), ["react-hooks/rules-of-hooks"]);
});

test("an unused name is a warning: shown, and not a failure", async () => {
  const messages = await lintSource("const unused = 1;\nexport const x = 2;\n", "server/planted.js");
  assert.deepEqual(messages.map((m) => [m.ruleId, m.severity]), [["no-unused-vars", 1]]);
  const v = verdict([{ filePath: "/repo/server/planted.js", messages }], { root: "/repo" });
  assert.deepEqual([v.pass, v.errors.length, v.warnings.length], [true, 0, 1]);
});

test("the verdict fails on any error, and on a run that linted nothing", () => {
  const bad = verdict([{ filePath: "/repo/server/a.js", messages: [{ severity: 2, ruleId: "no-undef", message: "'x' is not defined.", line: 3, column: 7 }] }], { root: "/repo" });
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.errors, [{ where: "server/a.js:3:7", rule: "no-undef", message: "'x' is not defined." }]);
  const empty = verdict([]);
  assert.equal(empty.pass, false);
  assert.match(empty.line, /no files were linted/);
});
