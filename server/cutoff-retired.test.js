// departures.cutoff is retired (039) — these pin the ways it could creep back.
//
// The column was a free-text label, "Open until 18:00" by default, written by
// every departure INSERT and shown in the agency desk as the cutoff. The
// cutoff the system enforces is bookingClosed() reading the tour's
// booking_cutoff_hours (038: plus the unit it was expressed in). Until this
// change, an agency could read "Open until 18:00" on a date whose bookings
// had closed the previous evening — the exact claim-vs-code drift this repo
// exists to hunt, aimed at its own staff instead of a traveller.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("nothing writes or accepts the decorative label any more", () => {
  for (const f of ["server/app.js", "server/db/seed.js", "server/db/mappers.js"]) {
    const src = read(f);
    assert.ok(!src.includes("Open until 18:00"), `${f} still writes the decorative default`);
    // Bare `cutoff` catches the column in SQL lists, the zod field and the
    // mapper key, while leaving booking_cutoff_hours / bookingCutoffUnit /
    // cutoffLabel alone. Comment lines are excluded — prose may still say the
    // word; code may not.
    const bare = src.split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .filter((l) => /(?<![A-Za-z_])cutoff(?![A-Za-z_])/.test(l));
    assert.deepEqual(bare, [], `${f} still references the bare cutoff column`);
  }
});

test("the agency desk pill renders the enforced rule", () => {
  const src = read("src/main.jsx");
  assert.ok(!src.includes("{selected.cutoff}"), "the pill reads the dropped column again");
  assert.match(src, /Cutoff \{cutoffLabel\(info\.bookingCutoffHours \?\? 24, info\.bookingCutoffUnit\)\}/,
    "the pill must phrase the cutoff via cutoffLabel from the enforced hours");
});

test("the 24 fallback in the pill is bookingClosed's own fallback", () => {
  // The pill says "24h before" when no product is attached because
  // bookingClosed() applies exactly that default. If the default there ever
  // changes, this fails and the pill follows it — instead of becoming the
  // next decorative label.
  assert.match(read("server/domain.js"), /bookingCutoffHours \?\? 24/);
});

test("039 is registered and the fresh-install schema agrees", () => {
  assert.match(read("server/db/migrate.js"), /schema_039_drop_decorative_cutoff\.sql/);
  const schema = read("server/db/schema.sql");
  assert.ok(!/^\s*cutoff\s+TEXT,/m.test(schema), "schema.sql still creates the column 039 drops");
});
