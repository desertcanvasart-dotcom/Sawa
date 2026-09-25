// F01 + F05, from the 25 Sep 2026 audit.
//
// F05: the pages offered "Reserve a seat" on dates past their booking cutoff,
// which the server then refused. The server now publishes bookingClosesAt from
// the same computation bookingClosed() uses, and every page filters on it.
//
// F01: the booking form cleared itself before the server answered, and the tour
// page never rendered the error — so a refusal looked like nothing happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { bookingClosed, enrichDeparture } from "./domain.js";
import { isBookingOpen } from "../shared/departure-state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const product = { bookingCutoffHours: 24 };
const dep = (date, time = "08:00") => ({ id: 1, date, time, minSeats: 4, maxSeats: 12, pledges: [], status: "open" });

// Each case is a departure, including both of Egypt's DST changes (last Friday
// of April / October), where a fixed offset would move the cutoff an hour.
const CASES = [dep("2026-09-26"), dep("2026-04-25", "07:00"), dep("2026-10-31", "09:30"), dep("2026-12-01")];

test("F05: the page and the server close a date at the same instant", () => {
  assert.ok(CASES.length > 0);
  for (const d of CASES) {
    const enriched = enrichDeparture(d, product);
    const at = Date.parse(enriched.bookingClosesAt);
    assert.ok(!Number.isNaN(at), "bookingClosesAt is published");
    for (const t of [at - 60_000, at, at + 1, at + 60_000]) {
      assert.equal(isBookingOpen(enriched, t), !bookingClosed(d, product, t),
        `${d.date} ${d.time} at ${new Date(t).toISOString()}: page and server disagree`);
    }
  }
});

test("F05: the audit's case — Sep 26 08:00 with a 24h cutoff is closed on Sep 25 at 09:00 Cairo", () => {
  const enriched = enrichDeparture(dep("2026-09-26"), product);
  const nineAmCairo = Date.parse("2026-09-25T06:00:00Z"); // EEST, UTC+3
  assert.equal(isBookingOpen(enriched, nineAmCairo), false);
});

test("F05: the browser copy of the rule is the shared one", () => {
  const ctx = {};
  vm.runInNewContext(read("site", "assets", "rules.js"), ctx);
  const d = enrichDeparture(dep("2026-09-26"), product);
  const at = Date.parse(d.bookingClosesAt);
  assert.equal(ctx.SawaRules.isBookingOpen(d, at + 1), false);
  assert.equal(ctx.SawaRules.isBookingOpen(d, at - 1), true);
});

test("F05: every public list filters on it", () => {
  assert.match(read("src", "main.jsx"), /\.filter\(\(departure\) => isBookingOpen\(departure\)\)/);
  for (const page of ["index.html", "departures.html", "goahead.html"]) {
    assert.match(read("site", page), /R\.isBookingOpen\(d\)/, `site/${page}`);
  }
});

test("F01: the form waits for the server and clears only on a confirmed booking", () => {
  const main = read("src", "main.jsx");
  const reserve = main.slice(main.indexOf("async function reserve(e)"), main.indexOf("const reqIso"));
  assert.match(reserve, /const result = await onBookPublicDeparture\(/);
  const bail = reserve.indexOf("if (!result?.ok)");
  const clear = reserve.indexOf('setName(""); setEmail("")');
  assert.ok(bail > 0 && clear > bail, "the fields are cleared only after a successful result");
  assert.match(reserve, /setErr\(result\.error\)/, "the server's reason is shown on the form");
  const book = main.slice(main.indexOf("async function bookPublicDeparture("), main.indexOf("async function cancelPublicBooking("));
  assert.match(book, /return \{ ok: true \};/);
  assert.match(book, /return \{ ok: false, error: message \};/);
});
