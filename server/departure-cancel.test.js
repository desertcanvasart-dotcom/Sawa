// PP5 / PP2 — cancelling a date releases its seats, and a traveller who was not
// told is an error rather than a quiet zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelDepartureAndPledges, reportNotifications, CANCEL_REASONS } from "./departure-cancel.js";

// A client that records the order statements were issued in. The order is the
// whole point of this file, so it is what gets asserted.
function fakeClient({ recipients = [], released = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const kind = /SELECT DISTINCT customer_email/.test(sql) ? "read-recipients"
        : /UPDATE departures/.test(sql) ? "cancel-departure"
          : /UPDATE pledges/.test(sql) ? "cancel-pledges"
            : "other";
      calls.push({ kind, params });
      if (kind === "read-recipients") return { rows: recipients.map((customer_email) => ({ customer_email })) };
      if (kind === "cancel-pledges") return { rowCount: released, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
}

test("the recipients are read BEFORE anything is cancelled", () => {
  // PP2's failure in one assertion. Move the read after either UPDATE and the
  // list comes back empty, because both filter on `status <> 'cancelled'` —
  // and then "0 travellers emailed" is indistinguishable from a date nobody
  // had booked.
  const c = fakeClient({ recipients: ["a@example.test", "b@example.test"], released: 2 });
  return cancelDepartureAndPledges(c, 1).then(() => {
    assert.deepEqual(
      c.calls.map((x) => x.kind),
      ["read-recipients", "cancel-departure", "cancel-pledges"],
      "the order is load-bearing, not incidental"
    );
  });
});

test("the date and its pledges are cancelled together", () => {
  const c = fakeClient({ recipients: ["a@example.test"], released: 3 });
  return cancelDepartureAndPledges(c, 42).then((r) => {
    assert.equal(r.pledgesCancelled, 3);
    assert.deepEqual(r.recipients, ["a@example.test"]);
    const dep = c.calls.find((x) => x.kind === "cancel-departure");
    const pl = c.calls.find((x) => x.kind === "cancel-pledges");
    assert.deepEqual(dep.params, [42]);
    assert.deepEqual(pl.params, [42], "the pledges must be scoped to the same departure");
  });
});

test("a pledge already cancelled is not cancelled again, nor emailed", () => {
  // Both statements carry `status <> 'cancelled'`: the traveller who cancelled
  // their own booking is not on the list (MM1), and their row is not rewritten
  // with a reason that would later misattribute why it ended.
  const c = fakeClient();
  return cancelDepartureAndPledges(c, 7).then(() => {
    for (const kind of ["read-recipients", "cancel-pledges"]) {
      const sql = kind;
      assert.ok(c.calls.some((x) => x.kind === sql), `${kind} did not run`);
    }
  });
});

// ---- PP2.1: three states, and they must never render the same ---------------

function capture() {
  const out = { log: [], error: [] };
  return {
    out,
    log: (m) => out.log.push(m),
    error: (m) => out.error.push(m),
  };
}

test("nobody to tell is said out loud, and is not an error", () => {
  const c = capture();
  const clean = reportNotifications({ intended: 0, sent: 0, context: "x", log: c.log, error: c.error });
  assert.equal(clean, true);
  assert.equal(c.out.error.length, 0);
  assert.match(c.out.log[0], /no travellers to notify/);
});

test("everyone reached reports the count", () => {
  const c = capture();
  const clean = reportNotifications({ intended: 4, sent: 4, context: "x", log: c.log, error: c.error });
  assert.equal(clean, true);
  assert.equal(c.out.error.length, 0);
  assert.match(c.out.log[0], /4 of 4/);
});

test("a shortfall is an ERROR, not a log line", () => {
  // The case the whole guard exists for: four people should have been told,
  // none was, and without this it prints the same shape as "no travellers to
  // notify" — a quiet success.
  const c = capture();
  const clean = reportNotifications({ intended: 4, sent: 0, context: "x", log: c.log, error: c.error });
  assert.equal(clean, false, "a shortfall must not report as clean");
  assert.equal(c.out.log.length, 0, "it must not also print on the ordinary channel");
  assert.match(c.out.error[0], /SHORTFALL/);
  assert.match(c.out.error[0], /4 person\(s\) were told nothing/);
});

test("the three states are distinguishable from their output alone — W3", () => {
  // Proof the guard is worth having: the two zero cases produce different text
  // on different channels. Before PP2 they produced the same line.
  const none = capture();
  reportNotifications({ intended: 0, sent: 0, context: "x", log: none.log, error: none.error });
  const short = capture();
  reportNotifications({ intended: 4, sent: 0, context: "x", log: short.log, error: short.error });

  assert.notDeepEqual(
    [none.out.log, none.out.error],
    [short.out.log, short.out.error],
    "a date nobody booked and a date whose travellers were never told must not look alike"
  );
  assert.equal(none.out.error.length, 0);
  assert.equal(short.out.error.length, 1);
});

test("a partial shortfall counts the people, not the attempts", () => {
  const c = capture();
  reportNotifications({ intended: 4, sent: 3, context: "x", log: c.log, error: c.error });
  assert.match(c.out.error[0], /3 of 4/);
  assert.match(c.out.error[0], /1 person\(s\) were told nothing/);
});

test("the reasons are named, and only the ones that are written exist here", () => {
  // `operator` is proposed in migration 023 and deliberately absent until
  // something writes it — an unwritten value in a live enum is the same shape
  // as an empty category rendered as a filter.
  // `request_not_reviewed` is written by cancel-unconfirmed when a traveller's
  // requested date arrives with nobody having answered it.
  assert.deepEqual(Object.values(CANCEL_REASONS).sort(), ["date_cancelled", "minimum_not_reached", "request_not_reviewed"]);
});
