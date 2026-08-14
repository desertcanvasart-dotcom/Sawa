// The tour-product upsert, EXECUTED — because twice in two days it shipped
// broken under a green suite.
//
// #163: the INSERT named 41 columns and supplied 39 values. The route's tests
// drove a fake pool, a fake accepts any SQL, and the first real connection
// refused the statement. The response was insert-arity.test.js, which reads
// the SQL as TEXT and counts expressions against columns.
//
// The very next production break was in the same function and invisible to a
// text reader: #162 moved the duration/window validation block — including the
// `blankNum` helper the INSERT's parameter list calls — into the middle of the
// admin-departures route. The SQL was perfectly formed. The function referred
// to an identifier that no longer existed in its scope, threw ReferenceError
// on every save, and h() rendered that as a bare "Server error." to the
// operator. Reading text cannot catch a scope error; only executing the
// function can. So this file executes it.
//
// The import is the reason app.js gained APP_NO_LISTEN: the module's routes
// and helpers load, the port is never bound, and the Pool never connects —
// pg pools are lazy, and everything here goes through the stub client instead.
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/never-connects";
process.env.SUPABASE_URL ||= "https://placeholder.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "placeholder-anon-key";
process.env.APP_NO_LISTEN = "1";
process.env.PAGE_WARM_INTERVAL_MS = "0";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { upsertTourProduct } = await import("./app.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A client that records every statement and answers the one SELECT loadProduct
// issues. No SQL is validated here — insert-arity.test.js owns the text; this
// file owns the fact that the code RUNS.
function stubClient() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT \* FROM tour_products/.test(sql)) {
        return { rows: [{ id: params[0], type: "day_tour", title: "A Tour", city: "Cairo",
          min_seats: 4, max_seats: 12, published_rate: 100, status: "approved" }] };
      }
      return { rows: [] };
    },
  };
}

const BODY = {
  title: "Execution Fixture Tour", type: "day_tour", city: "Cairo",
  duration: "Full day · about 8 hours", publishedRate: 100,
  minSeats: 4, maxSeats: 12,
  // Both window fields as the form sends them: one set, one cleared. The
  // cleared one is exactly what blankNum exists to turn into NULL.
  requestMinLeadDays: 3, requestMaxHorizonDays: "",
};

test("a tour save executes end to end against a stub client", async () => {
  const c = stubClient();
  const product = await upsertTourProduct(c, BODY, { status: "approved" });
  assert.ok(product, "loadProduct returned nothing — the upsert never reached the SELECT");
  const insert = c.calls.find((q) => /INSERT INTO tour_products/.test(q.sql));
  assert.ok(insert, "no INSERT was issued");
  // The two 037 parameters, through blankNum: a number stays a number, an
  // empty field becomes NULL — never 0, which would mean "same-day requests".
  assert.equal(insert.params.length, 42, "parameter count drifted from the 42 columns");
  assert.equal(insert.params[39], 3);
  assert.equal(insert.params[40], null);
  // The cutoff unit (038): BODY didn't choose one, so NULL — reads as hours.
  assert.equal(insert.params[41], null);
});

test("the validations refuse in words, in the function that owns the fields", async () => {
  // Each rejection proves its check runs HERE — the misplacement put them
  // where they threw ReferenceError instead of AppError, which a caller
  // cannot tell apart from any other 500.
  await assert.rejects(
    upsertTourProduct(stubClient(), { ...BODY, duration: "3 days · 2 nights" }, { status: "approved" }),
    (e) => e.status === 422, "a day tour with a package-shaped duration must 422, not 500");
  await assert.rejects(
    upsertTourProduct(stubClient(), { ...BODY, requestMinLeadDays: 90, requestMaxHorizonDays: 30 }, { status: "approved" }),
    (e) => e.status === 422, "a window with no days in it must 422, not 500");
  await assert.rejects(
    upsertTourProduct(stubClient(), { ...BODY, bookingCutoffHours: 36, bookingCutoffUnit: "days" }, { status: "approved" }),
    (e) => e.status === 422, "a days cutoff over non-whole days must 422, not hit the CHECK");
});

test("a cutoff chosen in days stores canonical hours plus the unit", async () => {
  const c = stubClient();
  await upsertTourProduct(c, { ...BODY, bookingCutoffHours: 72, bookingCutoffUnit: "days" }, { status: "approved" });
  const insert = c.calls.find((q) => /INSERT INTO tour_products/.test(q.sql));
  // $28 is booking_cutoff_hours, $42 the unit: enforcement keeps reading
  // hours; the unit only decides how the editor shows it back.
  assert.equal(insert.params[27], 72);
  assert.equal(insert.params[41], "days");
});

test("the departures route no longer carries the listing's validation block", () => {
  // Pins the removal. The block referenced `type` and declared `blankNum` in a
  // scope where the first does not exist and the second helps nobody — if
  // either name reappears between the admin-departures route and the next
  // route, the misplacement is back.
  const src = readFileSync(join(ROOT, "server", "app.js"), "utf8");
  const start = src.indexOf('app.post("/api/admin/departures"');
  assert.ok(start > -1, "the admin-departures route moved — update this test");
  // The route is followed by upsertTourProduct, which now rightly contains
  // the block — the slice must stop at whichever construct comes first.
  const end = Math.min(...[src.indexOf("app.post", start + 1),
    src.indexOf("function upsertTourProduct", start)].filter((i) => i > -1));
  const slice = src.slice(start, end);
  assert.doesNotMatch(slice, /durationShapeError|requestWindowError|blankNum/,
    "listing validation is back inside the departures route");
});
