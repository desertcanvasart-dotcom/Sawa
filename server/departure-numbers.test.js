// Numbered departures (29 Sep 2026): the routing rules, as pure functions.
import test from "node:test";
import assert from "node:assert/strict";
import { pickDeparture, allFull, nextNumber, shownDeparture, placeParty, isFull } from "../shared/departure-numbers.js";

const dep = (no, free, over = {}) => ({ id: 100 + no, no, free, joinable: true, ...over });

test("a booking goes to the lowest-numbered departure with room for the WHOLE party", () => {
  assert.equal(pickDeparture([dep(1, 5), dep(2, 8)], 3).no, 1);
  assert.equal(pickDeparture([dep(1, 2), dep(2, 8)], 3).no, 2, "a party of 3 does not fit the 2 seats left on departure 1");
  assert.equal(pickDeparture([dep(1, 2), dep(2, 2)], 3), null, "it fits nowhere: the system opens the next");
  assert.equal(pickDeparture([dep(2, 8), dep(1, 8)], 1).no, 1, "the lowest number, whatever the order of the list");
});

test("a departure that is not taking bookings is skipped", () => {
  assert.equal(pickDeparture([dep(1, 8, { joinable: false }), dep(2, 8)], 1).no, 2);
  assert.equal(pickDeparture([dep(1, 8, { joinable: false })], 1), null);
});

test("full means no free seat; the next opens only when every departure is full", () => {
  assert.equal(isFull(dep(1, 0)), true);
  assert.equal(allFull([dep(1, 0), dep(2, 0)]), true);
  assert.equal(allFull([dep(1, 0), dep(2, 3)]), false);
  assert.equal(allFull([dep(1, 0, { joinable: false }), dep(2, 0)]), true, "a closed departure does not count");
  assert.equal(allFull([]), false);
  assert.equal(nextNumber([dep(1, 0), dep(2, 0)]), 3);
  assert.equal(nextNumber([]), 1);
});

test("the public date shows the departure a new booking would join; a full one is never shown", () => {
  assert.equal(shownDeparture([dep(1, 0), dep(2, 6)]).no, 2);
  assert.equal(shownDeparture([dep(1, 1), dep(2, 8)]).no, 1);
  assert.equal(shownDeparture([dep(1, 0), dep(2, 0)]), null);
});

test("a party is never split: it stays if the joiners fit, otherwise it moves together", () => {
  const sibs = [dep(1, 1), dep(2, 8)];
  assert.deepEqual(placeParty(sibs, { partyOn: 101, partySeats: 4, n: 1, movable: true }), { id: 101 }, "1 fits where it is");
  assert.deepEqual(placeParty(sibs, { partyOn: 101, partySeats: 4, n: 2, movable: true }), { id: 102, move: true }, "the party of 4 and the 2 go to departure 2");
  assert.equal(placeParty(sibs, { partyOn: 101, partySeats: 4, n: 2, movable: false }), null, "not movable (already asked to pay): it is not split");
  assert.equal(placeParty([dep(1, 1), dep(2, 5)], { partyOn: 101, partySeats: 4, n: 2, movable: true }), null, "4 + 2 fits nowhere: open the next");
});
