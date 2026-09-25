// U04 — the contact form opens the visitor's email app (Sawa chose to keep
// email rather than a server form). That must be clear before they type, not
// only in the confirmation afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "site", "contact.html"), "utf8");

test("the form says it opens an email app, above the fields", () => {
  const note = page.indexOf('class="cf-how"');
  const form = page.indexOf('id="contact-form"');
  assert.ok(note > 0 && note < form, "the explanation comes before the form");
  assert.match(page.slice(note, form), /opens your email app/);
  assert.match(page.slice(note, form), /wa\.me\/201092847613/, "an alternative for visitors without one");
});

test("the button names what it does", () => {
  assert.match(page, /type="submit">Open in my email app/);
  assert.doesNotMatch(page, /type="submit">Send message/);
});
