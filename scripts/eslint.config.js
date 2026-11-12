// Lint, as a gate step (scripts/lint.js), which passes this file to ESLint. Added after the review of 12 Nov 2026.
//
// Errors fail the gate: an undefined name, a hook called conditionally, a
// duplicate key — things that are wrong whatever the author meant. Warnings
// (unused names, hook dependency lists) are printed and do not fail it; bring
// the count down as files are touched, then promote them.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "public/**", "site/**", "docs/**", "content/**", "Tours/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { react, "react-hooks": hooks },
    rules: {
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "react/jsx-no-undef": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      // Deliberate in this codebase: empty catch blocks are policed by
      // check:catch-handlers; `<\/script>` is escaped on purpose inside inlined
      // HTML; and the PDF text cleaner matches a literal non-breaking space.
      "no-empty": "off",
      "no-useless-escape": "off",
      "no-regex-spaces": "off",
      "no-irregular-whitespace": ["error", { skipRegExps: true, skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },
  { files: ["**/*.cjs"], languageOptions: { sourceType: "commonjs" } },
];
